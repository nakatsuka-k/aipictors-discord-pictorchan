import {
  AttachmentBuilder,
  ChannelType,
  GuildMember,
  Message,
  PermissionFlagsBits,
  type Guild,
  type GuildBasedChannel,
} from "discord.js";
import {
  ENABLE_WEB_SEARCH,
  GROK_API_KEY,
  IMAGE_GEN_PER_DAY,
  IMAGE_GEN_PER_USER_PER_DAY,
  IMAGE_MODEL,
} from "./config";
import { postFeedback } from "./feedback";
import { digestVideo, formatSeconds, imageUrlToDataUri, isImageAttachment, isVideoAttachment } from "./media";
import { nameMemory, notesMemory, serverMessageLog, usageCounter } from "./store";
import { sampleEvenly, shortJapanTime, truncate } from "./util";
import { readUrl } from "./web";
import type { FunctionTool, ResponseTool } from "./xai";

export type ToolContext = {
  msg: Message;
  guild: Guild;
  member: GuildMember;
  /** 会話中に出てきたメディアの短い参照ID → URL */
  media: Map<string, { url: string; kind: "image" | "video" | "unknown"; label: string }>;
  /** 返信に添付するファイル（画像生成など） */
  files: AttachmentBuilder[];
  /** 実行したツールの記録（ログ用） */
  trace: string[];
};

export type ToolResult = { output: string; images?: string[] };

// ──────────────────────────────────────────────────────────
// メッセージ整形（メディアは短い参照IDにして渡す）
// ──────────────────────────────────────────────────────────
export function registerMedia(ctx: ToolContext, url: string, kind: "image" | "video" | "unknown", label: string): string {
  for (const [id, value] of ctx.media) if (value.url === url) return id;
  const id = `media#${ctx.media.size + 1}`;
  ctx.media.set(id, { url, kind, label });
  return id;
}

export function formatMessage(ctx: ToolContext, m: Message, botId: string): string {
  const name = m.author.id === botId ? "ぴくたーちゃん(あなた)" : (m.member?.displayName ?? m.author.displayName ?? m.author.username);
  const parts: string[] = [];
  const content = m.content
    ?.replace(/<@!?(\d+)>/g, (_, id) => `@${m.mentions.users.get(id)?.displayName ?? m.guild?.members.cache.get(id)?.displayName ?? "誰か"}`)
    .replace(/<#(\d+)>/g, (_, id) => `#${m.guild?.channels.cache.get(id)?.name ?? id}`)
    .trim();
  if (content) parts.push(truncate(content, 600));
  for (const att of m.attachments.values()) {
    const kind = isImageAttachment(att) ? "image" : isVideoAttachment(att) ? "video" : "unknown";
    const ref = registerMedia(ctx, att.url, kind, att.name ?? "file");
    parts.push(`[${kind === "image" ? "画像" : kind === "video" ? "動画" : "ファイル"} ${att.name ?? ""} → ${ref}]`);
  }
  for (const embed of m.embeds.slice(0, 2)) {
    const text = [embed.title, embed.description].filter(Boolean).join(" - ");
    if (text) parts.push(`[埋め込み: ${truncate(text, 200)}]`);
    const img = embed.image?.url ?? embed.thumbnail?.url;
    if (img && !embed.video) parts.push(`[埋め込み画像 → ${registerMedia(ctx, img, "image", "embed")}]`);
    if (embed.video?.url) parts.push(`[埋め込み動画 ${embed.url ?? ""}]`);
  }
  for (const sticker of m.stickers.values()) parts.push(`[スタンプ: ${sticker.name}]`);
  const reply = m.reference?.messageId ? " (返信)" : "";
  return `[${shortJapanTime(m.createdTimestamp)}] ${name}${reply}: ${parts.join(" ") || "(空)"}`;
}

// ──────────────────────────────────────────────────────────
// 権限（質問した人が見られるチャンネルだけ読む）
// ──────────────────────────────────────────────────────────
function canRead(ctx: ToolContext, channel: GuildBasedChannel | null | undefined): boolean {
  if (!channel || channel.guildId !== ctx.guild.id) return false;
  const me = ctx.guild.members.me;
  const needed = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory];
  return Boolean(channel.permissionsFor(ctx.member)?.has(needed) && me && channel.permissionsFor(me)?.has(needed));
}

