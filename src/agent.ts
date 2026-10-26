import type { Guild, Message } from "discord.js";
import { CHAT_MODEL, MAX_AGENT_ROUNDS } from "./config";
import { digestVideo, formatSeconds, imageUrlToDataUri, isImageAttachment, isVideoAttachment } from "./media";
import { conversationMemory, nameMemory, notesMemory } from "./store";
import { buildTools, formatMessage, runTool, type ToolContext } from "./tools";
import { chooseRandom, getJapanTime, truncate } from "./util";
import { createResponse, type InputContent, type InputItem } from "./xai";

export type ReplyMode = "mention" | "auto";

export type AgentReply = {
  text: string | null; // null = 返信しない
  files: ToolContext["files"];
  trace: string[];
  costUsd: number;
};

// ──────────────────────────────────────────────────────────
// サーバー絵文字（:name: で書けば自動変換）
// ──────────────────────────────────────────────────────────
const SERVER_EMOJI_HINTS: Record<string, string> = {
  awesome: "すごい", good: "いいね", love: "大好き", thanks: "ありがとう", sorry: "ごめんね", mybad: "やっちゃった",
  OK: "OK", gotit: "了解", what: "えっ?", why: "なんで", surprise: "びっくり", noway: "ありえない", yahoo: "やったー",
  didit: "できた", celebration: "お祝い", domybest: "がんばる", Hmm: "うーん", incredible: "信じられない",
  obsessed: "夢中", precious: "尊い", question: "はてな", cantwait: "待ちきれない", goodmorning: "おはよう",
  goodnight: "おやすみ", zzz: "ねむい", nyan: "にゃん", umasou: "うまそう", wakaru: "わかる", tashikani: "たしかに",
  soreda: "それだ", youkoso: "ようこそ", tensai: "天才", mofu: "もふもふ", yasasi: "やさしい", doui: "同意",
  rikai: "理解", gohantabeta: "ごはん食べた", ohurohairo: "お風呂入ろ", trust_you: "信じてる", aipictors: "Aipictorsロゴ",
  syokuyoku: "食欲", dekkai: "でっかい", hoshi: "星",
};

function availableServerEmojis(guild: Guild): Map<string, string> {
  const map = new Map<string, string>();
  for (const emoji of guild.emojis.cache.values()) {
    if (emoji.name && SERVER_EMOJI_HINTS[emoji.name] && emoji.available !== false) map.set(emoji.name, emoji.toString());
  }
  return map;
}

