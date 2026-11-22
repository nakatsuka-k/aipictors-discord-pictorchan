// Discord Gateway の WebSocket を Durable Object から外向きに張る（heartbeat・resume・再接続を自前で）
import { DISCORD_TOKEN } from "./config";
import { discord } from "./discord";

// Guilds | GuildMembers | GuildEmojisAndStickers | GuildMessages | MessageContent
const INTENTS = (1 << 0) | (1 << 1) | (1 << 3) | (1 << 9) | (1 << 15);
// これらで切れたら繋ぎ直しても無駄（トークン・intent の設定ミス）
const FATAL_CLOSE_CODES = new Set([4004, 4010, 4011, 4012, 4013, 4014]);
// セッションを捨てて IDENTIFY からやり直す
const RESET_CLOSE_CODES = new Set([4007, 4009]);

type Session = { sessionId: string; resumeUrl: string; seq: number | null };

export type GatewayStorage = {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
};

export class Gateway {
  private ws: WebSocket | null = null;
  private session: Session | null = null;
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatIntervalMs = 41_250;
  private awaitingAck = false;
  private connecting: Promise<void> | null = null;
  private failures = 0;
  private stopped = false;
  lastEventAt = 0;
  lastAckAt = 0;
  connectedAt = 0;
  readyAt = 0;
  fatal: string | null = null;

  constructor(
    private storage: GatewayStorage,
    private onDispatch: (type: string, data: any, info: { resumed: boolean }) => void,
  ) {}

  get open() {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  /** 繋がっていて heartbeat が返ってきていれば何もしない。止まっていれば繋ぎ直す */
  async ensure() {
    this.stopped = false;
    if (this.fatal) return;
    const silentFor = Date.now() - Math.max(this.lastAckAt, this.connectedAt);
    if (this.open && silentFor < this.heartbeatIntervalMs * 2 + 15_000) return;
    if (this.ws) {
      console.warn(`[GATEWAY] stale connection (${Math.round(silentFor / 1000)}s), reconnecting`);
      this.drop(4000, "stale");
    }
    await this.connect();
  }

  async connect() {
    if (this.connecting) return this.connecting;
    this.connecting = this.doConnect().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private async doConnect() {
    if (this.stopped || this.fatal) return;
    if (this.failures > 0) {
      const wait = Math.min(60_000, 1000 * 2 ** Math.min(this.failures, 6));
      await new Promise((resolve) => setTimeout(resolve, wait));
      if (this.stopped) return;
    }
    this.session ??= (await this.storage.get<Session>("session")) ?? null;
    let base = this.session?.resumeUrl;
    if (!base) {
      const info = await discord<{ url: string; session_start_limit?: { remaining: number; reset_after: number } }>("GET", "/gateway/bot");
      if (info.session_start_limit && info.session_start_limit.remaining < 5) {
        console.error(`[GATEWAY] session start limit almost used, waiting ${info.session_start_limit.reset_after}ms`);
        this.failures++;
        return;
      }
      base = info.url;
    }
    const url = `${base.replace(/^wss:/, "https:").replace(/\/$/, "")}/?v=10&encoding=json`;
    try {
      const res = await fetch(url, { headers: { Upgrade: "websocket" } });
      const ws = res.webSocket;
      if (!ws) throw new Error(`upgrade failed: ${res.status}`);
      ws.accept();
      this.ws = ws;
      this.connectedAt = Date.now();
      this.awaitingAck = false;
      ws.addEventListener("message", (event) => this.onMessage(ws, event));
      ws.addEventListener("close", (event) => this.onClose(ws, event.code, event.reason));
      ws.addEventListener("error", (event) => console.error("[GATEWAY] socket error", (event as any)?.message ?? event));
      console.log(`[GATEWAY] connected (${this.session ? "resume" : "identify"})`);
    } catch (error) {
      console.error("[GATEWAY] connect failed", error);
      this.failures++;
      // 繋ぎ直し先が悪いかもしれないので、次は新しい URL で
      if (this.failures >= 3) await this.resetSession();
      setTimeout(() => this.connect().catch(() => {}), 1000);
    }
  }

  private send(ws: WebSocket, payload: unknown) {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
  }

  private onMessage(ws: WebSocket, event: MessageEvent) {
    if (ws !== this.ws) return;
    let packet: { op: number; d: any; s: number | null; t: string | null };
    try {
      packet = JSON.parse(typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data as ArrayBuffer));
    } catch {
      return;
    }
    this.lastEventAt = Date.now();
    switch (packet.op) {
      case 10: // HELLO
        this.heartbeatIntervalMs = packet.d.heartbeat_interval;
        this.startHeartbeat(ws);
        if (this.session) {
          this.send(ws, { op: 6, d: { token: DISCORD_TOKEN, session_id: this.session.sessionId, seq: this.session.seq } });
        } else {
          this.send(ws, {
            op: 2,
            d: {
              token: DISCORD_TOKEN,
              intents: INTENTS,
              large_threshold: 50,
              properties: { os: "linux", browser: "pictorchan", device: "pictorchan" },
            },
          });
        }
        return;
      case 11: // HEARTBEAT ACK
        this.awaitingAck = false;
        this.lastAckAt = Date.now();
        return;
      case 1: // サーバーからの heartbeat 要求
        this.send(ws, { op: 1, d: this.session?.seq ?? null });
        return;
      case 7: // RECONNECT
        console.log("[GATEWAY] reconnect requested");
        this.drop(4000, "reconnect requested");
        this.connect().catch(() => {});
        return;
      case 9: // INVALID SESSION
        console.warn(`[GATEWAY] invalid session (resumable=${packet.d})`);
        this.drop(4000, "invalid session");
        (packet.d ? Promise.resolve() : this.resetSession())
          .then(() => new Promise((resolve) => setTimeout(resolve, 1000 + Math.random() * 4000)))
          .then(() => this.connect())
          .catch(() => {});
        return;
      case 0: {
        if (packet.s !== null && this.session) {
          this.session.seq = packet.s;
          // 再起動しても続きから受け取れるよう、毎回保存する（保存はまとめて書かれる）
          this.storage.put("session", this.session).catch(() => {});
        }
        if (packet.t === "READY") {
          this.session = { sessionId: packet.d.session_id, resumeUrl: packet.d.resume_gateway_url, seq: packet.s };
          this.storage.put("session", this.session).catch(() => {});
          this.failures = 0;
          this.readyAt = Date.now();
          console.log(`[GATEWAY] ready as ${packet.d.user?.username} (${packet.d.guilds?.length ?? 0} guilds)`);
        }
        if (packet.t === "RESUMED") {
          this.failures = 0;
          console.log("[GATEWAY] resumed");
        }
        if (packet.t) {
          try {
            this.onDispatch(packet.t, packet.d, { resumed: packet.t === "RESUMED" });
          } catch (error) {
            console.error(`[GATEWAY] dispatch ${packet.t} failed`, error);
          }
        }
        return;
      }
    }
  }

  private startHeartbeat(ws: WebSocket) {
    if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer);
    const beat = () => {
      if (ws !== this.ws) return;
      if (this.awaitingAck) {
        // 前回の heartbeat に返事が無い = 死んだ接続
        console.warn("[GATEWAY] heartbeat not acknowledged, reconnecting");
        this.drop(4000, "zombie");
        this.connect().catch(() => {});
        return;
      }
      this.awaitingAck = true;
      this.send(ws, { op: 1, d: this.session?.seq ?? null });
      this.heartbeatTimer = setTimeout(beat, this.heartbeatIntervalMs);
    };
    this.heartbeatTimer = setTimeout(beat, this.heartbeatIntervalMs * Math.random());
  }