function normalizeName(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

async function resolveChannel(ctx: ToolContext, query: string): Promise<GuildBasedChannel | null> {
  const q = (query ?? "").trim();
  const id = q.match(/(\d{15,})/)?.[1];
  if (id) {
    const ch = ctx.guild.channels.cache.get(id) ?? (await ctx.guild.channels.fetch(id).catch(() => null));
    return ch && canRead(ctx, ch) ? ch : null;
  }
  if (/^(ここ|この|今の|現在|this|current)/i.test(q)) return ctx.msg.channel as GuildBasedChannel;

  const target = normalizeName(q.replace(/^#/, ""));
  if (!target) return null;
  const candidates = Array.from(ctx.guild.channels.cache.values()).filter(
    (c) => "messages" in c && canRead(ctx, c),
  );
  return (
    candidates.find((c) => normalizeName(c.name) === target) ??
    candidates.find((c) => normalizeName(c.name).includes(target)) ??
    candidates.find((c) => target.includes(normalizeName(c.name)) && normalizeName(c.name).length >= 2) ??
    null
  );
}

async function fetchMessages(channel: any, limit: number, sinceTimestamp: number): Promise<Message[]> {
  const collected: Message[] = [];
  let before: string | undefined;
  while (collected.length < limit) {
    const batch = await channel.messages.fetch({ limit: Math.min(100, limit - collected.length), ...(before ? { before } : {}) });
    if (!batch || batch.size === 0) break;
    const items = Array.from(batch.values() as Iterable<Message>).sort((a, b) => b.createdTimestamp - a.createdTimestamp);
    for (const item of items) {
      if (item.createdTimestamp < sinceTimestamp) return collected.reverse();
      collected.push(item);
    }
    before = items[items.length - 1].id;
    if (batch.size < 100) break;
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
      `イラストを生成して返信に添付する。相手が明確に「描いて」「画像作って」と頼んだ時だけ使う。1人1日${IMAGE_GEN_PER_USER_PER_DAY}枚まで。` +
      "性的・暴力的・実在人物・他者の著作物キャラの生成は断る。prompt は英語で具体的に。",
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
          userTag: `${ctx.msg.author.tag} (${ctx.msg.author.id})`,
          attachments: Array.from(ctx.msg.attachments.values()),
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
  const channels = Array.from(ctx.guild.channels.cache.values())
    .filter((c) => c.type !== ChannelType.GuildCategory && "messages" in c && !c.isThread() && canRead(ctx, c))
    .sort((a: any, b: any) => (a.parent?.position ?? -1) - (b.parent?.position ?? -1) || (a.position ?? 0) - (b.position ?? 0));
  const lines = channels.map((c: any) => {
    const topic = c.topic ? ` - ${truncate(c.topic.replace(/\s+/g, " "), 60)}` : "";
    return `${c.parent?.name ?? "-"} / #${c.name} (id:${c.id})${topic}`;
  });
  return { output: lines.join("\n") || "読めるチャンネルが見つからなかったよ" };
}

async function readChannel(ctx: ToolContext, query: string, hours: number, limit: number): Promise<ToolResult> {
  const channel: any = await resolveChannel(ctx, query);
  if (!channel) return { output: `「${query}」というチャンネルが見つからないか、見る権限がないよ。list_channels で確認してね` };
  if (!channel.messages?.fetch) return { output: "そのチャンネルはメッセージを読めない種類だよ" };

  const since = Date.now() - Math.min(336, Math.max(1, hours)) * 3600_000;
  const messages = await fetchMessages(channel, Math.min(300, Math.max(5, limit)), since);
  if (messages.length === 0) return { output: `#${channel.name} にはその期間のメッセージがなかったよ` };

  const botId = ctx.msg.client.user!.id;
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
    if (!readable.has(key)) readable.set(key, canRead(ctx, ctx.guild.channels.cache.get(key)));
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
  const channel: any = await resolveChannel(ctx, channelId);
  if (!channel) return { output: "そのリンク先は見る権限がないか、見つからなかったよ" };
  if (!messageId) return readChannel(ctx, channelId, 48, 40);

  const target: Message = await channel.messages.fetch(messageId);
  const around: Message[] = Array.from((await channel.messages.fetch({ limit: 6, before: messageId })).values() as Iterable<Message>)
    .sort((a, b) => a.createdTimestamp - b.createdTimestamp);
  const botId = ctx.msg.client.user!.id;
  const images: string[] = [];
  for (const att of Array.from(target.attachments.values()).slice(0, 3)) {
    if (isImageAttachment(att)) {
      const data = await imageUrlToDataUri(att.url);
      if (data) images.push(data);
    } else if (isVideoAttachment(att)) {
      const digest = await digestVideo(att.url);
      if (digest) images.push(digest.gridDataUri);
    }
  }
  return {
    output: [
      `#${channel.name} のメッセージ:`,
      formatMessage(ctx, target, botId),
      around.length ? `\n（直前の流れ）\n${around.map((m) => formatMessage(ctx, m, botId)).join("\n")}` : "",
      images.length ? "\n（このメッセージの画像/動画コマを添付したよ）" : "",
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
    output: result.text + (refs.length ? `\n（未表示のメディア: ${refs.join(", ")}）` : "") + (result.images.length ? "\n（画像を添付したよ）" : ""),
    images: result.images,
  };
}

async function viewMedia(ctx: ToolContext, ref: string): Promise<ToolResult> {
  const entry = ctx.media.get(ref.trim());
  const url = entry?.url ?? (/^https?:\/\//.test(ref) ? ref : null);
  if (!url) return { output: `${ref} が見つからないよ` };

  const kind = entry?.kind ?? (/\.(mp4|mov|webm|m4v)(\?|$)/i.test(url) ? "video" : "image");
  if (kind === "video") {
    const digest = await digestVideo(url);
    if (!digest) return { output: "動画を解析できなかったよ" };
    return {
      output: `動画 長さ${formatSeconds(digest.durationSec)}${digest.hasAudio ? "（音声あり・音は聞こえない）" : ""}。添付は ${digest.frameTimes.map(formatSeconds).join(", ")} 時点のコマを左上→右下に並べたもの`,
      images: [digest.gridDataUri],
    };
  }
  const data = await imageUrlToDataUri(url);
  if (!data) {
    // 画像でなければ動画として再挑戦
    const digest = await digestVideo(url);
    if (digest) return { output: `動画 長さ${formatSeconds(digest.durationSec)}。添付はコマを時間順に並べたもの`, images: [digest.gridDataUri] };
    return { output: "画像を取得できなかったよ" };
  }
  return { output: "画像を添付したよ", images: [data] };
}

async function generateImage(ctx: ToolContext, prompt: string, aspectRatio: string): Promise<ToolResult> {
  const userKey = `img:${ctx.msg.author.id}`;
  if (usageCounter.get(userKey) >= IMAGE_GEN_PER_USER_PER_DAY) {
    return { output: `今日はもう${IMAGE_GEN_PER_USER_PER_DAY}枚描いたから、また明日ね（上限）` };
  }
  if (usageCounter.get("img:total") >= IMAGE_GEN_PER_DAY) return { output: "今日はサーバー全体の生成上限に達したよ" };
  if (ctx.files.length > 0) return { output: "1回の返信で描けるのは1枚までだよ" };

  const res = await fetch("https://api.x.ai/v1/images/generations", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${GROK_API_KEY}` },
    body: JSON.stringify({ model: IMAGE_MODEL, prompt: truncate(prompt, 1500), aspect_ratio: aspectRatio, image_format: "base64" }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) {
    console.error("[IMAGE GEN]", res.status, (await res.text()).slice(0, 300));
    return { output: "画像生成に失敗したよ（内容が制限に引っかかったかも）" };
  }
  const json = (await res.json()) as any;
  const b64 = json?.data?.[0]?.b64_json ?? json?.image;
  if (!b64) return { output: "画像データが返ってこなかったよ" };

  usageCounter.increment(userKey);
  usageCounter.increment("img:total");
  ctx.files.push(new AttachmentBuilder(Buffer.from(b64, "base64"), { name: "pictorchan.jpg", description: truncate(prompt, 200) }));
  const remaining = IMAGE_GEN_PER_USER_PER_DAY - usageCounter.get(userKey);
  return {
    output: `生成できたよ。返信に自動で添付される（今日あと${remaining}枚）。描いた内容をひとこと添えて`,
    images: [`data:image/jpeg;base64,${b64}`],
  };
}
