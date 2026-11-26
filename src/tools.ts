import {
  authorName,
  base64ToBytes,
  cache,
  ChannelType,
  fetchMessage,
  fetchMessages as fetchChannelMessages,
  hasPermissions,
  isTextChannel,
  isThread,
  memberDisplayName,
  Permission,
  permissionsFor,
  type Channel,
  type FileData,
  type GuildState,
  type Message,
} from "./discord";
import {
  ENABLE_WEB_SEARCH,
  GROK_API_KEY,
  IMAGE_GEN_PER_DAY,
  IMAGE_GEN_PER_USER_PER_DAY,
  IMAGE_GEN_SPECIAL_DAYS,
  IMAGE_GEN_SPECIAL_USERS,
  IMAGE_MODEL,
} from "./config";
import { postFeedback } from "./feedback";
import { digestVideo, formatSeconds, imageUrlToDataUri, isImageAttachment, isVideoAttachment, type VideoDigest } from "./media";
import { nameMemory, notesMemory, serverMessageLog, usageCounter } from "./store";
import { japanDateKey, sampleEvenly, shortJapanTime, truncate } from "./util";
import { readUrl } from "./web";
import type { FunctionTool, ResponseTool } from "./xai";

export type ToolContext = {
  msg: Message;
  guild: GuildState;
  /** 話しかけてきた人（権限の計算と呼び名に使う） */
  member: { id: string; displayName: string; roles: string[] };
  /** 会話中に出てきたメディアの短い参照ID → URL */
  media: Map<string, { url: string; kind: "image" | "video" | "unknown"; label: string }>;
  /** 返信に添付するファイル（画像生成など） */
  files: FileData[];
  /** 実行したツールの記録（ログ用） */
  trace: string[];
  /** 同じ返信内で同じツール呼び出しを繰り返さないため */
  seenCalls?: Set<string>;
  /** 画像生成が上限で断られたとき、返信に必ず添える案内 */
  imageLimitNotice?: string;
  /** 画像を描けたとき、返信に必ず添える残りパワーの案内 */
  imagePowerNotice?: string;
};

export type MediaImage = { url: string; caption: string };
export type ToolResult = { output: string; images?: MediaImage[] };

/**
 * 動画をモデルに見せる形にする。1フレームずつ「動画の◯秒時点」と明示して渡す
 * （1枚にまとめると「画像を何枚も貼った」と誤解されるため）。
 */
export function videoImages(name: string, digest: VideoDigest): MediaImage[] {
  const header =
    `【動画】「${name}」長さ${formatSeconds(digest.durationSec)}${digest.hasAudio ? "・音声あり（音は聞こえない）" : "・音声なし"}。` +
    "以下はこの1本の動画を再生している様子（時刻つき）。静止画の投稿ではない。" +
    "動画として、流れ・動き・雰囲気を話してね。フレームやコマを見たことはわざわざ言わない。\n";
  return digest.frames.map((frame, i) => ({
    url: frame.dataUri,
    caption: `${i === 0 ? header : ""}動画「${name}」の ${formatSeconds(frame.time)} 時点`,
  }));
}

export function videoSummary(name: string, digest: VideoDigest): string {
  return `動画「${name}」長さ${formatSeconds(digest.durationSec)}（再生中のフレームを${digest.frames.length}枚見せるよ）`;
}

/** メッセージの添付（画像・動画）をモデルに見せられる形にする */
export async function loadMessageMedia(m: Message, limit: number): Promise<{ images: MediaImage[]; notes: string[] }> {
  const images: MediaImage[] = [];
  const notes: string[] = [];
  for (const att of (m.attachments ?? []).slice(0, limit)) {
    const name = att.filename ?? "file";
    if (isImageAttachment(att)) {
      const data = await imageUrlToDataUri(att.url);
      if (data) images.push({ url: data, caption: `【画像】「${name}」` });
      else notes.push(`画像「${name}」は読み込めなかった`);
    } else if (isVideoAttachment(att)) {
      const digest = await digestVideo(att.url);
      if (digest) images.push(...videoImages(name, digest));
      else notes.push(`動画「${name}」は解析できなかった`);
    }
  }
  return { images, notes };
}