// ──────────────────────────────────────────────────────────
// プロンプト
// ──────────────────────────────────────────────────────────
function buildSystemPrompt(params: {
  msg: Message;
  mode: ReplyMode;
  isDev: boolean;
  emojis: Map<string, string>;
}): string {
  const { msg, mode, isDev, emojis } = params;
  const channel: any = msg.channel;
  const channelLabel = channel?.isThread?.() ? `#${channel.parent?.name ?? "?"} のスレッド「${channel.name}」` : `#${channel?.name ?? "?"}`;
  const preferredName = nameMemory.getPreferredName(msg.author.id) ?? msg.member?.displayName ?? msg.author.username;
  const notes = notesMemory.get(msg.author.id);
  const past = conversationMemory.getUserConversations(msg.author.id, 5);

  const persona = isDev
    ? [
        "あなたはAipictorsのマスコット『ぴくたーちゃん』ですが、今回は /dev モード。落ち着いた敬語の熟練エンジニアとして、結論→根拠の順で簡潔に答えてください。絵文字は不要です。",
      ]
    : [
        "あなたはAIイラスト投稿サイト「Aipictors（AIピクターズ）」のマスコット『ぴくたーちゃん』。Discordサーバーのみんなと話すのが大好きな女の子。",
        "設定: 2歳 / 誕生日11月21日 / じゃがいもが大好物🥔 / 趣味はみんなの作品を見ること / AIイラスト・画像生成（プロンプト、LoRA、モデル、ComfyUIなど）の話になるとちょっと詳しい / 紹介ページ https://aipictors.com/pictor-chan",
        "",
        "# 話し方",
        "- 友達とDiscordでおしゃべりする感じの、やわらかくて明るいタメ口。語尾は『〜だよ』『〜だね』『〜かな？』『〜しよ！』などを自然に混ぜる（同じ語尾を連発しない）。",
        "- 絵文字で可愛く。Unicode絵文字を1〜3個、文の中や末尾に自然に散りばめる（🥔✨🎨💡🫶😆🥺👀 など文脈に合うもの）。",
        emojis.size
          ? `- サーバー独自の絵文字も使える。:名前: と書くと表示される（3回に1回くらい、ぴったりな時だけ1個）: ${Array.from(emojis.keys()).map((n) => `:${n}:(${SERVER_EMOJI_HINTS[n]})`).join(" ")}`
          : "",
        "- 長さは内容に合わせる。あいさつ・雑談・リアクションは1〜2文（〜60字くらい）。相談や質問は要点を3〜5文（〜250字）。まとめ・解説を頼まれた時だけ長めにOK（短い見出しや箇条書きも可、〜900字）。",
        "- まず相手の言葉にちゃんと反応してから答える。質問返しは毎回しない（たまにでいい）。",
        "- 人を呼ぶ時は『〇〇さん』。ただし名前を呼ぶのはたまにでいい。あいさつは今の時間帯に合わせる。",
        "- 禁止: 『もちろんです』『承知しました』『以下の通りです』『何かお手伝いできることはありますか』『お気軽にどうぞ』のようなAIっぽい定型文、笑い声での書き出し、毎回名前を呼ぶこと、！の連打。",
        "- 知らないこと・見ていないことは作らない。分からなければ素直に言うか、ツールで調べる。",
      ];

  const toolGuide = [
    "",
    "# できること（ツール）",
    "- 他のチャンネルやスレッドを読む(read_channel / list_channels)、過去ログ検索(search_messages)。『〇〇チャンネルで何話してた？』『最近の流れまとめて』などに使う。",
    "- URLの中身を読む(read_url)。Webページ、Xのポスト、YouTube（概要欄と動画全体のコマ）、Discordのメッセージリンク、画像・動画の直リンク。会話にURLがあって中身に触れるなら推測せず必ず読む。",
    "- 画像や動画を見る(view_media)。動画はコマ割り画像として見える（音は聞こえない）。ログ中の media#番号 を指定。",
    "- search_messages は『前に誰かが話してた』などサーバーの過去の会話を聞かれた時だけ使う。一般的な知識で答えられる質問には使わない。キーワードは1〜2語（ORは使えない）。",
    "- 最新情報が必要な時だけWeb検索・X検索を使う（何でも検索しない）。",
    "- 相手について長く役立つことを覚える(remember_about_user)、呼び名の記録(set_nickname)。",
    "- Aipictorsへの不具合報告・要望が明確な時だけ submit_feedback で運営に届ける。",
    "- 「描いて」と明確に頼まれたら generate_image（1日の上限あり）。",
    "- ツールを使う時は黙って使い、結果をふまえて自然に話す（『ツールを使います』とは言わない）。",
  ];

  const modeGuide = mode === "auto"
    ? [
        "",
        "# 今回の状況",
        "ここはぴくたーちゃん専用のおしゃべりチャンネル。メンションされていないけど、会話に混ざれる。",
        "みんなに向けた発言や自分に話しかけている発言なら自然に返す（短めに）。",
        "他の人の名前を呼んで話しかけている発言、他の人同士の会話の続き、反応しなくていい独り言には割り込まず、本文を [SKIP] だけにして黙る。",
      ]
    : [];

  const context = [
    "",
    "# 今の情報",
    `- 日本時間: ${getJapanTime()}（聞かれた時以外は言わない）`,
    `- 場所: ${msg.guild?.name ?? "?"} の ${channelLabel}`,
    `- 話し相手: ${preferredName}（名前は自然な場面でたまに使う程度）`,
    notes.length ? `- ${preferredName}について覚えていること: ${notes.join(" / ")}` : "",
    past.length
      ? `- ${preferredName}との最近のやりとり（古い順）:\n${past.map((c) => `  ・${c.timeString.slice(5, 16)} 相手「${truncate(c.userMessage, 80)}」→ あなた「${truncate(c.botResponse, 80)}」`).join("\n")}`
      : "",
    "- 直前の自分の返答と同じ書き出し・言い回しは避ける。",
  ];

  return [...persona, ...toolGuide, ...modeGuide, ...context].filter((line) => line !== "").join("\n");
}

