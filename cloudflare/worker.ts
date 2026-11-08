// Fly の常駐プロセスを Cloudflare Containers で 1 台だけ動かす Worker
import { DurableObject } from "cloudflare:workers"

const INACTIVITY_TIMEOUT_MS = 60 * 60 * 1000
const SIGTERM = 15

type Env = Record<string, any> & {
  RUNNER: DurableObjectNamespace<Runner>
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
      instance: this.env.CONTAINER_INSTANCE,
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

const runner = (env: Env) => env.RUNNER.get(env.RUNNER.idFromName("main"), { locationHint: "apac" })

const authorized = (request: Request, env: Env) =>
  request.headers.get("authorization") === `Bearer ${env.ADMIN_TOKEN}`

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url)

    if (url.pathname.startsWith("/__admin/")) {
      if (!authorized(request, env)) return new Response("unauthorized", { status: 401 })
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
    ctx.waitUntil(runner(env).ensure())
  },
}