// ──────────────────────────────────────────────────────────
// メッセージ整形（メディアは短い参照IDにして渡す）
// ──────────────────────────────────────────────────────────
export function registerMedia(ctx: ToolContext, url: string, kind: "image" | "video" | "unknown", label: string): string {
  for (const [id, value] of ctx.media) if (value.url === url) return id;
  const id = `media#${ctx.media.size + 1}`;
  ctx.media.set(id, { url, kind, label });
  return id;
}

/** maxContent: 本文の最大文字数。返事をする相手のメッセージ・返信先は長いプロンプトもそのまま読めるように大きくする */
export function formatMessage(ctx: ToolContext, m: Message, botId: string, maxContent = 600): string {
  const name = m.author.id === botId ? "ぴくたーちゃん(あなた)" : authorName(m);
  const parts: string[] = [];
  const content = m.content
    ?.replace(/<@!?(\d+)>/g, (_, id) => {
      const user = m.mentions?.find((u) => u.id === id) ?? cache.guilds.get(ctx.guild.id)?.members.get(id)?.user;
      return `@${user ? memberDisplayName(ctx.guild.id, user) : "誰か"}`;
    })
    .replace(/<#(\d+)>/g, (_, id) => `#${cache.channels.get(id)?.name ?? id}`)
    .trim();
  if (content) parts.push(truncate(content, maxContent));
  for (const att of m.attachments ?? []) {
    const kind = isImageAttachment(att) ? "image" : isVideoAttachment(att) ? "video" : "unknown";
    const ref = registerMedia(ctx, att.url, kind, att.filename ?? "file");
    parts.push(`[${kind === "image" ? "画像" : kind === "video" ? "動画" : "ファイル"} ${att.filename ?? ""} → ${ref}]`);
  }
  for (const embed of (m.embeds ?? []).slice(0, 2)) {
    const text = [embed.title, embed.description].filter(Boolean).join(" - ");
    if (text) parts.push(`[埋め込み: ${truncate(text, 200)}]`);
    const img = embed.image?.url ?? embed.thumbnail?.url;
    if (img && !embed.video) parts.push(`[埋め込み画像 → ${registerMedia(ctx, img, "image", "embed")}]`);
    if (embed.video?.url) parts.push(`[埋め込み動画 ${embed.url ?? ""}]`);
  }
  for (const sticker of m.sticker_items ?? []) parts.push(`[スタンプ: ${sticker.name}]`);
  const reply = m.message_reference?.message_id ? " (返信)" : "";
  return `[${shortJapanTime(Date.parse(m.timestamp))}] ${name}${reply}: ${parts.join(" ") || "(空)"}`;
}

// ──────────────────────────────────────────────────────────
// 権限（質問した人が見られるチャンネルだけ読む）
// ──────────────────────────────────────────────────────────
function canRead(ctx: ToolContext, channel: Channel | null | undefined): boolean {
  if (!channel || channel.guild_id !== ctx.guild.id) return false;
  const me = ctx.guild.members.get(cache.botId);
  const needed = [Permission.ViewChannel, Permission.ReadMessageHistory];
  return Boolean(
    me &&
      hasPermissions(permissionsFor(ctx.guild, channel, ctx.member.id, ctx.member.roles), needed) &&
      hasPermissions(permissionsFor(ctx.guild, channel, cache.botId, me.roles), needed),
  );
}

function normalizeName(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

const guildChannels = (ctx: ToolContext) => Array.from(cache.channels.values()).filter((c) => c.guild_id === ctx.guild.id);

async function resolveChannel(ctx: ToolContext, query: string): Promise<Channel | null> {
  const q = (query ?? "").trim();
  const id = q.match(/(\d{15,})/)?.[1];
  if (id) {
    const ch = await cache.getChannel(id);
    return ch && canRead(ctx, ch) ? ch : null;
  }
  if (/^(ここ|この|今の|現在|this|current)/i.test(q)) return cache.getChannel(ctx.msg.channel_id);

  const target = normalizeName(q.replace(/^#/, ""));
  if (!target) return null;
  const candidates = guildChannels(ctx).filter((c) => isTextChannel(c) && canRead(ctx, c));
  const nameOf = (c: Channel) => normalizeName(c.name ?? "");
  return (
    candidates.find((c) => nameOf(c) === target) ??
    candidates.find((c) => nameOf(c).includes(target)) ??
    candidates.find((c) => target.includes(nameOf(c)) && nameOf(c).length >= 2) ??
    null
  );
}

async function fetchMessages(channelId: string, limit: number, sinceTimestamp: number): Promise<Message[]> {
  const collected: Message[] = [];
  let before: string | undefined;
  while (collected.length < limit) {
    const batch = await fetchChannelMessages(channelId, { limit: Math.min(100, limit - collected.length), before });
    if (!batch || batch.length === 0) break;
    const items = batch.sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
    for (const item of items) {
      if (Date.parse(item.timestamp) < sinceTimestamp) return collected.reverse();
      collected.push(item);
    }
    before = items[items.length - 1].id;
    if (batch.length < 100) break;
  }
  return collected.reverse();
}

// ──────────────────────────────────────────────────────────
// ツール定義
// ──────────────────────────────────────────────────────────
const FUNCTION_TOOLS: FunctionTool[] = [
  {
    type: "function",
    name: "list_channels",
    description: "このDiscordサーバーで、話しかけてきた人が見られるチャンネル一覧（名前・ID・説明）を返す。どのチャンネルを読むべきか分からない時に使う。",
    parameters: { type: "object", properties: {} },
  },
  {
    type: "function",
    name: "read_channel",
    description:
      "指定したチャンネル/スレッドの最近のメッセージを読む。他のチャンネルの話題・流れ・まとめを聞かれた時や、会話の前提を確認したい時に使う。" +
      "channel にはチャンネル名（例: 何でも, アート広場）、#メンション、ID、または『ここ』を指定。",
    parameters: {
      type: "object",
      properties: {
        channel: { type: "string", description: "チャンネル名 / ID / 『ここ』" },
        hours: { type: "number", description: "何時間前まで遡るか（既定48、最大336=2週間）" },
        limit: { type: "number", description: "最大件数（既定60、最大300）" },
      },
      required: ["channel"],
    },
  },
  {
    type: "function",
    name: "search_messages",
    description:
      "【サーバー内の過去発言を探す専用】相手が『前に〇〇の話してたのいつ？』『〇〇さん最近何投稿してた？』のように、このサーバーで過去に誰かが話した内容を明示的に聞いた時だけ使う。" +
      "AIイラストの技術相談や一般的な質問には使わない（自分の知識で答える）。",
    parameters: {
      type: "object",
      properties: {
        keywords: { type: "string", description: "スペース区切りのキーワード（すべて含むものを探す）。人だけで探すなら空でよい" },
        user: { type: "string", description: "発言者の名前（部分一致、任意）" },
        channel: { type: "string", description: "チャンネル名（任意）" },
        days: { type: "number", description: "何日前まで（既定30）" },
      },
      required: ["keywords"],
    },
  },
  {
    type: "function",
    name: "read_url",
    description:
      "URLの中身を読む。Webページ本文、X(Twitter)のポスト（画像・動画も見られる）、YouTube（タイトル・概要欄・動画全体のコマ画像）、Discordのメッセージリンク、画像/動画の直リンクに対応。" +
      "会話にURLが出てきて中身に触れるなら必ず使う。",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string" },
        with_images: { type: "boolean", description: "Webページのメイン画像も見るか（既定false。X/YouTube/直リンクは常に見る）" },
      },
      required: ["url"],
    },
  },
  {
    type: "function",
    name: "view_media",
    description: "会話ログ中の画像・動画（media#番号）や画像/動画URLを実際に見る。動画は等間隔のコマを並べた画像として見える。",
    parameters: {
      type: "object",
      properties: { ref: { type: "string", description: "media#3 のような参照ID、またはURL" } },
      required: ["ref"],
    },
  },
  {
    type: "function",
    name: "remember_about_user",
    description: "話している相手について長く覚えておく価値のあること（好きなもの、作風、使っているモデル、目標など）を1文で記録する。雑談の一時的な内容は記録しない。",
    parameters: {
      type: "object",
      properties: { note: { type: "string" } },
      required: ["note"],
    },
  },
  {
    type: "function",
    name: "set_nickname",
    description: "相手が『〇〇って呼んで』などと呼び名を指定した時に記録する。",
    parameters: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    },
  },
  {
    type: "function",
    name: "submit_feedback",
    description:
      "Aipictors（サイト/アプリ）への不具合報告や機能要望を、運営のフォーラムとGitHub Issueに投稿する。" +
      "相手がAipictorsの不具合を報告している、または改善要望を伝えていると明確に分かる時だけ使う。雑談・愚痴・一般的な質問では使わない。",
    parameters: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["bug", "opinion"] },
        title: { type: "string", description: "簡潔なタイトル" },
        content: { type: "string", description: "運営が読みやすいよう整理した内容（再現手順・環境・要望の背景など分かる範囲で）" },
      },
      required: ["kind", "title", "content"],
    },
  },
  {
    type: "function",
    name: "generate_image",
    description:
      `イラストを生成して返信に添付する。相手が明確に「描いて」「画像作って」と頼んだ時だけ使う。1人1日の枚数に上限あり。` +
      "性的・暴力的・実在人物・他者の著作物キャラの生成は断る。prompt は英語で具体的に。" +
      "ぴくたーちゃん自身を描く時は外見を必ず含める: cute anime girl, long multicolored hair with orange, blue and green tones, soft bangs, ahoge, vivid blue eyes, soft blush, stylish student uniform with a cute ribbon, cheerful smile。",
    parameters: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "英語の画像生成プロンプト" },
        aspect_ratio: { type: "string", enum: ["1:1", "3:4", "4:3", "9:16", "16:9"] },
      },
      required: ["prompt"],
    },
  },
];

