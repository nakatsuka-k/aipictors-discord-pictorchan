// ぴくたーちゃん本体は Durable Object「Bot」（Gateway の WebSocket を外向きに張る。src/gateway.ts）。
// Runner は前の Cloudflare Containers 版（戻すとき用に残している。/__admin/start で起動）
import { DurableObject } from "cloudflare:workers"
import { announceUpdateIfNeeded, dispatch, registerCommands, runSchedules } from "../src/bot"
import { Gateway } from "../src/gateway"
import { setRuntime } from "../src/runtime"
import { loadState, settleWrites } from "../src/state"
import { initStores } from "../src/store"
import { flushAllPending } from "../src/util"

const INACTIVITY_TIMEOUT_MS = 60 * 60 * 1000
const SIGTERM = 15

type Env = Record<string, any> & {
  RUNNER: DurableObjectNamespace<Runner>
  BOT: DurableObjectNamespace<Bot>
  IMAGES?: ImagesBinding
  MEDIA?: any
  ADMIN_TOKEN: string
  CONTAINER_ENV_KEYS: string
  CONTAINER_INSTANCE: string
  CONTAINER_PORT?: string
  STATE?: R2Bucket
}

export class Runner extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    const container = ctx.container
    if (container?.running) {
      ctx.blockConcurrencyWhile(() => container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS))
    }
  }

  private containerEnv() {
    const out: Record<string, string> = {}
    for (const key of this.env.CONTAINER_ENV_KEYS.split(",")) {
      const value = this.env[key.trim()]
      if (typeof value === "string") out[key.trim()] = value
    }
    return out
  }

  async ensure() {
    const container = this.ctx.container!
    const storage = this.ctx.storage
    if (!(await storage.get("enabled"))) return this.status()

    const image = container.images.base
    if (container.running) {
      if ((await storage.get("image")) !== image && !(await storage.get("replacing"))) {
        // 新しいイメージへの入れ替え。SIGTERM で生成中の処理を待ってから終わる
        await storage.put("replacing", Date.now())
        container.signal(SIGTERM)
        return this.status()
      }
      await container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS)
      return this.status()
    }

    container.start({
      image,
      enableInternet: true,
      env: this.containerEnv(),
      instance: this.env.CONTAINER_INSTANCE as any,
    })
    await storage.put("image", image)
    await storage.delete("replacing")
    await storage.put("startedAt", Date.now())
    await storage.put("starts", ((await storage.get<number>("starts")) ?? 0) + 1)
    await container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS)
    return this.status()
  }

  async start() {
    await this.ctx.storage.put("enabled", true)
    return this.ensure()
  }

  async stop() {
    await this.ctx.storage.put("enabled", false)
    if (this.ctx.container!.running) this.ctx.container!.signal(SIGTERM)
    return this.status()
  }

  async status() {
    const storage = this.ctx.storage
    return {
      enabled: (await storage.get("enabled")) ?? false,
      running: this.ctx.container!.running,
      startedAt: (await storage.get("startedAt")) ?? null,
      starts: (await storage.get("starts")) ?? 0,
    }
  }

  async proxy(request: Request): Promise<Response> {
    await this.ensure()
    const port = Number(this.env.CONTAINER_PORT)
    const body = request.body ? await request.arrayBuffer() : undefined
    const url = new URL(request.url)
    let lastError: unknown
    for (let i = 0; i < 40; i++) {
      try {
        return await this.ctx.container!.getTcpPort(port).fetch(
          new Request(`http://container${url.pathname}${url.search}`, {
            method: request.method,
            headers: request.headers,
            body,
          }),
        )
      } catch (error) {
        lastError = error
        await new Promise((resolve) => setTimeout(resolve, 500))
      }
    }
    return new Response(`container unavailable: ${String(lastError)}`, { status: 503 })
  }
}

const WATCHDOG_MS = 30_000

