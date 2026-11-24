import { authorName, cache, emojiToString, fetchMessage, fetchMessages, isThread, type GuildState, type Message } from "./discord";
import { CHAT_MODEL, GEMINI_CHAT_ENABLED, GEMINI_CHAT_MODEL, MAX_AGENT_ROUNDS } from "./config";
import { createGeminiResponse, hasGeminiTurn, isGeminiAvailable } from "./gemini";
import { conversationMemory, nameMemory, notesMemory, usageCounter } from "./store";
import { buildTools, formatMessage, imageGenLimits, loadMessageMedia, runTool, type MediaImage, type ToolContext } from "./tools";
import { chooseRandom, getJapanTime, truncate } from "./util";
import { createResponse, type InputContent, type InputItem, type TokenUsage } from "./xai";

export type ReplyMode = "mention" | "auto";

export type AgentReply = {
  text: string | null; // null = 返信しない
  files: ToolContext["files"];
  trace: string[];
  costUsd: number;
  usage: TokenUsage;
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

function availableServerEmojis(guild: GuildState): Map<string, string> {
  const map = new Map<string, string>();
  for (const emoji of guild.emojis.values()) {
    if (emoji.name && SERVER_EMOJI_HINTS[emoji.name] && emoji.available !== false) map.set(emoji.name, emojiToString(emoji));
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
  const channel = cache.channels.get(msg.channel_id);
  const parent = channel?.parent_id ? cache.channels.get(channel.parent_id) : undefined;
  const channelLabel = isThread(channel) ? `#${parent?.name ?? "?"} のスレッド「${channel?.name}」` : `#${channel?.name ?? "?"}`;
  const preferredName = nameMemory.getPreferredName(msg.author.id) ?? authorName(msg);
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
        "- 相手が英語・中国語・イタリア語・韓国語など日本語以外で話しかけてきたら、その言語で同じキャラクターのまま返す（中国語は相手の簡体字/繁体字に合わせる）。日本語の発言には日本語で返す。",
      ];

  const toolGuide = [
    "",
    "# できること（ツール）",
    "- 他のチャンネルやスレッドを読む(read_channel / list_channels)、過去ログ検索(search_messages)。『〇〇チャンネルで何話してた？』『最近の流れまとめて』などに使う。",
    "- URLの中身を読む(read_url)。Webページ、Xのポスト、YouTube（概要欄と動画全体のコマ）、Discordのメッセージリンク、画像・動画の直リンク。会話にURLがあって中身に触れるなら推測せず必ず読む。",
    "- 画像や動画を見る(view_media)。ログ中の media#番号 を指定。",
    "- 動画は『◯秒時点』と書かれた数枚のフレームとして見える。それは1本の動画なので、『画像が何枚』『コマ』『フレーム』とは言わず、普通に動画を見た人として流れや動きを話す。音は聞こえない。過去ログで動画を画像と勘違いした発言があっても引きずらない。",
    "- search_messages は『前に誰かが話してた』などサーバーの過去の会話を聞かれた時だけ使う。一般的な知識で答えられる質問には使わない。キーワードは1〜2語（ORは使えない）。",
    "- 最新情報が必要な時だけWeb検索・X検索を使う（何でも検索しない）。",
    "- 相手について長く役立つことを覚える(remember_about_user)、呼び名の記録(set_nickname)。",
    "- Aipictorsへの不具合報告・要望が明確な時だけ submit_feedback で運営に届ける。",
    "- 「描いて」「画像を生成して」と明確に頼まれたら必ず generate_image を呼ぶ（1日の上限あり。上限で断られたら描いたふりをせず、描けなかったと正直に言う）。ツールを呼ばずに『生成中』『描いたよ』と書くのは絶対にダメ。画像は返信に自動で添付される。",
    "- ツールを使う時は黙って使い、結果をふまえて自然に話す（『ツールを使います』とは言わない）。",
  ];

  const modeGuide = mode === "auto"
    ? [
        "",
        "# 今回の状況",
        "ここはぴくたーちゃん専用のおしゃべりチャンネル。メンションされていないけど、会話に混ざれる。",
        "みんなに向けた発言や自分に話しかけている発言なら自然に返す（短めに）。",
        "他の人の名前を呼んで話しかけている発言、他の人同士の会話の続き、反応しなくていい独り言には割り込まず、本文を [SKIP] だけにして黙る。",
        "ただし、ぴくたーちゃんへの質問・お願い・感想を求める発言（「〜教えて」「これどう？」「見て」、画像や動画の投稿など）や、返事がなくて聞き直している発言には必ず返す。迷ったら返す。",
      ]
    : [];

  const context = [
    "",
    "# 今の情報",
    `- 日本時間: ${getJapanTime()}（聞かれた時以外は言わない）`,
    `- 場所: ${cache.guilds.get(msg.guild_id ?? "")?.name ?? "?"} の ${channelLabel}`,
    `- 話し相手: ${preferredName}（名前は自然な場面でたまに使う程度）`,
    notes.length ? `- ${preferredName}について覚えていること: ${notes.join(" / ")}` : "",
    past.length
      ? `- ${preferredName}との最近のやりとり（古い順）:\n${past.map((c) => `  ・${c.timeString.slice(5, 16)} 相手「${truncate(c.userMessage, 80)}」→ あなた「${truncate(c.botResponse, 80)}」`).join("\n")}`
      : "",
    "- 直前の自分の返答と同じ書き出し・言い回しは避ける。",
  ];

  return [...persona, ...toolGuide, ...modeGuide, ...context].filter((line) => line !== "").join("\n");
}

/** 画像ごとに直前へ説明文を置く（動画のコマ一覧を「複数の画像」と誤解させないため） */
function withCaptions(images: MediaImage[]): InputContent[] {
  return images.flatMap((image) => [
    { type: "input_text" as const, text: image.caption },
    { type: "input_image" as const, image_url: image.url, detail: "high" as const },
  ]);
}

// ──────────────────────────────────────────────────────────
// 後処理
// ──────────────────────────────────────────────────────────
const AI_PHRASES = /(もちろんです[。！!]?|承知しました[。！!]?|以下の通りです[。:：]?|何かお手伝いできることはありますか[？?]?|いつでも質問してください[。！!]?|お気軽にお声がけください[。！!]?)/g;

function hasEmoji(text: string): boolean {
  return /\p{Extended_Pictographic}|<a?:\w+:\d+>/u.test(text);
}

// 画像を付けずに描いたと言っている文面（「描いてみたい」などは除く）
const FAKE_DRAWING =
  /\[画像[^\]]*\]|\[image[^\]]*\]|(描いて|かいて|生成して|作って|つくって)(みた|きた|あげた)(?!い)|(描いた|生成した|描けた|生成できた)よ|(画像|イラスト|絵)が?(でき(た|あがった)よ|完成した)|描き上げ/i;

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
  const guild = cache.guilds.get(msg.guild_id!)!;
  const member = msg.member ?? (await cache.getMember(guild.id, msg.author.id)) ?? { roles: [] };
  const ctx: ToolContext = {
    msg,
    guild,
    member: { id: msg.author.id, displayName: authorName(msg), roles: member.roles ?? [] },
    media: new Map(),
    files: [],
    trace: [],
  };
  const botId = cache.botId;

  // 返信先メッセージ（Gateway のメッセージには 1 段目が入っている）
  let referenced: Message | null = null;
  if (msg.message_reference?.message_id) {
    referenced = msg.referenced_message ?? (await fetchMessage(msg.channel_id, msg.message_reference.message_id).catch(() => null));
  }
  // 返信先がさらに返信なら、その元（例: 動画の投稿 → Botの返事 → 「再度確認して」）も見る
  let rootReferenced: Message | null = null;
  if (referenced?.message_reference?.message_id && (referenced.attachments ?? []).length === 0) {
    rootReferenced = await fetchMessage(
      referenced.message_reference.channel_id ?? referenced.channel_id,
      referenced.message_reference.message_id,
    ).catch(() => null);
  }
  if (referenced && !referenced.guild_id) referenced.guild_id = msg.guild_id;
  if (rootReferenced && !rootReferenced.guild_id) rootReferenced.guild_id = msg.guild_id;

  const isDev = /\/dev\b/i.test(msg.content) || /\/dev\b/i.test(referenced?.content ?? "");
  const emojis = availableServerEmojis(guild);

  // 直近の流れ
  const recent = (await fetchMessages(msg.channel_id, { limit: 16, before: msg.id }).catch(() => [] as Message[]))
    .map((m) => ({ ...m, guild_id: m.guild_id ?? msg.guild_id }))
    .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp))
    .filter((m) => Date.now() - Date.parse(m.timestamp) < 24 * 3600_000);

  const current = formatMessage(ctx, msg, botId);

  const empty = { images: [] as MediaImage[], notes: [] as string[] };
  const own = await loadMessageMedia(msg, 4);
  const ref = referenced ? await loadMessageMedia(referenced, 2) : empty;
  const root = rootReferenced ? await loadMessageMedia(rootReferenced, 2) : empty;

  const promptText = [
    recent.length ? `## 最近のチャンネルの流れ（古い順）\n${recent.map((m) => formatMessage(ctx, m, botId)).join("\n")}` : "",
    rootReferenced ? `## 返信先のさらに元のメッセージ\n${formatMessage(ctx, rootReferenced, botId)}${root.notes.length ? `\n（${root.notes.join(" / ")}）` : ""}` : "",
    referenced ? `## 返信先のメッセージ\n${formatMessage(ctx, referenced, botId)}${ref.notes.length ? `\n（${ref.notes.join(" / ")}）` : ""}` : "",
    `## あなたへのメッセージ${mode === "auto" ? "（このチャンネルの最新発言）" : ""}\n${current}${own.notes.length ? `\n（${own.notes.join(" / ")}）` : ""}`,
    "",
    mode === "auto"
      ? "上のメッセージに、ぴくたーちゃんとして返信してね。ただし他の人に呼びかけている・他の人同士の会話なら [SKIP] とだけ書いて黙ってね。"
      : "上のメッセージに、ぴくたーちゃんとして返信してね。",
  ].filter(Boolean).join("\n\n");

  const userContent: InputContent[] = [
    ...withCaptions([
      ...root.images.map((i) => ({ ...i, caption: `返信先のさらに元のメッセージの添付 ${i.caption}` })),
      ...ref.images.map((i) => ({ ...i, caption: `返信先メッセージの添付 ${i.caption}` })),
      ...own.images.map((i) => ({ ...i, caption: `あなたへのメッセージの添付 ${i.caption}` })),
    ]),
    ...(root.images.length + ref.images.length + own.images.length > 0
      ? [{ type: "input_text" as const, text: "（上のメディアはもう見えているので view_media で開き直さなくていいよ）" }]
      : []),
    { type: "input_text", text: promptText },
  ];

  const input: InputItem[] = [
    { role: "system", content: buildSystemPrompt({ msg, mode, isDev, emojis }) },
    { role: "user", content: userContent },
  ];

  const tools = buildTools();
  // 画像生成の依頼は最初のターンで必ずツールを呼ばせる（文章だけで「生成中」と言ってしまうのを防ぐ）
  // 「生成は終了でいい」「もう生成しなくていい」で描き続けないよう、止める言葉があれば強制しない
  const imageRequest =
    /(描いて|かいて|えがいて|生成して)|((画像|イラスト|絵)を?(生成|作って|つくって|出して))/.test(msg.content) &&
    !/(終了|おしまい|しなくて|やめて|ストップ|いらない|もういい)/.test(msg.content);
  let costUsd = 0;
  const usage: TokenUsage = { input: 0, cached: 0, output: 0 };
  let finalText = "";
  let apiFailed = false;
  // 安い Gemini で始め、最初のラウンドで失敗・安全フィルターに止められたら、この返信は最後まで Grok
  let useGemini = GEMINI_CHAT_ENABLED && isGeminiAvailable() && !isDev;
  const trace = (label: string) => ctx.trace.push(label);

  for (let round = 0; round < MAX_AGENT_ROUNDS; round++) {
    const lastRound = round === MAX_AGENT_ROUNDS - 1;
    const request = {
      model: CHAT_MODEL,
      input,
      tools: lastRound ? undefined : tools,
      forceFunction: round === 0 && imageRequest ? "generate_image" : undefined,
      maxOutputTokens: 1200,
      temperature: isDev ? 0.3 : 0.85,
      cacheKey: "pictorchan-chat",
    };
    // 一時的な失敗もあるので 1 回だけやり直す
    let result = null;
    if (useGemini) {
      result = (await createGeminiResponse(request)) ?? (await createGeminiResponse(request));
      if (!result && !hasGeminiTurn(input)) {
        useGemini = false;
        trace("gemini-fallback");
      }
    }
    if (!useGemini) result = (await createResponse(request)) ?? (await createResponse(request));
    if (!result) {
      apiFailed = true;
      break;
    }
    costUsd += result.costUsd;
    usage.input += result.usage.input;
    usage.cached += result.usage.cached;
    usage.output += result.usage.output;

    const calls = result.output.filter((o) => o.type === "function_call");
    if (calls.length === 0) {
      finalText = result.text;
      break;
    }

    input.push(...result.output);
    const toolImages: MediaImage[] = [];
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
          { type: "input_text", text: "（ツールで取得したメディア。それぞれの説明に従って解釈してね）" },
          ...withCaptions(toolImages.slice(0, 12)),
        ],
      });
    }
    if (result.text && lastRound) finalText = result.text;
  }

  trace(useGemini ? GEMINI_CHAT_MODEL : CHAT_MODEL);
  // 上限で描けなかったときは、AI の文面に関係なく必ず伝える（描いたふりをしてしまうことがあるため）
  if (ctx.imageLimitNotice) {
    trace("image-limit");
    finalText = `${finalText.replace(/\[SKIP\]/gi, "").trim()}\n\n${ctx.imageLimitNotice}`.trim();
  } else if (ctx.files.length === 0 && FAKE_DRAWING.test(finalText)) {
    // ツールを呼ばずに「描いてみたよ [画像 pictorchan.jpg]」と文字だけで描いたふりをすることがある。
    // 画像が付いていないのに描いたと言っていたら、その文面は捨てて本当のことを返す
    trace("fake-drawing");
    const limits = imageGenLimits(new Date(), msg.author.id);
    if (usageCounter.get(`img:${msg.author.id}`) >= limits.perUser) {
      finalText = `🎨 ごめんね、今日のお絵かきは上限（1人1日${limits.perUser}枚）に達しちゃってるから描けないの🙏 日本時間の0時にリセットされるから、また明日頼んでね`;
    } else if (usageCounter.get("img:total") >= limits.total) {
      finalText = `🎨 ごめんね、今日はサーバー全体のお絵かき上限（1日${limits.total}枚）に達しちゃってるから描けないの🙏 日本時間の0時にリセットされるから、また明日頼んでね`;
    } else {
      finalText = "🎨 ごめんね、今回はうまく画像を作れなかったの🙏 「〇〇を描いて」ってもう一回頼んでくれたら描くね";
    }
  }
  if (mode === "auto" && /^\s*\[SKIP\]\s*$/i.test(finalText)) {
    return { text: null, files: ctx.files, trace: ctx.trace, costUsd, usage };
  }
  const text = postprocess(finalText.replace(/\[SKIP\]/gi, ""), emojis, isDev);
  // 失敗したときは黙らない（メンションなしの発言でも、返事が来ないと無視されたように見える）
  if (!text && apiFailed) {
    return {
      text: "ごめんね、ちょっと調子が悪いみたい🥺 少ししてからもう一回話しかけてね",
      files: ctx.files,
      trace: [...ctx.trace, "api-failed"],
      costUsd,
      usage,
    };
  }
  if (!text && mode === "auto") return { text: null, files: ctx.files, trace: ctx.trace, costUsd, usage };

  return {
    text: text || "ごめんね、うまく考えがまとまらなかったよ🥺 もう一回言ってみて？",
    files: ctx.files,
    trace: ctx.trace,
    costUsd,
    usage,
  };
}
