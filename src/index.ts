// src/index.ts
//--------------------------------------------------------------------
// Discord “ぴくたーちゃん” Bot 2.0（Fly.io）
//   ✓ ツール呼び出し型の会話エージェント（他チャンネル参照・リンク/動画閲覧・検索）
//   ✓ /checkimage /gacha /iken /huguai /diary ほか
//   ✓ 新規メンバー歓迎・毎日の日記・アップデート告知
//--------------------------------------------------------------------
import {
  AttachmentBuilder,
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type Message,
} from "discord.js";
import cron from "node-cron";
import { generateReply, type ReplyMode } from "./agent";
import { CHANGELOG, CURRENT_VERSION, formatAnnouncement } from "./changelog";
import {
  ANNOUNCE_CHANNEL_ID,
  ANNOUNCE_STATE_PATH,
  CLIENT_ID,
  DISCORD_TOKEN,
  GROK_API_KEY,
  MAX_IMAGE_BYTES,
  NO_INTERACT_CHANNEL_IDS,
  PICTORCHAN_CHANNEL_ID,
  USER_REQUESTS_PER_MINUTE,
  VISION_MODEL,
} from "./config";
import { parseDiaryDateInput, postDiary } from "./diary";
import { organizeAndPostFeedback, setFeedbackClient } from "./feedback";
import { imageUrlToDataUri } from "./media";
import { conversationMemory, nameMemory, notesMemory, serverMessageLog } from "./store";
import { flushAllPending, getJapanNow, japanDateKey, readJson, splitForDiscord, truncate, writeJsonAtomic } from "./util";
import { welcomeMember } from "./welcome";
import { visionText } from "./xai";

if (!DISCORD_TOKEN || !GROK_API_KEY) {
  console.error("[BOT] DISCORD_TOKEN と GROK_API_KEY は必須です。");
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildEmojisAndStickers,
  ],
  partials: [Partials.Message],
  allowedMentions: { parse: [], repliedUser: true },
});
setFeedbackClient(client);

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

function ndnDice(expr: string): string {
  const [nStr, dStr] = expr.toLowerCase().split("d");
  const n = Math.min(parseInt(nStr, 10), 100);
  const d = Math.min(parseInt(dStr, 10), 1000);
  if (isNaN(n) || isNaN(d) || n < 1 || d < 2) return "ダイス表記が変だよ…🎲";
  const rolls = Array.from({ length: n }, () => 1 + Math.floor(Math.random() * d));
  return `🎲 [${expr}] → ${rolls.reduce((a, b) => a + b)}  ( ${rolls.join(",")} )`;
}

function isAutoReplyCandidate(content: string, msg: Message): boolean {
  const text = (content ?? "").trim();
  // 他の人への返信・呼びかけには割り込まない
  if (msg.reference?.messageId && msg.mentions.repliedUser && msg.mentions.repliedUser.id !== client.user!.id) return false;
  const addressed = text.match(/^([^\s、,。!！?？]{1,15}?)(さん|ちゃん|くん|君|氏|様)[、,!！\s]/);
  if (addressed && !/ぴくたー|ピクター|pictor/i.test(addressed[1])) return false;
  if (msg.attachments.size > 0) return true;
  if (text.length < 2) return false;
  if (/^<a?:\w+:\d+>$/.test(text)) return false;
  if (/^[\p{Extended_Pictographic}\s]+$/u.test(text)) return false;
  return true;
}