export class Bot extends DurableObject<Env> {
  private gateway: Gateway
  private loading: Promise<void> | null = null
  private loaded = false
  private announced = false

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    setRuntime({ STATE: env.STATE!, IMAGES: env.IMAGES, MEDIA: env.MEDIA })
    this.gateway = new Gateway(ctx.storage, (type, data) => this.onDispatch(type, data))
  }

  private onDispatch(type: string, data: any) {
    const result = dispatch(type, data)
    if (result) this.ctx.waitUntil(Promise.resolve(result).catch((error) => console.error(`[BOT] ${type}`, error)))
    if (type === "READY") this.ctx.waitUntil(this.afterReady())
  }

  private async afterReady() {
    await registerCommands(this.ctx.storage)
    // 告知は起動ごとに 1 回だけ確認（announce_state.json で重複は防いでいる）
    if (!this.announced) {
      this.announced = true
      await announceUpdateIfNeeded().catch((error) => console.error("[ANNOUNCE] error", error))
      await runSchedules(new Date(0)).catch(() => {})
    }
  }

  /** R2 の記憶を読み込む。読めないまま動くと記憶を上書きするので、成功するまで繋がない */
  private async load() {
    if (this.loaded) return
    this.loading ??= (async () => {
      await loadState(this.env.STATE!)
      initStores()
      this.loaded = true
    })().finally(() => {
      this.loading = null
    })
    await this.loading
  }

  async ensure() {
    if (!(await this.ctx.storage.get("enabled"))) return this.status()
    await this.load()
    await this.gateway.ensure()
    const alarm = await this.ctx.storage.getAlarm()
    if (!alarm || alarm < Date.now()) await this.ctx.storage.setAlarm(Date.now() + WATCHDOG_MS)
    return this.status()
  }

  async alarm() {
    if (!(await this.ctx.storage.get("enabled"))) return
    await this.ctx.storage.setAlarm(Date.now() + WATCHDOG_MS)
    await this.ensure()
  }

  /** 毎分の cron */
  async tick() {
    const status = await this.ensure()
    if (this.loaded && this.gateway.open) this.ctx.waitUntil(runSchedules())
    return status
  }

  async start() {
    await this.ctx.storage.put("enabled", true)
    return this.ensure()
  }

  async stop() {
    await this.ctx.storage.put("enabled", false)
    await this.ctx.storage.deleteAlarm()
    await this.gateway.stop()
    // 書きかけの記憶を R2 に送ってから止める（Container 版に戻すときに引き継げるように）
    flushAllPending()
    await settleWrites()
    return this.status()
  }

  async status() {
    return {
      enabled: (await this.ctx.storage.get("enabled")) ?? false,
      loaded: this.loaded,
      gateway: this.gateway.status(),
    }
  }
}

const bot = (env: Env) => env.BOT.get(env.BOT.idFromName("main"), { locationHint: "apac" })

const runner = (env: Env) => env.RUNNER.get(env.RUNNER.idFromName("main"), { locationHint: "apac" })

// ADMIN_TOKEN は Container 版の記憶の同期にも使う。BOT_ADMIN_TOKEN は管理用（どちらでも通す）
const authorized = (request: Request, env: Env) => {
  const header = request.headers.get("authorization")
  return [env.ADMIN_TOKEN, env.BOT_ADMIN_TOKEN].some((token) => typeof token === "string" && token && header === `Bearer ${token}`)
}

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url)

    if (url.pathname.startsWith("/__admin/")) {
      if (!authorized(request, env)) return new Response("unauthorized", { status: 401 })
      // /__admin/bot/* は Worker 版、/__admin/* は前の Container 版
      if (url.pathname === "/__admin/bot/start") return Response.json(await bot(env).start())
      if (url.pathname === "/__admin/bot/stop") return Response.json(await bot(env).stop())
      if (url.pathname === "/__admin/bot/status") return Response.json(await bot(env).status())
      const stub = runner(env)
      if (url.pathname === "/__admin/start") return Response.json(await stub.start())
      if (url.pathname === "/__admin/stop") return Response.json(await stub.stop())
      if (url.pathname === "/__admin/status") return Response.json(await stub.status())
      return new Response("not found", { status: 404 })
    }

    if (url.pathname.startsWith("/__state") && env.STATE) {
      if (!authorized(request, env)) return new Response("unauthorized", { status: 401 })
      const name = url.pathname.slice("/__state/".length)
      if (!name) {
        const listed = await env.STATE.list()
        return Response.json(listed.objects.map((o) => o.key))
      }
      if (request.method === "PUT") {
        await env.STATE.put(name, request.body)
        return new Response("ok")
      }
      const object = await env.STATE.get(name)
      return object ? new Response(object.body) : new Response("not found", { status: 404 })
    }

    if (env.CONTAINER_PORT) return runner(env).proxy(request)
    return new Response("ok")
  },

  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(bot(env).tick())
    // Container 版は enabled のときだけ起動する（普段は止めてある）
    ctx.waitUntil(runner(env).ensure())
  },
}