export function buildTools(): ResponseTool[] {
  const tools: ResponseTool[] = [...FUNCTION_TOOLS];
  if (ENABLE_WEB_SEARCH) tools.push({ type: "web_search" }, { type: "x_search" });
  return tools;
}

// ──────────────────────────────────────────────────────────
// 実装
// ──────────────────────────────────────────────────────────
export async function runTool(ctx: ToolContext, name: string, rawArgs: string): Promise<ToolResult> {
  let args: any = {};
  try {
    args = rawArgs ? JSON.parse(rawArgs) : {};
  } catch {
    return { output: "引数がJSONとして読めなかったよ" };
  }
  const callKey = `${name}:${JSON.stringify(args)}`;
  ctx.seenCalls ??= new Set();
  if (ctx.seenCalls.has(callKey) && name !== "generate_image") {
    return { output: "それはこの返信の中ですでに取得済みだよ。上の結果を使ってね" };
  }
  ctx.seenCalls.add(callKey);
  ctx.trace.push(`${name}(${truncate(rawArgs ?? "", 80)})`);

  try {
    switch (name) {
      case "list_channels":
        return listChannels(ctx);
      case "read_channel":
        return await readChannel(ctx, String(args.channel ?? "ここ"), Number(args.hours) || 48, Number(args.limit) || 60);
      case "search_messages":
        return searchMessages(ctx, args);
      case "read_url":
        return await readAnyUrl(ctx, String(args.url ?? ""), Boolean(args.with_images));
      case "view_media":
        return await viewMedia(ctx, String(args.ref ?? ""));
      case "remember_about_user":
        notesMemory.add(ctx.msg.author.id, String(args.note ?? ""));
        return { output: "覚えたよ" };
      case "set_nickname":
        nameMemory.setPreferredName(ctx.msg.author.id, ctx.member.displayName, String(args.name ?? ""));
        return { output: `呼び名を「${args.name}」にしたよ` };
      case "submit_feedback": {
        const kind = args.kind === "bug" ? "bug" : "opinion";
        const result = await postFeedback({
          kind,
          title: String(args.title ?? ""),
          content: String(args.content ?? ""),
          userTag: `${userTag(ctx.msg.author)} (${ctx.msg.author.id})`,
          attachments: ctx.msg.attachments ?? [],
        });
        return { output: result.posted ? `投稿できたよ。返信にこのリンクをそのまま含めて: ${result.message}` : `投稿に失敗: ${result.message}` };
      }
      case "generate_image":
        return await generateImage(ctx, String(args.prompt ?? ""), String(args.aspect_ratio ?? "1:1"));
      default:
        return { output: `未知のツール: ${name}` };
    }
  } catch (error: any) {
    console.error(`[TOOL] ${name} failed`, error);
    return { output: `ツール実行に失敗したよ: ${error?.message ?? error}` };
  }
}