// ──────────────────────────────────────────────────────────
// メッセージ
// ──────────────────────────────────────────────────────────
client.on("messageCreate", async (msg: Message) => {
  if (msg.author.bot || !msg.guild) return;

  serverMessageLog.addMessage(msg);
  nameMemory.observe(msg.author.id, msg.member?.displayName ?? msg.author.displayName ?? msg.author.username, msg.content);

  if (NO_INTERACT_CHANNEL_IDS.has(msg.channel.id)) return;

  const botId = client.user!.id;
  const isMentioned =
    msg.mentions.users.has(botId) ||
    msg.mentions.repliedUser?.id === botId ||
    new RegExp(`<@!?${botId}>|@ぴくたーちゃん|@pictorchan`, "i").test(msg.content);

  // 他人宛てのメンションだけなら反応しない
  if (!isMentioned && msg.mentions.users.size > 0) return;

  if (/^\d+d\d+$/i.test(msg.content.trim())) {
    await msg.reply(ndnDice(msg.content.trim())).catch(() => {});
    return;
  }

  const isAutoChannel = msg.channel.id === PICTORCHAN_CHANNEL_ID;
  const mode: ReplyMode | null = isMentioned ? "mention" : isAutoChannel && isAutoReplyCandidate(msg.content, msg) ? "auto" : null;
  if (!mode) return;

  if (/^(<@!?\d+>\s*)?(にゃん|にゃーん|にゃ～ん)[!！。]*$/.test(msg.content.trim())) {
    await msg.reply("にゃ～ん🐱").catch(() => {});
    return;
  }

  if (!allowRequest(msg.author.id)) {
    if (mode === "mention") await msg.react("⏳").catch(() => {});
    return;
  }
  if (mode === "auto") {
    if (busyAutoChannels.has(msg.channel.id)) return;
    busyAutoChannels.add(msg.channel.id);
  }

  const channel: any = msg.channel;
  channel.sendTyping?.().catch(() => {});
  const typing = setInterval(() => channel.sendTyping?.().catch(() => {}), 8_000);
  const startedAt = Date.now();

  try {
    const reply = await generateReply(msg, mode);
    console.log(
      `[REPLY] ${mode} ch=${channel.name} user=${msg.author.id} ${Date.now() - startedAt}ms $${reply.costUsd.toFixed(4)} tools=[${reply.trace.join(", ")}] skip=${reply.text === null}`,
    );
    if (reply.text === null) return;

    const chunks = splitForDiscord(reply.text, 1900);
    const files = reply.files.length ? reply.files : undefined;
    const stillLatest = channel.lastMessageId === msg.id;
    if (mode === "auto" && stillLatest && !files) {
      await channel.send({ content: chunks[0] });
    } else {
      await msg.reply({ content: chunks[0], files });
    }
    for (const chunk of chunks.slice(1)) await channel.send({ content: chunk });

    const userText = msg.content.replace(new RegExp(`<@!?${botId}>`, "g"), "").trim() || "(添付のみ)";
    conversationMemory.addConversation(
      msg.author.id,
      msg.channel.id,
      msg.member?.displayName ?? msg.author.username,
      truncate(userText, 500),
      truncate(reply.text, 500),
    );
  } catch (error) {
    console.error("[REPLY] error", error);
    if (mode === "mention") await msg.reply("ごめんね、ちょっと調子が悪いみたい🥺 少ししてからもう一回話しかけてね").catch(() => {});
  } finally {
    clearInterval(typing);
    busyAutoChannels.delete(msg.channel.id);
  }
});

client.on("messageUpdate", async (_old, updated) => {
  if (updated.partial || !updated.author || updated.author.bot) return;
  serverMessageLog.updateMessage(updated.id, updated.content ?? "");
});

client.on("messageDelete", async (msg) => {
  serverMessageLog.markDeleted(msg.id);
});

client.on("guildMemberAdd", (member) => {
  welcomeMember(client, member).catch(() => {});
});

// ──────────────────────────────────────────────────────────
// スラッシュコマンド
// ──────────────────────────────────────────────────────────
const commands = [
  new SlashCommandBuilder().setName("help").setDescription("ぴくたーちゃんにできることを表示します"),
  new SlashCommandBuilder()
    .setName("checkimage")
    .setDescription("画像の破綻箇所を指摘します")
    .addAttachmentOption((o) => o.setName("image").setDescription("チェックする画像").setRequired(true)),
  new SlashCommandBuilder().setName("gacha").setDescription("ガチャを引くよ～"),
  new SlashCommandBuilder()
    .setName("iken")
    .setDescription("Aipictorsへの意見を投稿します")
    .addStringOption((o) => o.setName("content").setDescription("意見の内容").setRequired(true)),
  new SlashCommandBuilder()
    .setName("huguai")
    .setDescription("Aipictorsの不具合を報告します")
    .addStringOption((o) => o.setName("content").setDescription("不具合の内容").setRequired(true)),
  new SlashCommandBuilder().setName("forget").setDescription("あなたとの会話履歴と覚え書きを消去します"),
  new SlashCommandBuilder().setName("forget_channel").setDescription("このチャンネルの会話履歴を消去します"),
  new SlashCommandBuilder()
    .setName("myname")
    .setDescription("ぴくたーちゃんに呼んでほしい名前を教えます")
    .addStringOption((o) => o.setName("name").setDescription("呼び名（20文字以内）").setRequired(true)),
  new SlashCommandBuilder().setName("forget_name").setDescription("あなたの呼び名を忘れます"),
  new SlashCommandBuilder().setName("namelist").setDescription("覚えている人の一覧を表示します"),
  new SlashCommandBuilder()
    .setName("diary")
    .setDescription("指定日のぴくたーちゃん日記を投稿します")
    .addStringOption((o) => o.setName("date").setDescription("対象日。例: 2026-03-28 または 03.28").setRequired(true)),
];