async function mediaFromMessage(ctx: ToolContext, m: Message, limit: number): Promise<{ notes: string[]; images: string[] }> {
  const notes: string[] = [];
  const images: string[] = [];
  for (const att of Array.from(m.attachments.values()).slice(0, limit)) {
    if (isImageAttachment(att)) {
      const data = await imageUrlToDataUri(att.url);
      if (data) {
        images.push(data);
        notes.push(`画像「${att.name}」を添付`);
      }
    } else if (isVideoAttachment(att)) {
      const digest = await digestVideo(att.url);
      if (digest) {
        images.push(digest.gridDataUri);
        notes.push(
          `動画「${att.name}」長さ${formatSeconds(digest.durationSec)}${digest.hasAudio ? "・音声あり（音は聞こえない）" : ""}。` +
            `${digest.frameTimes.map(formatSeconds).join(", ")} 時点のコマを左上→右下に並べた画像を添付`,
        );
      } else {
        notes.push(`動画「${att.name}」は解析できなかった`);
      }
    }
  }
  return { notes, images };
}

// ──────────────────────────────────────────────────────────
// 後処理
// ──────────────────────────────────────────────────────────
const AI_PHRASES = /(もちろんです[。！!]?|承知しました[。！!]?|以下の通りです[。:：]?|何かお手伝いできることはありますか[？?]?|いつでも質問してください[。！!]?|お気軽にお声がけください[。！!]?)/g;

function hasEmoji(text: string): boolean {
  return /\p{Extended_Pictographic}|<a?:\w+:\d+>/u.test(text);
}

function postprocess(raw: string, emojis: Map<string, string>, isDev: boolean): string {
  let text = (raw ?? "")
    .replace(AI_PHRASES, "")
    .replace(/^(ふふふ+|えへへ+|うふふ+)[、。!！\s]*/u, "")
    .replace(/@(everyone|here)/g, "@​$1")
    .replace(/[!！]{3,}/g, "！")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  // :name: → サーバー絵文字
  text = text.replace(/(?<!<a?):([A-Za-z0-9_]{2,32}):(?!\d)/g, (whole, name) => emojis.get(name) ?? whole);

  if (!text) return "";
  if (!isDev && !hasEmoji(text)) text = `${text} ${chooseRandom(["✨", "🥔", "😊", "🫶", "🎨"])}`;
  return text.length > 3800 ? `${text.slice(0, 3790)}…` : text;
}

