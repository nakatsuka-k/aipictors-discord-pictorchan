import * as cheerio from "cheerio";
import { digestVideo, formatSeconds, imageUrlToDataUri, readLimited, safeFetch } from "./media";
import { truncate } from "./util";

export type UrlReadResult = {
  text: string;
  /** モデルに直接見せる画像（data URI または公開URL） */
  images: string[];
  /** 本文中で見つかったが未取得のメディアURL（必要ならview_mediaで見る） */
  mediaUrls: string[];
};

const cache = new Map<string, { at: number; value: UrlReadResult }>();
const CACHE_TTL_MS = 30 * 60 * 1000;

export async function readUrl(url: string, options: { withMedia?: boolean } = {}): Promise<UrlReadResult> {
  const key = `${options.withMedia ? 1 : 0}:${url}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

  let value: UrlReadResult;
  try {
    value =
      (await readYouTube(url, options)) ??
      (await readTweet(url, options)) ??
      (await readGeneric(url, options));
  } catch (error: any) {
    value = { text: `読み込めなかったよ: ${error?.message ?? error}`, images: [], mediaUrls: [] };
  }

  cache.set(key, { at: Date.now(), value });
  if (cache.size > 100) cache.delete(cache.keys().next().value!);
  return value;
}

// ──────────────────────────────────────────────────────────
// YouTube: メタデータ + ストーリーボード（動画全体のサムネ一覧）で中身を把握
// ──────────────────────────────────────────────────────────
function youTubeId(url: string): string | null {
  const m = url.match(/(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|live\/|embed\/)|youtu\.be\/)([\w-]{11})/i);
  return m?.[1] ?? null;
}

function pickStoryboardSheets(spec: string, maxSheets = 2): string[] {
  // spec: base|w#h#count#cols#rows#interval#name#sigh|...
  const [base, ...levels] = spec.split("|");
  if (!base || levels.length === 0) return [];
  const levelIndex = levels.length - 1; // 最も高解像度のレベル
  const [w, h, count, cols, rows, , name, sigh] = levels[levelIndex].split("#");
  const perSheet = Number(cols) * Number(rows);
  const sheetCount = Math.max(1, Math.ceil(Number(count) / perSheet));
  if (!Number(w) || !Number(h) || !perSheet) return [];
  const picks = sheetCount <= maxSheets
    ? Array.from({ length: sheetCount }, (_, i) => i)
    : Array.from({ length: maxSheets }, (_, i) => Math.round((i * (sheetCount - 1)) / Math.max(1, maxSheets - 1)));
  return picks.map((m) =>
    `${base.replace("$L", String(levelIndex)).replace("$N", name.replace("$M", String(m)))}&sigh=${encodeURIComponent(sigh ?? "")}`,
  );
}

async function readYouTube(url: string, options: { withMedia?: boolean }): Promise<UrlReadResult | null> {
  const id = youTubeId(url);
  if (!id) return null;

  const lines: string[] = [`[YouTube動画] https://www.youtube.com/watch?v=${id}`];
  const images: string[] = [];

  try {
    const res = await safeFetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${id}`)}`);
    if (res.ok) {
      const o = (await res.json()) as { title?: string; author_name?: string };
      lines.push(`タイトル: ${o.title ?? "?"}`, `チャンネル: ${o.author_name ?? "?"}`);
    }
  } catch {/* ignore */}

  let storyboardUrls: string[] = [];
  try {
    const res = await safeFetch(`https://www.youtube.com/watch?v=${id}&hl=ja`, { headers: { Cookie: "CONSENT=YES+1" } });
    const html = (await readLimited(res, 3 * 1024 * 1024)).toString("utf8");
    const json = html.match(/ytInitialPlayerResponse\s*=\s*(\{.+?\});(?:var|<\/script>)/s)?.[1];
    if (json) {
      const player = JSON.parse(json);
      const details = player?.videoDetails ?? {};
      const lengthSec = Number(details.lengthSeconds ?? 0);
      if (lengthSec) lines.push(`長さ: ${formatSeconds(lengthSec)}`);
      if (details.viewCount) lines.push(`再生数: ${Number(details.viewCount).toLocaleString("ja-JP")}`);
      if (details.keywords?.length) lines.push(`タグ: ${details.keywords.slice(0, 10).join(", ")}`);
      if (details.shortDescription) lines.push(`概要欄:\n${truncate(details.shortDescription, 1500)}`);
      const spec = player?.storyboards?.playerStoryboardSpecRenderer?.spec;
      if (spec) storyboardUrls = pickStoryboardSheets(spec);
    }
  } catch (error: any) {
    console.warn("[YOUTUBE] page read failed", error?.message ?? error);
  }

  if (options.withMedia !== false) {
    if (storyboardUrls.length > 0) {
      for (const sheet of storyboardUrls) {
        const data = await imageUrlToDataUri(sheet);
        if (data) images.push(data);
      }
      if (images.length > 0) {
        lines.push(`（添付画像は動画全体から等間隔に切り出したコマのタイル${images.length}枚。左上→右下が時間順）`);
      }
    }
    if (images.length === 0) {
      const thumb = await imageUrlToDataUri(`https://i.ytimg.com/vi/${id}/hqdefault.jpg`);
      if (thumb) {
        images.push(thumb);
        lines.push("（添付画像はサムネイル）");
      }
    }
  }

  return { text: lines.join("\n"), images, mediaUrls: [] };
}

