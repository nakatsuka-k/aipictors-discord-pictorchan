//--------------------------------------------------------------------
// Discord “ぴくたーちゃん” Bot 3.0（Cloudflare Workers + Durable Object）
//   ✓ ツール呼び出し型の会話エージェント（他チャンネル参照・リンク/動画閲覧・検索）
//   ✓ /checkimage /gacha /iken /huguai /diary ほか
//   ✓ 新規メンバー歓迎・毎日の日記・アップデート告知
// Gateway のイベントは src/gateway.ts から dispatch() に届く
//--------------------------------------------------------------------
import { fetchLinkedCard, notifyMemberJoined, toAchievementCardUrl } from "./aipictors-link";
import { generateReply, type ReplyMode } from "./agent";
import { CHANGELOG, CURRENT_VERSION, formatAnnouncement } from "./changelog";
import {
  ANNOUNCE_CHANNEL_ID,
  ANNOUNCE_STATE_PATH,
  CLIENT_ID,
  MAX_IMAGE_BYTES,
  NO_INTERACT_CHANNEL_IDS,
  PICTORCHAN_CHANNEL_ID,
  USER_REQUESTS_PER_MINUTE,
  VISION_MODEL,
} from "./config";
import { parseDiaryDateInput, postDiary } from "./diary";
import {
  authorName,
  base64ToBytes,
  cache,
  discord,
  isThread,
  react,
  replyTo,
  sendMessage,
  sendTyping,
  userDisplayName,
  type Attachment,
  type Member,
  type Message,
  type SendOptions,
  type User,
} from "./discord";
import { organizeAndPostFeedback } from "./feedback";
import { imageUrlToDataUri } from "./media";
import { conversationMemory, label, nameMemory, normalize, notesMemory, serverMessageLog } from "./store";
import { userTag } from "./tools";
import { getJapanNow, getJapanTimeFromTimestamp, japanDateKey, readJson, splitForDiscord, truncate, writeJsonAtomic } from "./util";
import { welcomeMember } from "./welcome";
import { visionText } from "./xai";

// ──────────────────────────────────────────────────────────
// レート制限・同時実行
// ──────────────────────────────────────────────────────────
const recentRequests = new Map<string, number[]>();
function allowRequest(userId: string): boolean {
  const now = Date.now();
  const list = (recentRequests.get(userId) ?? []).filter((t) => now - t < 60_000);
  if (list.length >= USER_REQUESTS_PER_MINUTE) return false;
  list.push(now);
  recentRequests.set(userId, list);
  return true;
}
const busyAutoChannels = new Set<string>();
// 再接続で同じイベントがもう一度届いても二重に返事しない
const handledMessages = new Set<string>();

function ndnDice(expr: string): string {
  const [nStr, dStr] = expr.toLowerCase().split("d");
  const n = Math.min(parseInt(nStr, 10), 100);
  const d = Math.min(parseInt(dStr, 10), 1000);
  if (isNaN(n) || isNaN(d) || n < 1 || d < 2) return "ダイス表記が変だよ…🎲";
  const rolls = Array.from({ length: n }, () => 1 + Math.floor(Math.random() * d));
  return `🎲 [${expr}] → ${rolls.reduce((a, b) => a + b)}  ( ${rolls.join(",")} )`;
}

/** discord.js の mentions.repliedUser（返信先の投稿者） */
const repliedUser = (msg: Message): User | undefined => msg.referenced_message?.author;

function isAutoReplyCandidate(content: string, msg: Message): boolean {
  const text = (content ?? "").trim();
  // 他の人への返信・呼びかけには割り込まない
  const replied = repliedUser(msg);
  if (msg.message_reference?.message_id && replied && replied.id !== cache.botId) return false;
  const addressed = text.match(/^([^\s、,。!！?？]{1,15}?)(さん|ちゃん|くん|君|氏|様)[、,!！\s]/);
  if (addressed && !/ぴくたー|ピクター|pictor/i.test(addressed[1])) return false;
  if ((msg.attachments ?? []).length > 0) return true;
  if (text.length < 2) return false;
  if (/^<a?:\w+:\d+>$/.test(text)) return false;
  if (/^[\p{Extended_Pictographic}\s]+$/u.test(text)) return false;
  return true;
}

