// Containers のディスクは消えるので、/data の JSON を R2 と同期しながらボットを動かす
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"

const DIR = process.env.DATA_DIR ?? "/data"
const BASE = process.env.STATE_URL
const TOKEN = process.env.ADMIN_TOKEN
const SYNC_MS = 30_000
const headers = { authorization: `Bearer ${TOKEN}` }
const hashes = new Map()
const hash = (buf) => createHash("sha256").update(buf).digest("hex")
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function restore() {
  // 取得に失敗したまま空で起動すると R2 の記憶を上書きしてしまうので、成功するまで起動しない
  for (let attempt = 1; ; attempt++) {
    try {
      const list = await fetch(`${BASE}/__state`, { headers })
      if (!list.ok) throw new Error(`list ${list.status}`)
      const names = await list.json()
      for (const name of names) {
        const res = await fetch(`${BASE}/__state/${encodeURIComponent(name)}`, { headers })
        if (!res.ok) throw new Error(`get ${name} ${res.status}`)
        const buf = Buffer.from(await res.arrayBuffer())
        JSON.parse(buf.toString())
        fs.writeFileSync(path.join(DIR, name), buf)
        hashes.set(name, hash(buf))
      }
      console.info(`[supervisor] restored ${names.length} files`)
      return
    } catch (error) {
      console.error(`[supervisor] restore failed (${attempt})`, error)
      if (attempt >= 30) process.exit(1)
      await sleep(5_000)
    }
  }
}

let syncing = Promise.resolve()

async function syncOnce() {
  for (const name of fs.readdirSync(DIR)) {
    if (!name.endsWith(".json")) continue
    const buf = fs.readFileSync(path.join(DIR, name))
    const digest = hash(buf)
    if (hashes.get(name) === digest) continue
    try {
      JSON.parse(buf.toString())
      const res = await fetch(`${BASE}/__state/${encodeURIComponent(name)}`, { method: "PUT", headers, body: buf })
      if (!res.ok) throw new Error(`put ${res.status}`)
      hashes.set(name, digest)
    } catch (error) {
      console.error(`[supervisor] sync failed: ${name}`, error)
    }
  }
}

const sync = () => (syncing = syncing.then(syncOnce, syncOnce))

fs.mkdirSync(DIR, { recursive: true })
await restore()

const child = spawn("node", ["dist/index.js"], { stdio: "inherit" })
const timer = setInterval(sync, SYNC_MS)

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => child.kill(signal))
}

child.on("exit", async (code) => {
  clearInterval(timer)
  await sync()
  console.info(`[supervisor] bot exited (${code})`)
  process.exit(code ?? 1)
})
