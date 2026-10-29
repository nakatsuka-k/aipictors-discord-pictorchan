import fs from "node:fs";
import path from "node:path";

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

export function toJapanDate(d: Date | number = new Date()): Date {
  const base = typeof d === "number" ? new Date(d) : d;
  return new Date(base.toLocaleString("en-US", { timeZone: "Asia/Tokyo" }));
}

export function getJapanNow(): Date {
  return toJapanDate(new Date());
}

export function getJapanTimeFromTimestamp(timestamp: number): string {
  const t = toJapanDate(timestamp);
  const hh = String(t.getHours()).padStart(2, "0");
  const mm = String(t.getMinutes()).padStart(2, "0");
  const ss = String(t.getSeconds()).padStart(2, "0");
  return `${t.getFullYear()}年${t.getMonth() + 1}月${t.getDate()}日（${WEEKDAYS[t.getDay()]}）${hh}:${mm}:${ss}`;
}

export function getJapanTime(): string {
  return getJapanTimeFromTimestamp(Date.now());
}

/** プロンプト用の短い時刻表記: 10/27(月) 14:05 */
export function shortJapanTime(timestamp: number): string {
  const t = toJapanDate(timestamp);
  const hh = String(t.getHours()).padStart(2, "0");
  const mm = String(t.getMinutes()).padStart(2, "0");
  return `${t.getMonth() + 1}/${t.getDate()}(${WEEKDAYS[t.getDay()]}) ${hh}:${mm}`;
}

export function japanDateKey(d: Date | number = new Date()): string {
  const t = toJapanDate(d);
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
}

export function japanDateTitle(d: Date = new Date()): string {
  return japanDateKey(d).replace(/-/g, ".");
}

export function sampleEvenly<T>(items: T[], limit: number): T[] {
  if (items.length <= limit) return items;
  const result: T[] = [];
  const lastIndex = items.length - 1;
  for (let i = 0; i < limit; i++) {
    result.push(items[Math.round((i * lastIndex) / Math.max(1, limit - 1))]);
  }
  return result;
}

export function splitForDiscord(content: string, maxLength = 1900): string[] {
  const text = (content ?? "").trim();
  if (!text) return [];
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let current = "";
  for (const line of text.split("\n")) {
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length <= maxLength) {
      current = candidate;
      continue;
    }
    if (current) chunks.push(current);
    if (line.length <= maxLength) {
      current = line;
      continue;
    }
    for (let i = 0; i < line.length; i += maxLength) chunks.push(line.slice(i, i + maxLength));
    current = "";
  }
  if (current) chunks.push(current);
  return chunks;
}

export function truncate(text: string, max: number): string {
  const value = text ?? "";
  if (value.length <= max) return value;
  let end = max - 1;
  // 絵文字など（サロゲートペア）を半分で切らない。半分だけ残ると xAI が JSON を読めず 400 になる
  const code = value.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return `${value.slice(0, end)}…`;
}

/** 対になっていないサロゲート（壊れた絵文字の片割れ）を取り除く */
export function toWellFormed(text: string): string {
  return text.replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, "");
}

/** API に送る JSON。文字列の壊れた絵文字は取り除く（xAI は片割れのサロゲートを含む JSON を 400 で弾く） */
export function toRequestJson(value: unknown): string {
  return JSON.stringify(value, (_key, v) => (typeof v === "string" ? toWellFormed(v) : v));
}

export function oneLine(text: string): string {
  return (text ?? "").replace(/\s+/g, " ").trim();
}

export function readJson<T>(filePath: string, fallback: T): T {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
  } catch (error) {
    console.error(`[JSON] read error ${filePath}`, error);
    return fallback;
  }
}

/** 一時ファイルに書いてから rename（書き込み途中で落ちても壊れない） */
export function writeJsonAtomic(filePath: string, data: unknown) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, filePath);
  } catch (error) {
    console.error(`[JSON] write error ${filePath}`, error);
  }
}

const pendingFlushes = new Set<() => void>();

/** 保存をまとめて遅延実行する。メッセージごとの巨大JSON書き込みを避けるため */
export function debounced(fn: () => void, delayMs = 10_000): () => void {
  let timer: NodeJS.Timeout | null = null;
  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    pendingFlushes.delete(flush);
    fn();
  };
  return () => {
    if (timer) return;
    pendingFlushes.add(flush);
    timer = setTimeout(flush, delayMs);
  };
}

export function flushAllPending() {
  for (const flush of Array.from(pendingFlushes)) flush();
}

export function chooseRandom<T>(items: T[]): T {
  return items[Math.floor(Math.random() * items.length)] ?? items[0];
}