async function registerCommands() {
  if (!CLIENT_ID) return console.warn("[BOT] CLIENT_ID が無いので SlashCommand は登録しません");
  try {
    await new REST({ version: "10" }).setToken(DISCORD_TOKEN!).put(Routes.applicationCommands(CLIENT_ID), {
      body: commands.map((c) => c.toJSON()),
    });
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
  "- **コマンド**: /checkimage /gacha /iken /huguai /myname /forget /namelist /diary",
  `-# v${CURRENT_VERSION}`,
].join("\n");

async function handleCheckImage(interaction: ChatInputCommandInteraction) {
  const image = interaction.options.getAttachment("image", true);
  if (image.size > MAX_IMAGE_BYTES) {
    await interaction.reply(`画像は ${MAX_IMAGE_BYTES / 1024 / 1024}MB 以下にしてね🙏`);
    return;
  }
  await interaction.deferReply();
  const dataUri = await imageUrlToDataUri(image.url);
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
  await interaction.editReply({
    content: first,
    files: [new AttachmentBuilder(Buffer.from(dataUri.split(",")[1], "base64"), { name: "image.jpg" })],
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

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
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
          interaction.options.getString("content", true),
          `${interaction.user.tag} (${interaction.user.id})`,
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
        const name = interaction.options.getString("name", true);
        if (name.length > 20) {
          await interaction.reply({ content: "名前は20文字以内にしてね🙏", ephemeral: true });
          break;
        }
        nameMemory.setPreferredName(interaction.user.id, interaction.user.displayName ?? interaction.user.username, name);
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
      case "diary": {
        const targetDate = parseDiaryDateInput(interaction.options.getString("date", true));
        if (!targetDate) {
          await interaction.reply("日付の形式が違うみたい。例: 2026-03-28 または 03.28");
          break;
        }
        if (japanDateKey(targetDate) > japanDateKey(getJapanNow())) {
          await interaction.reply("未来の日記はまだ書けないよ🔮");
          break;
        }
        await interaction.deferReply();
        const result = await postDiary(client, { targetDate, skipStateCheck: true, updateState: false });
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
});

// ──────────────────────────────────────────────────────────
// アップデート告知（新バージョンで一度だけ）
// ──────────────────────────────────────────────────────────
async function announceUpdateIfNeeded() {
  const state = readJson<{ lastAnnouncedVersion?: string; channels?: Record<string, string> }>(ANNOUNCE_STATE_PATH, {});
  if (state.lastAnnouncedVersion === CURRENT_VERSION) return;

  const content = formatAnnouncement(CHANGELOG[0]);
  const posted: Record<string, string> = {};
  for (const channelId of [PICTORCHAN_CHANNEL_ID, ANNOUNCE_CHANNEL_ID]) {
    // 再起動時に片方だけ投稿済みなら二重投稿しない
    if (state.channels?.[channelId] === CURRENT_VERSION) {
      posted[channelId] = CURRENT_VERSION;
      continue;
    }
    try {
      const channel: any = await client.channels.fetch(channelId);
      await channel.send({ content, allowedMentions: { parse: [] } });
      posted[channelId] = CURRENT_VERSION;
      console.log(`[ANNOUNCE] v${CURRENT_VERSION} posted to ${channelId}`);
    } catch (error) {
      console.error(`[ANNOUNCE] failed to post to ${channelId}`, error);
    }
  }
  const allPosted = Object.keys(posted).length === 2;
  writeJsonAtomic(ANNOUNCE_STATE_PATH, {
    lastAnnouncedVersion: allPosted ? CURRENT_VERSION : state.lastAnnouncedVersion,
    channels: { ...(state.channels ?? {}), ...posted },
  });
}

// ──────────────────────────────────────────────────────────
// 起動
// ──────────────────────────────────────────────────────────
client.once("clientReady", async () => {
  console.log(`[BOT] Logged in as ${client.user?.tag} (v${CURRENT_VERSION})`);
  await registerCommands();
  for (const guild of client.guilds.cache.values()) await guild.emojis.fetch().catch(() => {});

  // 毎日00:00(JST)に前日の日記。取りこぼし防止で15分ごとにも確認
  cron.schedule("0 0 * * *", () => postDiary(client).catch(() => {}), { timezone: "Asia/Tokyo" });
  cron.schedule("*/15 * * * *", () => postDiary(client).catch(() => {}), { timezone: "Asia/Tokyo" });
  postDiary(client).catch(() => {});

  announceUpdateIfNeeded().catch((error) => console.error("[ANNOUNCE] error", error));
});

function shutdown(signal: string) {
  console.log(`[BOT] ${signal} received, flushing data...`);
  flushAllPending();
  client.destroy().finally(() => process.exit(0));
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("unhandledRejection", (error) => console.error("[BOT] unhandledRejection", error));

client.login(DISCORD_TOKEN).catch((error) => {
  console.error("[LOGIN ERROR]", error);
  process.exit(1);
});