  private onClose(ws: WebSocket, code: number, reason: string) {
    if (ws !== this.ws) return;
    this.ws = null;
    if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer);
    console.warn(`[GATEWAY] closed ${code} ${reason}`);
    if (this.stopped) return;
    if (FATAL_CLOSE_CODES.has(code)) {
      this.fatal = `closed ${code} ${reason}`;
      console.error(`[GATEWAY] fatal close ${code}, not reconnecting`);
      return;
    }
    const reset = RESET_CLOSE_CODES.has(code) ? this.resetSession() : Promise.resolve();
    this.failures++;
    reset.then(() => this.connect()).catch(() => {});
  }

  /** 今の接続を閉じる（1000/1001 で閉じると Discord がセッションを捨てるので、続きから繋ぐときは 4000） */
  private drop(code: number, reason: string) {
    const ws = this.ws;
    this.ws = null;
    if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer);
    try {
      ws?.close(code, reason);
    } catch {
      /* ignore */
    }
  }

  private async resetSession() {
    this.session = null;
    await this.storage.delete("session");
  }

  /** 完全に止める（セッションも捨てる） */
  async stop() {
    this.stopped = true;
    this.drop(1000, "stopped");
    await this.resetSession();
  }

  status() {
    return {
      open: this.open,
      connectedAt: this.connectedAt || null,
      readyAt: this.readyAt || null,
      lastEventAt: this.lastEventAt || null,
      lastAckAt: this.lastAckAt || null,
      seq: this.session?.seq ?? null,
      failures: this.failures,
      fatal: this.fatal,
    };
  }
}