function listChannels(ctx: ToolContext): ToolResult {
  const position = (id: string | null | undefined) => (id ? (cache.channels.get(id)?.position ?? -1) : -1);
  const channels = guildChannels(ctx)
    .filter((c) => c.type !== ChannelType.GuildCategory && isTextChannel(c) && !isThread(c) && canRead(ctx, c))
    .sort((a, b) => position(a.parent_id) - position(b.parent_id) || (a.position ?? 0) - (b.position ?? 0));
  const lines = channels.map((c) => {
    const topic = c.topic ? ` - ${truncate(c.topic.replace(/\s+/g, " "), 60)}` : "";
    const parent = c.parent_id ? cache.channels.get(c.parent_id)?.name : undefined;
    return `${parent ?? "-"} / #${c.name} (id:${c.id})${topic}`;
  });
  return { output: lines.join("\n") || "読めるチャンネルが見つからなかったよ" };
}

async function readChannel(ctx: ToolContext, query: string, hours: number, limit: number): Promise<ToolResult> {
  const channel = await resolveChannel(ctx, query);
  if (!channel) return { output: `「${query}」というチャンネルが見つからないか、見る権限がないよ。list_channels で確認してね` };
  if (!isTextChannel(channel)) return { output: "そのチャンネルはメッセージを読めない種類だよ" };

  const since = Date.now() - Math.min(336, Math.max(1, hours)) * 3600_000;
  const messages = await fetchMessages(channel.id, Math.min(300, Math.max(5, limit)), since);
  if (messages.length === 0) return { output: `#${channel.name} にはその期間のメッセージがなかったよ` };

  const botId = cache.botId;
  const shown = sampleEvenly(messages, 150);
  const header = `#${channel.name} の直近${hours}時間（${messages.length}件${shown.length < messages.length ? `中${shown.length}件を等間隔で抜粋` : ""}）`;
  return { output: `${header}\n${shown.map((m) => formatMessage(ctx, m, botId)).join("\n")}` };
}