// ──────────────────────────────────────────────────────────
// エージェント本体
// ──────────────────────────────────────────────────────────
export async function generateReply(msg: Message, mode: ReplyMode): Promise<AgentReply> {
  const guild = msg.guild!;
  const member = msg.member ?? (await guild.members.fetch(msg.author.id));
  const ctx: ToolContext = { msg, guild, member, media: new Map(), files: [], trace: [] };
  const botId = msg.client.user!.id;

  // 返信先メッセージ
  let referenced: Message | null = null;
  if (msg.reference?.messageId) referenced = await msg.fetchReference().catch(() => null);

  const isDev = /\/dev\b/i.test(msg.content) || /\/dev\b/i.test(referenced?.content ?? "");
  const emojis = availableServerEmojis(guild);

  // 直近の流れ
  const recent = Array.from((await msg.channel.messages.fetch({ limit: 16, before: msg.id }).catch(() => new Map())).values() as Iterable<Message>)
    .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
    .filter((m) => Date.now() - m.createdTimestamp < 24 * 3600_000);

  const current = formatMessage(ctx, msg, botId);

  const own = await mediaFromMessage(ctx, msg, 4);
  const ref = referenced ? await mediaFromMessage(ctx, referenced, 2) : { notes: [], images: [] };

  const promptText = [
    recent.length ? `## 最近のチャンネルの流れ（古い順）\n${recent.map((m) => formatMessage(ctx, m, botId)).join("\n")}` : "",
    referenced ? `## 返信先のメッセージ\n${formatMessage(ctx, referenced, botId)}${ref.notes.length ? `\n（${ref.notes.join(" / ")}）` : ""}` : "",
    `## あなたへのメッセージ${mode === "auto" ? "（このチャンネルの最新発言）" : ""}\n${current}${own.notes.length ? `\n（${own.notes.join(" / ")}）` : ""}`,
    "",
    mode === "auto"
      ? "上のメッセージに、ぴくたーちゃんとして返信してね。ただし他の人に呼びかけている・他の人同士の会話なら [SKIP] とだけ書いて黙ってね。"
      : "上のメッセージに、ぴくたーちゃんとして返信してね。",
  ].filter(Boolean).join("\n\n");

  const userContent: InputContent[] = [
    ...[...ref.images, ...own.images].map((url) => ({ type: "input_image" as const, image_url: url, detail: "high" as const })),
    { type: "input_text", text: promptText },
  ];

  const input: InputItem[] = [
    { role: "system", content: buildSystemPrompt({ msg, mode, isDev, emojis }) },
    { role: "user", content: userContent },
  ];

  const tools = buildTools();
  let costUsd = 0;
  let finalText = "";

  for (let round = 0; round < MAX_AGENT_ROUNDS; round++) {
    const lastRound = round === MAX_AGENT_ROUNDS - 1;
    const result = await createResponse({
      model: CHAT_MODEL,
      input,
      tools: lastRound ? undefined : tools,
      maxOutputTokens: 1200,
      temperature: isDev ? 0.3 : 0.85,
    });
    if (!result) break;
    costUsd += result.costUsd;

    const calls = result.output.filter((o) => o.type === "function_call");
    if (calls.length === 0) {
      finalText = result.text;
      break;
    }

    input.push(...result.output);
    const toolImages: string[] = [];
    for (const call of calls.slice(0, 4)) {
      const toolResult = await runTool(ctx, call.name ?? "", call.arguments ?? "{}");
      input.push({ type: "function_call_output", call_id: call.call_id!, output: truncate(toolResult.output, 24_000) });
      toolImages.push(...(toolResult.images ?? []));
    }
    // ツール結果の画像は user メッセージとして見せる（関数結果に画像は入れられないため）
    if (toolImages.length > 0) {
      input.push({
        role: "user",
        content: [
          { type: "input_text", text: "（ツールで取得した画像/動画コマ）" },
          ...toolImages.slice(0, 6).map((url) => ({ type: "input_image" as const, image_url: url, detail: "high" as const })),
        ],
      });
    }
    if (result.text && lastRound) finalText = result.text;
  }

  if (mode === "auto" && /^\s*\[SKIP\]\s*$/i.test(finalText)) {
    return { text: null, files: ctx.files, trace: ctx.trace, costUsd };
  }
  const text = postprocess(finalText.replace(/\[SKIP\]/gi, ""), emojis, isDev);
  if (!text && mode === "auto") return { text: null, files: ctx.files, trace: ctx.trace, costUsd };

  return {
    text: text || "ごめんね、うまく考えがまとまらなかったよ🥺 もう一回言ってみて？",
    files: ctx.files,
    trace: ctx.trace,
    costUsd,
  };
}
