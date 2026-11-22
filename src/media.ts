import { MAX_IMAGE_BYTES, MAX_VIDEO_BYTES } from "./config";
import { runtime } from "./runtime";

const USER_AGENT = "Mozilla/5.0 (compatible; PictorchanBot/3.0; +https://aipictors.com)";

// ──────────────────────────────────────────────────────────
// 安全な fetch（Workers からは社内ネットワークに届かないが、念のためローカル宛ては断る）
// ──────────────────────────────────────────────────────────
function isPrivateHost(host: string): boolean {
  if (/^(localhost|.*\.internal|.*\.local)$/i.test(host)) return true;
  const v4 = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return (
      a === 0 || a === 10 || a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224
    );
  }
  const v6 = host.toLowerCase();
  return v6 === "::" || v6 === "::1" || /^(fc|fd|fe8|fe9|fea|feb|ff)[0-9a-f]*:/.test(v6) || v6.startsWith("::ffff:");
}

function assertPublicUrl(raw: string): URL {
  const url = new URL(raw);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("unsupported protocol");
  if (url.username || url.password) throw new Error("credentials in url");
  if (isPrivateHost(url.hostname.replace(/^\[|\]$/g, ""))) throw new Error("private host");
  return url;
}

export async function safeFetch(rawUrl: string, init: RequestInit = {}, timeoutMs = 20_000): Promise<Response> {
  let current = rawUrl;
  for (let hop = 0; hop < 5; hop++) {
    const url = assertPublicUrl(current);
    const res = await fetch(url, {
      ...init,
      redirect: "manual",
      headers: { "User-Agent": USER_AGENT, "Accept-Language": "ja,en;q=0.8", ...((init.headers as Record<string, string>) ?? {}) },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      await res.body?.cancel();
      current = new URL(res.headers.get("location")!, url).toString();
      continue;
    }
    return res;
  }
  throw new Error("too many redirects");
}

export async function readLimited(res: Response, maxBytes: number): Promise<Buffer> {
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > maxBytes) {
    await res.body?.cancel();
    throw new Error(`too large (${declared} bytes)`);
  }
  if (!res.body) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error("too large");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

function sniffImageMime(buf: Uint8Array): string | null {
  if (buf.length < 12) return null;
  const ascii = (from: number, to: number) => String.fromCharCode(...buf.subarray(from, to));
  if (buf[0] === 0xff && buf[1] === 0xd8) return "image/jpeg";
  if (buf[0] === 0x89 && ascii(1, 4) === "PNG") return "image/png";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  if (ascii(0, 3) === "GIF") return "image/gif";
  if (ascii(4, 12).startsWith("ftypavi")) return "image/avif";
  return null;
}

const toDataUri = (mime: string, bytes: Uint8Array) => `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`;

/**
 * 会話で見せる画像の長辺。xAI は画像の面積で課金する（2048px で約 2,300 トークン、1024px で約 1,000 トークン）
 */
export const CHAT_IMAGE_MAX_SIDE = 1024;

/** Cloudflare Images で長辺 maxSide 以下の jpeg にする */
async function resizeToJpeg(bytes: Uint8Array, maxSide: number): Promise<Uint8Array | null> {
  const images = runtime.env?.IMAGES;
  if (!images) return null;
  try {
    const result = await images
      .input(new Blob([bytes]).stream())
      .transform({ width: maxSide, height: maxSide, fit: "scale-down" })
      .output({ format: "image/jpeg", quality: 85 });
    return new Uint8Array(await result.response().arrayBuffer());
  } catch (error: any) {
    console.warn("[MEDIA] resize failed", error?.message ?? error);
    return null;
  }
}

/** 画像URL → data URI（長辺を maxSide までに縮小して jpeg にする） */
export async function imageUrlToDataUri(url: string, maxSide = CHAT_IMAGE_MAX_SIDE): Promise<string | null> {
  try {
    const res = await safeFetch(url);
    if (!res.ok) {
      await res.body?.cancel();
      return null;
    }
    const buf = await readLimited(res, MAX_IMAGE_BYTES);
    const mime = sniffImageMime(buf);
    if (!mime) return null;
    const resized = await resizeToJpeg(buf, maxSide);
    if (resized) return toDataUri("image/jpeg", resized);
    // 縮小できないときは、AI が読める形式ならそのまま見せる
    if ((mime === "image/jpeg" || mime === "image/png") && buf.length <= 5 * 1024 * 1024) return toDataUri(mime, buf);
    return null;
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

// ──────────────────────────────────────────────────────────
// MP4 / MOV の長さ・音声の有無（moov ボックスだけ Range で読む）
// ──────────────────────────────────────────────────────────
async function fetchRange(url: string, start: number, end: number): Promise<{ bytes: Uint8Array; total: number } | null> {
  const res = await safeFetch(url, { headers: { Range: `bytes=${start}-${end}` } }, 30_000);
  if (res.status !== 206) {
    await res.body?.cancel();
    return null;
  }
  const total = Number(res.headers.get("content-range")?.split("/")[1] ?? 0);
  return { bytes: new Uint8Array(await readLimited(res, end - start + 1)), total };
}

type Box = { type: string; start: number; size: number; header: number };

function readBoxes(buf: Uint8Array, from: number, to: number): Box[] {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const boxes: Box[] = [];
  let offset = from;
  while (offset + 8 <= to) {
    let size = view.getUint32(offset);
    const type = String.fromCharCode(...buf.subarray(offset + 4, offset + 8));
    let header = 8;
    if (size === 1) {
      if (offset + 16 > to) break;
      size = Number(view.getBigUint64(offset + 8));
      header = 16;
    } else if (size === 0) {
      size = to - offset;
    }
    if (size < header) break;
    boxes.push({ type, start: offset, size, header });
    offset += size;
  }
  return boxes;
}

type VideoInfo = { durationSec: number; hasAudio: boolean; width?: number; height?: number; size: number };

function parseMoov(moov: Uint8Array): Omit<VideoInfo, "size"> {
  const view = new DataView(moov.buffer, moov.byteOffset, moov.byteLength);
  let durationSec = 0;
  let hasAudio = false;
  let width: number | undefined;
  let height: number | undefined;
  for (const box of readBoxes(moov, 8, moov.length)) {
    const body = box.start + box.header;
    if (box.type === "mvhd") {
      const version = moov[body];
      const timescale = view.getUint32(body + (version === 1 ? 20 : 12));
      const duration = version === 1 ? Number(view.getBigUint64(body + 24)) : view.getUint32(body + 16);
      if (timescale) durationSec = duration / timescale;
    }
    if (box.type !== "trak") continue;
    let handler = "";
    let trackSize: [number, number] | null = null;
    for (const child of readBoxes(moov, body, box.start + box.size)) {
      const childBody = child.start + child.header;
      if (child.type === "tkhd") {
        const end = child.start + child.size;
        trackSize = [view.getUint32(end - 8) / 65536, view.getUint32(end - 4) / 65536];
      }
      if (child.type === "mdia") {
        const hdlr = readBoxes(moov, childBody, child.start + child.size).find((b) => b.type === "hdlr");
        if (hdlr) handler = String.fromCharCode(...moov.subarray(hdlr.start + hdlr.header + 8, hdlr.start + hdlr.header + 12));
      }
    }
    if (handler === "soun") hasAudio = true;
    if (handler === "vide" && trackSize && trackSize[0] > 0) [width, height] = trackSize.map(Math.round);
  }
  return { durationSec, hasAudio, width, height };
}

async function readVideoInfo(url: string): Promise<VideoInfo | null> {
  const head = await fetchRange(url, 0, 65_535);
  if (!head) return null;
  let offset = 0;
  let chunk = head.bytes;
  let chunkStart = 0;
  for (let i = 0; i < 20 && offset < head.total; i++) {
    if (offset + 16 > chunkStart + chunk.length) {
      const next = await fetchRange(url, offset, Math.min(head.total - 1, offset + 65_535));
      if (!next) return null;
      chunk = next.bytes;
      chunkStart = offset;
    }
    const [box] = readBoxes(chunk, offset - chunkStart, chunk.length);
    if (!box) return null;
    if (i === 0 && box.type !== "ftyp") return null; // MP4 / MOV 以外
    if (box.type === "moov") {
      if (box.size > 16 * 1024 * 1024) return null;
      const moov =
        offset + box.size <= chunkStart + chunk.length
          ? chunk.subarray(offset - chunkStart, offset - chunkStart + box.size)
          : (await fetchRange(url, offset, offset + box.size - 1))?.bytes;
      if (!moov) return null;
      return { ...parseMoov(moov), size: head.total };
    }
    offset += box.size;
  }
  return null;
}

/** 動画の指定秒のコマ（Cloudflare Media Transformations） */
async function extractFrame(url: string, time: number): Promise<string | null> {
  const media = runtime.env?.MEDIA;
  if (!media) return null;
  try {
    const res = await safeFetch(url, {}, 60_000);
    if (!res.ok || !res.body) {
      await res.body?.cancel();
      return null;
    }
    const output = await media
      .input(res.body)
      .transform({ width: 512 })
      .output({ mode: "frame", time: `${Math.max(0, time).toFixed(1)}s`, format: "jpg" })
      .response();
    if (!output.ok) {
      await output.body?.cancel();
      return null;
    }
    const bytes = new Uint8Array(await output.arrayBuffer());
    return sniffImageMime(bytes) ? toDataUri("image/jpeg", bytes) : null;
  } catch (error: any) {
    console.warn("[MEDIA] frame failed", time, error?.message ?? error);
    return null;
  }
}

/** 動画URL → 等間隔に切り出した数フレーム（512px幅、時刻つき） */
export async function digestVideo(url: string, frameCount = 6): Promise<VideoDigest | null> {
  try {
    const info = await readVideoInfo(url).catch(() => null);
    if (info && info.size > MAX_VIDEO_BYTES) return null;
    const durationSec = info?.durationSec ?? 0;
    const count = durationSec > 0 && durationSec < 3 ? 3 : frameCount;
    // 長さが分からない形式（WebM など）は最初の方を何か所か見る
    const frameTimes =
      durationSec > 0
        ? Array.from({ length: count }, (_, i) => Math.max(0, Math.min(durationSec - 0.1, ((i + 0.5) * durationSec) / count)))
        : [0.5, 1.5, 3, 5, 8, 12].slice(0, count);

    const frames: Array<{ time: number; dataUri: string }> = [];
    // 同時に開ける接続は 6 本までなので 3 本ずつ
    for (let i = 0; i < frameTimes.length; i += 3) {
      const batch = frameTimes.slice(i, i + 3);
      const results = await Promise.all(batch.map((t) => extractFrame(url, t)));
      results.forEach((dataUri, j) => dataUri && frames.push({ time: batch[j], dataUri }));
    }
    if (frames.length === 0) return null;
    return { frames, durationSec, hasAudio: info?.hasAudio ?? false, width: info?.width, height: info?.height };
  } catch (error: any) {
    console.warn("[MEDIA] video digest failed", url.slice(0, 120), error?.message ?? error);
    return null;
  }
}

export function isImageAttachment(att: { content_type?: string | null; filename?: string | null }): boolean {
  return /^image\//.test(att.content_type ?? "") || /\.(png|jpe?g|gif|webp|avif)$/i.test(att.filename ?? "");
}

export function isVideoAttachment(att: { content_type?: string | null; filename?: string | null }): boolean {
  return /^video\//.test(att.content_type ?? "") || /\.(mp4|mov|webm|mkv|m4v)$/i.test(att.filename ?? "");
}

export function formatSeconds(sec: number): string {
  if (!sec) return "不明";
  const s = Math.round(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
