import { execFile } from "node:child_process";
import dns from "node:dns/promises";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { MAX_IMAGE_BYTES, MAX_VIDEO_BYTES } from "./config";

const FFMPEG = process.env.FFMPEG_PATH ?? "ffmpeg";
const USER_AGENT = "Mozilla/5.0 (compatible; PictorchanBot/2.0; +https://aipictors.com)";

// ──────────────────────────────────────────────────────────
// 安全な fetch（社内ネットワーク・ループバックへのアクセスを防ぐ）
// ──────────────────────────────────────────────────────────
function isPrivateAddress(address: string): boolean {
  if (net.isIPv4(address)) {
    const [a, b] = address.split(".").map(Number);
    return (
      a === 0 || a === 10 || a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224
    );
  }
  const v = address.toLowerCase();
  if (v === "::" || v === "::1") return true;
  if (v.startsWith("::ffff:")) return isPrivateAddress(v.slice(7));
  return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(v);
}

async function assertPublicUrl(raw: string): Promise<URL> {
  const url = new URL(raw);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("unsupported protocol");
  if (url.username || url.password) throw new Error("credentials in url");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (/^(localhost|.*\.internal|.*\.local)$/i.test(host)) throw new Error("private host");
  const addresses = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true })).map((r) => r.address);
  if (addresses.length === 0 || addresses.some(isPrivateAddress)) throw new Error("private address");
  return url;
}

export async function safeFetch(rawUrl: string, init: RequestInit = {}, timeoutMs = 20_000): Promise<Response> {
  let current = rawUrl;
  for (let hop = 0; hop < 5; hop++) {
    const url = await assertPublicUrl(current);
    const res = await fetch(url, {
      ...init,
      redirect: "manual",
      headers: { "User-Agent": USER_AGENT, "Accept-Language": "ja,en;q=0.8", ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      current = new URL(res.headers.get("location")!, url).toString();
      continue;
    }
    return res;
  }
  throw new Error("too many redirects");
}

export async function readLimited(res: Response, maxBytes: number): Promise<Buffer> {
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > maxBytes) throw new Error(`too large (${declared} bytes)`);
  if (!res.body) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of res.body as any as AsyncIterable<Uint8Array>) {
    total += chunk.byteLength;
    if (total > maxBytes) throw new Error("too large");
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

// ──────────────────────────────────────────────────────────
// ffmpeg
// ──────────────────────────────────────────────────────────
function runFfmpeg(args: string[], timeoutMs = 60_000): Promise<{ stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(FFMPEG, ["-hide_banner", "-nostdin", ...args], { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (error, _stdout, stderr) => {
      if (error && !/Duration:/.test(stderr ?? "")) reject(Object.assign(error, { stderr }));
      else resolve({ stderr: stderr ?? "" });
    });
  });
}

function sniffImageMime(buf: Buffer): string | null {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8) return "image/jpeg";
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buf.subarray(0, 4).toString() === "RIFF" && buf.subarray(8, 12).toString() === "WEBP") return "image/webp";
  if (buf.subarray(0, 3).toString() === "GIF") return "image/gif";
  if (buf.subarray(4, 12).toString().startsWith("ftypavi")) return "image/avif";
  return null;
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pictor-"));
  try {
    return await fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** 画像URL → data URI（png/jpeg 以外は jpeg に変換、大きすぎる画像は縮小） */
export async function imageUrlToDataUri(url: string): Promise<string | null> {
  try {
    const res = await safeFetch(url);
    if (!res.ok) return null;
    const buf = await readLimited(res, MAX_IMAGE_BYTES);
    const mime = sniffImageMime(buf);
    if (!mime) return null;
    if ((mime === "image/png" || mime === "image/jpeg") && buf.byteLength <= 4 * 1024 * 1024) {
      return `data:${mime};base64,${buf.toString("base64")}`;
    }
    return await withTempDir(async (dir) => {
      const input = path.join(dir, "in");
      const output = path.join(dir, "out.jpg");
      fs.writeFileSync(input, buf);
      await runFfmpeg(["-i", input, "-frames:v", "1", "-vf", "scale='min(2048,iw)':-2", "-q:v", "3", "-y", output]);
      return `data:image/jpeg;base64,${fs.readFileSync(output).toString("base64")}`;
    });
  } catch (error: any) {
    console.warn("[MEDIA] image fetch failed", url.slice(0, 120), error?.message ?? error);
    return null;
  }
}

export type VideoDigest = {
  frames: Array<{ time: number; dataUri: string }>;
  durationSec: number;
  hasAudio: boolean;
  width?: number;
  height?: number;
};

/** 動画URL → 等間隔に切り出した数フレーム（512px幅、時刻つき） */
export async function digestVideo(url: string, frameCount = 6): Promise<VideoDigest | null> {
  try {
    return await withTempDir(async (dir) => {
      const input = path.join(dir, "video");
      const res = await safeFetch(url, {}, 60_000);
      if (!res.ok || !res.body) return null;
      const declared = Number(res.headers.get("content-length") ?? 0);
      if (declared > MAX_VIDEO_BYTES) return null;
      let total = 0;
      const limited = Readable.fromWeb(res.body as any).on("data", (chunk: Buffer) => {
        total += chunk.length;
        if (total > MAX_VIDEO_BYTES) limited.destroy(new Error("video too large"));
      });
      await pipeline(limited, fs.createWriteStream(input));

      const { stderr } = await runFfmpeg(["-i", input], 30_000).catch((e) => ({ stderr: String(e.stderr ?? "") }));
      const d = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
      const durationSec = d ? Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]) : 0;
      const size = stderr.match(/Video:.*?(\d{2,5})x(\d{2,5})/);
      const hasAudio = /Audio:/.test(stderr);
      if (!/Video:/.test(stderr)) return null;

      const count = durationSec > 0 && durationSec < 3 ? 3 : frameCount;
      const frameTimes = Array.from({ length: count }, (_, i) =>
        durationSec > 0 ? Math.max(0, Math.min(durationSec - 0.1, ((i + 0.5) * durationSec) / count)) : i,
      );

      await Promise.all(
        frameTimes.map((t, i) =>
          runFfmpeg(["-ss", t.toFixed(2), "-i", input, "-frames:v", "1", "-vf", "scale=512:-2", "-q:v", "4", "-y", path.join(dir, `f${i}.jpg`)], 30_000),
        ),
      );
      const extracted = frameTimes
        .map((time, i) => ({ time, file: path.join(dir, `f${i}.jpg`) }))
        .filter((f) => fs.existsSync(f.file));
      if (extracted.length === 0) return null;

      return {
        frames: extracted.map((f) => ({ time: f.time, dataUri: `data:image/jpeg;base64,${fs.readFileSync(f.file).toString("base64")}` })),
        durationSec,
        hasAudio,
        width: size ? Number(size[1]) : undefined,
        height: size ? Number(size[2]) : undefined,
      };
    });
  } catch (error: any) {
    console.warn("[MEDIA] video digest failed", url.slice(0, 120), error?.message ?? error);
    return null;
  }
}

export function isImageAttachment(att: { contentType?: string | null; name?: string | null }): boolean {
  return /^image\//.test(att.contentType ?? "") || /\.(png|jpe?g|gif|webp|avif)$/i.test(att.name ?? "");
}

export function isVideoAttachment(att: { contentType?: string | null; name?: string | null }): boolean {
  return /^video\//.test(att.contentType ?? "") || /\.(mp4|mov|webm|mkv|m4v)$/i.test(att.name ?? "");
}

export function formatSeconds(sec: number): string {
  const s = Math.round(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