async function logServerMessage(msg: Message) {
  const channel = await cache.getChannel(msg.channel_id);
  const parent = isThread(channel) && channel?.parent_id ? await cache.getChannel(channel.parent_id) : null;
  const attachments = msg.attachments ?? [];
  const timestamp = Date.parse(msg.timestamp);
  serverMessageLog.addMessage({
    messageId: msg.id,
    guildId: msg.guild_id ?? null,
    channelId: msg.channel_id,
    channelName: label(channel?.name ?? "unknown-channel"),
    parentChannelId: parent?.id ?? null,
    parentChannelName: parent?.name ? label(parent.name) : null,
    timestamp,
    timeString: getJapanTimeFromTimestamp(timestamp),
    userId: msg.author.id,
    userName: label(authorName(msg)),
    content: normalize(msg.content),
    attachmentNames: attachments.map((a) => a.filename ?? "attachment").slice(0, 6),
    attachmentUrls: attachments.map((a) => a.url).filter(Boolean).slice(0, 6),
    hasImage: attachments.some((a) => /^image\//.test(a.content_type ?? "") || /\.(png|jpe?g|gif|webp)$/i.test(a.filename ?? "")),
    replyToMessageId: msg.message_reference?.message_id ?? null,
  });
}

// ──────────────────────────────────────────────────────────
// メッセージ
// ──────────────────────────────────────────────────────────
async function onMessageCreate(msg: Message) {
  cache.noteMessage(msg);
  if (msg.author.bot || !msg.guild_id) return;
  if (handledMessages.has(msg.id)) return;
  handledMessages.add(msg.id);
  if (handledMessages.size > 2000) handledMessages.delete(handledMessages.values().next().value!);

  await logServerMessage(msg).catch((error) => console.error("[SERVER_LOG] error", error));
  nameMemory.observe(msg.author.id, authorName(msg), msg.content);

  if (NO_INTERACT_CHANNEL_IDS.has(msg.channel_id)) return;

  const botId = cache.botId;
  const mentionedUsers = msg.mentions ?? [];
  const isMentioned =
    mentionedUsers.some((u) => u.id === botId) ||
    repliedUser(msg)?.id === botId ||
    new RegExp(`<@!?${botId}>|@ぴくたーちゃん|@pictorchan`, "i").test(msg.content);

  // 他人宛てのメンションだけなら反応しない
  if (!isMentioned && mentionedUsers.length > 0) return;

  if (/^\d+d\d+$/i.test(msg.content.trim())) {
    await replyTo(msg, ndnDice(msg.content.trim())).catch(() => {});
    return;
  }

  const isAutoChannel = msg.channel_id === PICTORCHAN_CHANNEL_ID;
  const mode: ReplyMode | null = isMentioned ? "mention" : isAutoChannel && isAutoReplyCandidate(msg.content, msg) ? "auto" : null;
  if (!mode) return;

  if (/^(<@!?\d+>\s*)?(にゃん|にゃーん|にゃ～ん)[!！。]*$/.test(msg.content.trim())) {
    await replyTo(msg, "にゃ～ん🐱").catch(() => {});
    return;
  }

  if (!allowRequest(msg.author.id)) {
    if (mode === "mention") await react(msg, "⏳").catch(() => {});
    return;
  }
  if (mode === "auto") {
    if (busyAutoChannels.has(msg.channel_id)) return;
    busyAutoChannels.add(msg.channel_id);
  }

  sendTyping(msg.channel_id).catch(() => {});
  const typing = setInterval(() => sendTyping(msg.channel_id).catch(() => {}), 8_000);
  const startedAt = Date.now();
  const channelName = cache.channels.get(msg.channel_id)?.name ?? msg.channel_id;

  try {
    const reply = await generateReply(msg, mode);
    console.log(
      `[REPLY] ${mode} ch=${channelName} user=${msg.author.id} ${Date.now() - startedAt}ms $${reply.costUsd.toFixed(4)} in=${reply.usage.input} cached=${reply.usage.cached} out=${reply.usage.output} tools=[${reply.trace.join(", ")}] skip=${reply.text === null}`,
    );
    if (reply.text === null) return;

    const chunks = splitForDiscord(reply.text, 1900);
    const files = reply.files.length ? reply.files : undefined;
    const stillLatest = cache.channels.get(msg.channel_id)?.last_message_id === msg.id;
    if (mode === "auto" && stillLatest && !files) {
      await sendMessage(msg.channel_id, { content: chunks[0] });
    } else {
      await replyTo(msg, { content: chunks[0], files });
    }
    for (const chunk of chunks.slice(1)) await sendMessage(msg.channel_id, { content: chunk });

    const userText = msg.content.replace(new RegExp(`<@!?${botId}>`, "g"), "").trim() || "(添付のみ)";
    conversationMemory.addConversation(msg.author.id, msg.channel_id, authorName(msg), truncate(userText, 500), truncate(reply.text, 500));
  } catch (error) {
    console.error("[REPLY] error", error);
    if (mode === "mention") await replyTo(msg, "ごめんね、ちょっと調子が悪いみたい🥺 少ししてからもう一回話しかけてね").catch(() => {});
  } finally {
    clearInterval(typing);
    busyAutoChannels.delete(msg.channel_id);
  }
}

// ──────────────────────────────────────────────────────────
// スラッシュコマンド
// ──────────────────────────────────────────────────────────
const STRING = 3;
const USER = 6;
const ATTACHMENT = 11;
const COMMANDS = [
  { name: "help", description: "ぴくたーちゃんにできることを表示します" },
  {
    name: "checkimage",
    description: "画像の破綻箇所を指摘します",
    options: [{ type: ATTACHMENT, name: "image", description: "チェックする画像", required: true }],
  },
  { name: "gacha", description: "ガチャを引くよ～" },
  {
    name: "iken",
    description: "Aipictorsへの意見を投稿します",
    options: [{ type: STRING, name: "content", description: "意見の内容", required: true }],
  },
  {
    name: "huguai",
    description: "Aipictorsの不具合を報告します",
    options: [{ type: STRING, name: "content", description: "不具合の内容", required: true }],
  },
  { name: "forget", description: "あなたとの会話履歴と覚え書きを消去します" },
  { name: "forget_channel", description: "このチャンネルの会話履歴を消去します" },
  {
    name: "myname",
    description: "ぴくたーちゃんに呼んでほしい名前を教えます",
    options: [{ type: STRING, name: "name", description: "呼び名（20文字以内）", required: true }],
  },
  { name: "forget_name", description: "あなたの呼び名を忘れます" },
  { name: "namelist", description: "覚えている人の一覧を表示します" },
  {
    name: "card",
    description: "Aipictors の実績カードを見せます（Discord 連携している人だけ）",
    options: [{ type: USER, name: "user", description: "カードを見たい人（省略すると自分）" }],
  },
  {
    name: "diary",
    description: "指定日のぴくたーちゃん日記を投稿します",
    options: [{ type: STRING, name: "date", description: "対象日。例: 2026-03-28 または 03.28", required: true }],
  },
];

/** 内容が変わったときだけ登録し直す（Durable Object は再起動が多く、登録には 1 日の回数制限がある） */
export async function registerCommands(storage: { get<T>(key: string): Promise<T | undefined>; put(key: string, value: unknown): Promise<void> }) {
  if (!CLIENT_ID) return console.warn("[BOT] CLIENT_ID が無いので SlashCommand は登録しません");
  const signature = JSON.stringify(COMMANDS);
  if ((await storage.get<string>("commandsSignature")) === signature) return;
  try {
    await discord("PUT", `/applications/${CLIENT_ID}/commands`, COMMANDS);
    await storage.put("commandsSignature", signature);
    console.log("✅ SlashCommands registered");
  } catch (error) {
    console.error("[BOT] SlashCommand 登録失敗", error);
  }
}

const HELP_TEXT = [
  "## ぴくたーちゃんにできること🥔✨",
  `- **おしゃべり**: @ぴくたーちゃん でメンション、返信、または <#${PICTORCHAN_CHANNEL_ID}> で話しかけてね`,
  "- **リンクを読む**: Webページ・Xのポスト・YouTube・Discordのメッセージリンクを貼ると中身を見るよ",
  "- **画像・動画を見る**: 添付してくれたら感想や相談にのるよ（動画はコマを切り出して見るよ）",
  "- **他のチャンネルを見る**: 「#アート広場 で最近なに話してた？」「ここ一週間のまとめ」など",
  "- **検索**: 過去ログ検索・Web/X検索",
  "- **お絵かき**: 「〇〇描いて」（1人1日3枚まで）",
  "- **コマンド**: /card /checkimage /gacha /iken /huguai /myname /forget /namelist /diary",
  `-# v${CURRENT_VERSION}`,
].join("\n");

/** discord.js の ChatInputCommandInteraction の代わり（使う分だけ） */
class Interaction {
  deferred = false;
  replied = false;
  readonly user: User;
  readonly commandName: string;
  readonly channelId: string;

  constructor(private raw: any) {
    this.user = raw.member?.user ?? raw.user;
    this.commandName = raw.data?.name;
    this.channelId = raw.channel_id;
  }

  private option(name: string) {
    return (this.raw.data?.options ?? []).find((o: any) => o.name === name)?.value;
  }

  getString(name: string): string {
    return String(this.option(name) ?? "");
  }

  getUser(name: string): { user: User; member?: Member } | null {
    const id = this.option(name);
    if (!id) return null;
    const user = this.raw.data?.resolved?.users?.[id];
    return user ? { user, member: this.raw.data?.resolved?.members?.[id] } : null;
  }

  getAttachment(name: string): Attachment | null {
    const id = this.option(name);
    return id ? (this.raw.data?.resolved?.attachments?.[id] ?? null) : null;
  }

  private body(options: SendOptions) {
    const o = typeof options === "string" ? { content: options } : options;
    return {
      body: { content: o.content, embeds: o.embeds, allowed_mentions: o.allowedMentions ?? { parse: [] }, flags: o.ephemeral ? 64 : undefined },
      files: o.files,
    };
  }

  async reply(options: SendOptions) {
    const { body, files } = this.body(options);
    await discord("POST", `/interactions/${this.raw.id}/${this.raw.token}/callback`, { type: 4, data: body }, files, false);
    this.replied = true;
  }

  async deferReply() {
    await discord("POST", `/interactions/${this.raw.id}/${this.raw.token}/callback`, { type: 5 }, undefined, false);
    this.deferred = true;
  }

  async editReply(options: SendOptions) {
    const { body, files } = this.body(options);
    await discord("PATCH", `/webhooks/${this.raw.application_id}/${this.raw.token}/messages/@original`, body, files, false);
    this.replied = true;
  }

  async followUp(options: SendOptions) {
    const { body, files } = this.body(options);
    await discord("POST", `/webhooks/${this.raw.application_id}/${this.raw.token}`, body, files, false);
  }
}

async function handleCard(interaction: Interaction) {
  const option = interaction.getUser("user");
  const target = option?.user ?? interaction.user;
  const targetName = userDisplayName(target, option?.member?.nick);
  await interaction.deferReply();
  const card = await fetchLinkedCard(target.id);
  if (!card || !card.isLinked) {
    await interaction.editReply({
      content:
        target.id === interaction.user.id
          ? "まだ Aipictors と連携してないみたい🥔 連携すると名前の横にバッジが付くよ！\nhttps://www.aipictors.com/settings/discord"
          : `${targetName} さんはまだ Aipictors と連携してないみたい🥔`,
      allowedMentions: { parse: [] },
    });
    return;
  }
  if (!card.isAchievementVisible) {
    await interaction.editReply("この人は実績を非公開にしているよ🤫");
    return;
  }
  const name = card.name ?? targetName;
  await interaction.editReply({
    allowedMentions: { parse: [] },
    embeds: [
      {
        title: `${name} さんの実績カード`,
        url: `https://www.aipictors.com/achievements?user=${card.userId}`,
        description: `✦ **Lv.${card.level ?? 1}**　🏅 **実績 ${card.unlockedCount ?? 0} 個**`,
        color: 0x5865f2,
        image: { url: toAchievementCardUrl(card.userId!, card.unlockedCount ?? 0) },
      },
    ],
  });
}

async function handleCheckImage(interaction: Interaction) {
  const image = interaction.getAttachment("image");
  if (!image) {
    await interaction.reply("画像を添付してね🙏");
    return;
  }
  if (image.size > MAX_IMAGE_BYTES) {
    await interaction.reply(`画像は ${MAX_IMAGE_BYTES / 1024 / 1024}MB 以下にしてね🙏`);
    return;
  }
  await interaction.deferReply();
  // 破綻を探すので、会話より大きいまま見せる
  const dataUri = await imageUrlToDataUri(image.url, 2048);
  if (!dataUri) {
    await interaction.editReply("画像の取得か形式チェックで失敗しちゃった🥺");
    return;
  }
  const text =
    (await visionText(
      "あなたはAIイラストの画像検査の専門家『ぴくたーちゃん』です。破綻箇所（指の本数、手足、目、文字化け、パース、背景の歪みなど）を具体的な位置とともに指摘してください。" +
        "最後に良い点を可愛い口調（〜だよ、みてね♪）で褒め、星1〜5で採点し、投稿サイト用のタイトルと説明文の案を () で提案してください。Discordで読みやすい長さ（〜900字）で。",
      "画像をチェックしてください。",
      [dataUri],
      { model: VISION_MODEL, maxOutputTokens: 1500 },
    )) ?? "解析できなかったみたい…🥺";
  const [first, ...rest] = splitForDiscord(`**チェック結果**\n${text}`, 1900);
  const mime = dataUri.slice(5, dataUri.indexOf(";"));
  await interaction.editReply({
    content: first,
    files: [{ name: mime === "image/png" ? "image.png" : "image.jpg", data: base64ToBytes(dataUri.split(",")[1]) }],
  });
  for (const chunk of rest) await interaction.followUp(chunk);
}

function handleGacha(): string {
  const items = [
    "UR ダイヤモンドのじゃがいも💎",
    "LR 神のじゃがいも👑",
    "EX 宇宙のじゃがいも🌌",
    "SSR 金のじゃがいも🥇",
    "SR 銀のじゃがいも🥈",
    "R 銅のじゃがいも🥉",
    "N ただのじゃがいも🥔",
  ];
  const weights = [0.01, 0.05, 0.1, 2, 4, 8, 16];
  let rnd = Math.random() * weights.reduce((a, b) => a + b, 0);
  for (let i = 0; i < weights.length; i++) {
    if (rnd < weights[i]) return `${items[i]} が当選しました！`;
    rnd -= weights[i];
  }
  return `${items[items.length - 1]} が当選しました！`;
}

async function onInteractionCreate(raw: any) {
  if (raw.type !== 2 || raw.data?.type !== 1) return; // チャット入力のスラッシュコマンドだけ
  const interaction = new Interaction(raw);
  try {
    switch (interaction.commandName) {
      case "help":
        await interaction.reply({ content: HELP_TEXT, ephemeral: true });
        break;
      case "checkimage":
        await handleCheckImage(interaction);
        break;
      case "gacha":
        await interaction.reply(handleGacha());
        break;
      case "iken":
      case "huguai": {
        await interaction.deferReply();
        const kind = interaction.commandName === "iken" ? "opinion" : "bug";
        const result = await organizeAndPostFeedback(
          interaction.getString("content"),
          `${userTag(interaction.user)} (${interaction.user.id})`,
          kind,
        );
        await interaction.editReply(result.posted ? `${result.message} ありがとう🙏✨` : "ごめんね、投稿に失敗しちゃった🥺");
        break;
      }
      case "forget":
        conversationMemory.clearUserMemory(interaction.user.id);
        notesMemory.clear(interaction.user.id);
        await interaction.reply({ content: "あなたとの会話履歴と覚え書きを消したよ。また新しくおしゃべりしよ🫶", ephemeral: true });
        break;
      case "forget_channel":
        conversationMemory.clearChannelMemory(interaction.channelId);
        await interaction.reply("このチャンネルの会話履歴を消したよ🧹");
        break;
      case "myname": {
        const name = interaction.getString("name");
        if (name.length > 20) {
          await interaction.reply({ content: "名前は20文字以内にしてね🙏", ephemeral: true });
          break;
        }
        nameMemory.setPreferredName(interaction.user.id, userDisplayName(interaction.user), name);
        await interaction.reply(`${name}さんだね、覚えたよ♪✨`);
        break;
      }
      case "forget_name":
        nameMemory.clearUserName(interaction.user.id);
        await interaction.reply({ content: "呼び名を忘れたよ。また教えてね🥔", ephemeral: true });
        break;
      case "namelist":
        await interaction.reply({ content: nameMemory.getAllNamesForDisplay().slice(0, 1990), ephemeral: true });
        break;
      case "card":
        await handleCard(interaction);
        break;
      case "diary": {
        const targetDate = parseDiaryDateInput(interaction.getString("date"));
        if (!targetDate) {
          await interaction.reply("日付の形式が違うみたい。例: 2026-03-28 または 03.28");
          break;
        }
        if (japanDateKey(targetDate) > japanDateKey(getJapanNow())) {
          await interaction.reply("未来の日記はまだ書けないよ🔮");
          break;
        }
        await interaction.deferReply();
        const result = await postDiary({ targetDate, skipStateCheck: true, updateState: false });
        await interaction.editReply(result.posted ? `${result.title} を投稿したよ📝` : `${result.title} の投稿に失敗したよ。ログを確認してね`);
        break;
      }
    }
  } catch (error) {
    console.error(`[COMMAND] ${interaction.commandName} error`, error);
    const content = "ごめんね、エラーになっちゃった🥺";
    if (interaction.deferred || interaction.replied) await interaction.editReply(content).catch(() => {});
    else await interaction.reply({ content, ephemeral: true }).catch(() => {});
  }
}

// ──────────────────────────────────────────────────────────
// アップデート告知（新バージョンで一度だけ）
// ──────────────────────────────────────────────────────────
export async function announceUpdateIfNeeded() {
  const state = readJson<{ lastAnnouncedVersion?: string; channels?: Record<string, string> }>(ANNOUNCE_STATE_PATH, {});
  if (state.lastAnnouncedVersion === CURRENT_VERSION) return;

  const content = formatAnnouncement(CHANGELOG[0]);
  const posted: Record<string, string> = {};
  const targetChannelIds = CHANGELOG[0].pictorchanOnly ? [PICTORCHAN_CHANNEL_ID] : [PICTORCHAN_CHANNEL_ID, ANNOUNCE_CHANNEL_ID];
  for (const channelId of targetChannelIds) {
    // 再起動時に片方だけ投稿済みなら二重投稿しない
    if (state.channels?.[channelId] === CURRENT_VERSION) {
      posted[channelId] = CURRENT_VERSION;
      continue;
    }
    try {
      await sendMessage(channelId, { content, allowedMentions: { parse: [] } });
      posted[channelId] = CURRENT_VERSION;
      console.log(`[ANNOUNCE] v${CURRENT_VERSION} posted to ${channelId}`);
    } catch (error) {
      console.error(`[ANNOUNCE] failed to post to ${channelId}`, error);
    }
  }
  const allPosted = targetChannelIds.every((channelId) => posted[channelId] === CURRENT_VERSION);
  writeJsonAtomic(ANNOUNCE_STATE_PATH, {
    lastAnnouncedVersion: allPosted ? CURRENT_VERSION : state.lastAnnouncedVersion,
    channels: { ...(state.channels ?? {}), ...posted },
  });
}

/** 毎日 00:00(JST) に前日の日記。取りこぼし防止で 15 分ごとにも確認（毎分の cron から呼ぶ） */
export async function runSchedules(now = new Date()) {
  if (now.getUTCMinutes() % 15 === 0) await postDiary().catch(() => {});
}

// ──────────────────────────────────────────────────────────
// Gateway のイベント
// ──────────────────────────────────────────────────────────
export function dispatch(type: string, d: any): Promise<unknown> | void {
  switch (type) {
    case "READY":
      cache.botId = d.user.id;
      cache.botUser = d.user;
      return;
    case "GUILD_CREATE":
      cache.guildCreate(d);
      // 自分のロール（権限の計算に使う）が無ければ取りに行く
      if (cache.botId && !cache.guilds.get(d.id)?.members.has(cache.botId)) return cache.getMember(d.id, cache.botId);
      return;
    case "GUILD_UPDATE":
      return cache.guildUpdate(d);
    case "GUILD_ROLE_CREATE":
    case "GUILD_ROLE_UPDATE":
      return cache.roleUpsert(d.guild_id, d.role);
    case "GUILD_ROLE_DELETE":
      return cache.roleDelete(d.guild_id, d.role_id);
    case "GUILD_EMOJIS_UPDATE":
      return cache.emojisUpdate(d.guild_id, d.emojis);
    case "CHANNEL_CREATE":
    case "CHANNEL_UPDATE":
    case "THREAD_CREATE":
    case "THREAD_UPDATE":
      return cache.channelUpsert(d);
    case "CHANNEL_DELETE":
    case "THREAD_DELETE":
      return cache.channelDelete(d.id);
    case "THREAD_LIST_SYNC":
      for (const thread of d.threads ?? []) cache.channelUpsert({ ...thread, guild_id: d.guild_id });
      return;
    case "GUILD_MEMBER_UPDATE":
      return cache.memberUpsert(d.guild_id, d.user.id, d);
    case "GUILD_MEMBER_REMOVE":
      return cache.memberRemove(d.guild_id, d.user.id);
    case "GUILD_MEMBER_ADD":
      cache.memberUpsert(d.guild_id, d.user.id, d);
      welcomeMember(d).catch(() => {});
      // Aipictors と連携済みの人には、参加したらすぐバッジとレベルを付ける
      notifyMemberJoined(d.user.id).catch(() => {});
      return;
    case "MESSAGE_CREATE":
      return onMessageCreate(d).catch((error) => console.error("[MESSAGE] error", error));
    case "MESSAGE_UPDATE":
      if (!d.author || d.author.bot || typeof d.content !== "string") return;
      return serverMessageLog.updateMessage(d.id, d.content);
    case "MESSAGE_DELETE":
      return serverMessageLog.markDeleted(d.id);
    case "INTERACTION_CREATE":
      return onInteractionCreate(d);
  }
}