// ──────────────────────────────────────────────────────────
// X (Twitter): fxtwitter API で本文・画像・動画を取得
// ──────────────────────────────────────────────────────────
async function readTweet(url: string, options: { withMedia?: boolean }): Promise<UrlReadResult | null> {
  const m = url.match(/(?:twitter|x|fxtwitter|vxtwitter|fixupx)\.com\/([\w]+)\/status(?:es)?\/(\d+)/i);
  if (!m) return null;

  const res = await safeFetch(`https://api.fxtwitter.com/${m[1]}/status/${m[2]}`);
  if (!res.ok) return null;
  const json = (await res.json()) as any;
  const tweet = json?.tweet;
  if (!tweet) return null;

  const lines = [
    `[Xのポスト] ${tweet.author?.name ?? ""} (@${tweet.author?.screen_name ?? m[1]})`,
    `日時: ${tweet.created_at ?? "?"} / いいね ${tweet.likes ?? 0} / RT ${tweet.retweets ?? 0}`,
    `本文: ${tweet.text ?? ""}`,
  ];
  if (tweet.quote) lines.push(`引用元: @${tweet.quote.author?.screen_name}: ${truncate(tweet.quote.text ?? "", 400)}`);

  const images: string[] = [];
  const mediaUrls: string[] = [];
  const photos: string[] = (tweet.media?.photos ?? []).map((p: any) => p.url).filter(Boolean);
  const videos: string[] = (tweet.media?.videos ?? []).map((v: any) => v.url).filter(Boolean);

  if (options.withMedia !== false) {
    for (const photo of photos.slice(0, 3)) {
      const data = await imageUrlToDataUri(photo);
      if (data) images.push(data);
    }
    if (videos[0]) {
      const digest = await digestVideo(videos[0]);
      if (digest) {
        images.push(digest.gridDataUri);
        lines.push(`動画: 長さ${formatSeconds(digest.durationSec)}（添付は等間隔に切り出したコマのタイル、左上→右下が時間順）`);
      }
    }
  } else {
    mediaUrls.push(...photos, ...videos);
  }
  if (photos.length) lines.push(`画像${photos.length}枚`);

  return { text: lines.join("\n"), images, mediaUrls };
}

// ──────────────────────────────────────────────────────────
// 一般的なWebページ / 直リンクの画像・動画
// ──────────────────────────────────────────────────────────
async function readGeneric(url: string, options: { withMedia?: boolean }): Promise<UrlReadResult> {
  const res = await safeFetch(url, { headers: { Accept: "text/html,application/xhtml+xml,*/*;q=0.8" } });
  const contentType = res.headers.get("content-type") ?? "";

  if (/^image\//.test(contentType)) {
    res.body?.cancel().catch(() => {});
    const data = await imageUrlToDataUri(url);
    return { text: `[画像] ${url}`, images: data ? [data] : [], mediaUrls: [] };
  }
  if (/^video\//.test(contentType)) {
    res.body?.cancel().catch(() => {});
    const digest = await digestVideo(url);
    return digest
      ? { text: `[動画] 長さ${formatSeconds(digest.durationSec)}${digest.hasAudio ? " / 音声あり（音は聞こえない）" : ""}（添付は等間隔のコマのタイル、左上→右下が時間順）`, images: [digest.gridDataUri], mediaUrls: [] }
      : { text: "[動画] 解析できなかったよ", images: [], mediaUrls: [] };
  }
  if (!res.ok) return { text: `HTTP ${res.status} で読み込めなかったよ`, images: [], mediaUrls: [] };
  if (!/html|xml|text|json/.test(contentType)) {
    res.body?.cancel().catch(() => {});
    return { text: `[${contentType || "不明な形式"}] 中身は読めない形式だよ`, images: [], mediaUrls: [] };
  }

  const raw = (await readLimited(res, 3 * 1024 * 1024)).toString("utf8");
  if (/json/.test(contentType)) return { text: truncate(raw, 4000), images: [], mediaUrls: [] };

  const $ = cheerio.load(raw);
  const meta = (name: string) =>
    $(`meta[property="${name}"]`).attr("content") ?? $(`meta[name="${name}"]`).attr("content") ?? "";
  const title = meta("og:title") || $("title").first().text().trim();
  const description = meta("og:description") || meta("description");
  const ogImage = meta("og:image");
  const siteName = meta("og:site_name");

  $("script, style, noscript, svg, nav, footer, header, aside, form, iframe").remove();
  const root = $("article").first().length ? $("article").first() : $("main").first().length ? $("main").first() : $("body");
  const body = root
    .text()
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter((l) => l.length > 1)
    .join("\n");

  const lines = [
    `[Webページ] ${url}`,
    siteName ? `サイト: ${siteName}` : "",
    title ? `タイトル: ${title}` : "",
    description ? `説明: ${truncate(description, 300)}` : "",
    body ? `本文（抜粋）:\n${truncate(body, 3500)}` : "",
  ].filter(Boolean);

  const images: string[] = [];
  const mediaUrls: string[] = [];
  if (ogImage) {
    const abs = new URL(ogImage, url).toString();
    if (options.withMedia) {
      const data = await imageUrlToDataUri(abs);
      if (data) images.push(data);
    } else {
      mediaUrls.push(abs);
    }
  }
  return { text: lines.join("\n"), images, mediaUrls };
}