function searchMessages(ctx: ToolContext, args: any): ToolResult {
  const keywords = String(args.keywords ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const user = String(args.user ?? "").toLowerCase();
  const channelQuery = normalizeName(String(args.channel ?? ""));
  const since = Date.now() - Math.min(365, Math.max(1, Number(args.days) || 30)) * 86400_000;
  if (keywords.length === 0 && !user) return { output: "キーワードか人の名前を指定してね" };

  const readable = new Map<string, boolean>();
  const isReadable = (channelId: string, parentId: string | null) => {
    const key = parentId ?? channelId;
    if (!readable.has(key)) readable.set(key, canRead(ctx, cache.channels.get(key)));
    return readable.get(key)!;
  };

  const hits = serverMessageLog.search((m) => {
    if (m.guildId !== ctx.guild.id || m.timestamp < since) return false;
    if (user && !m.userName.toLowerCase().includes(user)) return false;
    if (channelQuery && !normalizeName(`${m.parentChannelName ?? ""}${m.channelName}`).includes(channelQuery)) return false;
    const text = m.content.toLowerCase();
    if (!keywords.every((k) => text.includes(k))) return false;
    return isReadable(m.channelId, m.parentChannelId);
  }, 40);

  if (hits.length === 0) return { output: "見つからなかったよ（ぴくたーちゃんが記録している範囲だけ検索できるよ）" };
  const lines = hits.reverse().map((m) => {
    const media = m.attachmentUrls.map((url, i) => `[${m.attachmentNames[i] ?? "添付"} → ${registerMedia(ctx, url, /\.(mp4|mov|webm)/i.test(m.attachmentNames[i] ?? "") ? "video" : "image", m.attachmentNames[i] ?? "file")}]`).join(" ");
    return `[${shortJapanTime(m.timestamp)}] #${m.parentChannelName ? `${m.parentChannelName}/` : ""}${m.channelName} ${m.userName}: ${truncate(m.content, 300)} ${media}`.trim();
  });
  return { output: `${hits.length}件ヒット（新しい40件まで）\n${lines.join("\n")}` };
}

async function readDiscordMessageLink(ctx: ToolContext, url: string): Promise<ToolResult | null> {
  const match = url.match(/discord(?:app)?\.com\/channels\/(\d+|@me)\/(\d+)(?:\/(\d+))?/i);
  if (!match) return null;
  const [, guildId, channelId, messageId] = match;
  if (guildId !== ctx.guild.id) return { output: "別のサーバーのリンクは見られないよ" };
  const channel = await resolveChannel(ctx, channelId);
  if (!channel) return { output: "そのリンク先は見る権限がないか、見つからなかったよ" };
  if (!messageId) return readChannel(ctx, channelId, 48, 40);

  const target = await fetchMessage(channel.id, messageId);
  const around = (await fetchChannelMessages(channel.id, { limit: 6, before: messageId }))
    .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  const botId = cache.botId;
  const { images, notes } = await loadMessageMedia(target, 3);
  return {
    output: [
      `#${channel.name} のメッセージ:`,
      formatMessage(ctx, target, botId),
      around.length ? `\n（直前の流れ）\n${around.map((m) => formatMessage(ctx, m, botId)).join("\n")}` : "",
      images.length ? `\n（このメッセージの添付: ${images.map((i) => i.caption.split(/[。\n]/)[0]).filter((c) => !/時点$/.test(c)).join(" / ")}。中身は次のメッセージで見せるよ）` : "",
      notes.length ? `（${notes.join(" / ")}）` : "",
    ].join("\n"),
    images,
  };
}

async function readAnyUrl(ctx: ToolContext, url: string, withImages: boolean): Promise<ToolResult> {
  if (!/^https?:\/\//i.test(url)) return { output: "URLの形式が変だよ" };
  const discord = await readDiscordMessageLink(ctx, url);
  if (discord) return discord;
  const result = await readUrl(url, { withMedia: withImages || undefined });
  const refs = result.mediaUrls.map((u) => registerMedia(ctx, u, /\.(mp4|mov|webm)/i.test(u) ? "video" : "image", "linked"));
  return {
    output: result.text + (refs.length ? `\n（未表示のメディア: ${refs.join(", ")}）` : "") + (result.images.length ? "\n（メディアは次のメッセージで見せるよ）" : ""),
    images: result.images,
  };
}

async function viewMedia(ctx: ToolContext, ref: string): Promise<ToolResult> {
  const entry = ctx.media.get(ref.trim());
  const url = entry?.url ?? (/^https?:\/\//.test(ref) ? ref : null);
  if (!url) {
    const known = Array.from(ctx.media.keys());
    return { output: `${ref} は存在しないよ。参照IDを作らないでね。${known.length ? `使えるのは ${known.join(", ")} だけ` : "見られるメディアはないよ"}` };
  }

  const kind = entry?.kind ?? (/\.(mp4|mov|webm|m4v)(\?|$)/i.test(url) ? "video" : "image");
  if (kind === "video") {
    const digest = await digestVideo(url);
    if (!digest) return { output: "動画を解析できなかったよ" };
    const name = entry?.label ?? "動画";
    return { output: videoSummary(name, digest), images: videoImages(name, digest) };
  }
  const data = await imageUrlToDataUri(url);
  if (!data) {
    // 画像でなければ動画として再挑戦
    const digest = await digestVideo(url);
    if (digest) {
      const name = entry?.label ?? "動画";
      return { output: videoSummary(name, digest), images: videoImages(name, digest) };
    }
    return { output: "画像を取得できなかったよ" };
  }
  return { output: "画像は次のメッセージで見せるよ", images: [{ url: data, caption: `【画像】「${entry?.label ?? "画像"}」` }] };
}

/** discord.js の user.tag と同じ（新しいユーザー名は # なし） */
export function userTag(user: { username: string; discriminator?: string }): string {
  return user.discriminator && user.discriminator !== "0" ? `${user.username}#${user.discriminator}` : user.username;
}

/** 今日のお絵かきの上限（特別な日はその日の上限。userId を渡すと、その人だけの特別な上限も反映） */
export function imageGenLimits(now: Date = new Date(), userId?: string): { perUser: number; total: number } {
  const day = japanDateKey(now);
  const limits = IMAGE_GEN_SPECIAL_DAYS[day] ?? { perUser: IMAGE_GEN_PER_USER_PER_DAY, total: IMAGE_GEN_PER_DAY };
  const special = userId ? IMAGE_GEN_SPECIAL_USERS[day]?.[userId] : undefined;
  return special === undefined ? limits : { ...limits, perUser: special };
}

async function generateImage(ctx: ToolContext, prompt: string, aspectRatio: string): Promise<ToolResult> {
  const userKey = `img:${ctx.msg.author.id}`;
  const limits = imageGenLimits(new Date(), ctx.msg.author.id);
  if (usageCounter.get(userKey) >= limits.perUser) {
    ctx.imageLimitNotice = `🎨 今日のお絵かきパワーを使い切っちゃったから描けなかったの🙏（⚡ 残りパワー 0/${limits.perUser}）日本時間の0時に回復するから、また明日頼んでね`;
    return { output: `上限のため描いていない。今日はもう${limits.perUser}枚描いたから、また明日ね。描いたふりはしないで、上限で描けないことを伝えて` };
  }
  if (usageCounter.get("img:total") >= limits.total) {
    ctx.imageLimitNotice = `🎨 今日はサーバー全体のお絵かき上限（1日${limits.total}枚）に達しちゃったから描けなかったの🙏 日本時間の0時にリセットされるから、また明日頼んでね`;
    return { output: "上限のため描いていない。今日はサーバー全体の生成上限に達した。描いたふりはしないで、上限で描けないことを伝えて" };
  }
  if (ctx.files.length > 0) return { output: "1回の返信で描けるのは1枚までだよ" };

  const res = await fetch("https://api.x.ai/v1/images/generations", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${GROK_API_KEY}` },
    body: JSON.stringify({ model: IMAGE_MODEL, prompt: truncate(prompt, 1500), aspect_ratio: aspectRatio, response_format: "b64_json" }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) {
    console.error("[IMAGE GEN]", res.status, (await res.text()).slice(0, 300));
    return { output: "画像生成に失敗したよ（内容が制限に引っかかったかも）" };
  }
  const json = (await res.json()) as any;
  let b64: string | undefined = json?.data?.[0]?.b64_json ?? json?.image;
  const imageUrl: string | undefined = json?.data?.[0]?.url ?? json?.url;
  if (!b64 && imageUrl) {
    const img = await fetch(imageUrl, { signal: AbortSignal.timeout(60_000) });
    if (img.ok) b64 = Buffer.from(await img.arrayBuffer()).toString("base64");
  }
  if (!b64) {
    console.error("[IMAGE GEN] no image in response", JSON.stringify(json).slice(0, 300));
    return { output: "画像データが返ってこなかったよ" };
  }

  usageCounter.increment(userKey);
  usageCounter.increment("img:total");
  ctx.files.push({ name: "pictorchan.jpg", data: base64ToBytes(b64), description: truncate(prompt, 200) });
  const remaining = Math.max(0, limits.perUser - usageCounter.get(userKey));
  ctx.imagePowerNotice = `⚡ 今日の残りパワー ${remaining}/${limits.perUser}（1枚で1パワー・日本時間0時に回復）`;
  return {
    output: `生成できたよ。返信に自動で添付される。残りパワー（今日あと${remaining}枚）の案内は自動で添えるので本文には書かなくていい。描いた内容をひとこと添えて`,
    images: [{ url: `data:image/jpeg;base64,${b64}`, caption: "【あなたが今生成した画像】" }],
  };
}
