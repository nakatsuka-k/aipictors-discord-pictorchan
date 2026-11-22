export const {
  DISCORD_TOKEN,
  GROK_API_KEY,
  CLIENT_ID,              // Discord Application (Bot) ID
  OPINION_CH_ID,          // 意見チャンネルID
  BUG_CH_ID,              // 不具合チャンネルID
  GH_TOKEN,               // GitHub Personal Access Token
  GH_OWNER,               // GitHub リポジトリオーナー (aipictors)
  GH_REPO,                // GitHub リポジトリ名 (aipictors)
} = process.env;

// ──────────────────────────────────────────────────────────
// モデル（xAI）
// ──────────────────────────────────────────────────────────
// 会話・ツール呼び出し・画像理解をまとめて担当（非推論で速く安く）
export const CHAT_MODEL = process.env.CHAT_MODEL ?? "grok-4.20-0309-non-reasoning";
// 日記・意見整理などの単発テキスト生成
export const TEXT_MODEL = process.env.TEXT_MODEL ?? CHAT_MODEL;
// /checkimage のようにじっくり見る用途
export const VISION_MODEL = process.env.GROK_VISION_MODEL ?? "grok-4.20-0309-reasoning";
export const IMAGE_MODEL = process.env.WELCOME_IMAGE_MODEL ?? "grok-imagine-image";

// 会話・日記・意見整理は安い Gemini を先に使い、失敗・安全フィルターで止まったら Grok（GEMINI_API_KEY が無ければ Grok だけ）
export const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
export const GEMINI_CHAT_MODEL = process.env.GEMINI_CHAT_MODEL ?? "gemini-3.5-flash-lite";
// 0 で Gemini を使わない（すぐ Grok に戻す用）
export const GEMINI_CHAT_ENABLED = process.env.GEMINI_CHAT !== "0";

// サーバー側ツール（xAI が実行・課金）
export const ENABLE_WEB_SEARCH = process.env.ENABLE_WEB_SEARCH !== "0";

// ──────────────────────────────────────────────────────────
// Discord チャンネル
// ──────────────────────────────────────────────────────────
export const PICTORCHAN_CHANNEL_ID = process.env.PICTORCHAN_CH_ID ?? "1273078367293276233"; // 🌈ぴくたーちゃん（自動返信）
export const ANNOUNCE_CHANNEL_ID = process.env.ANNOUNCE_CH_ID ?? "1130319028662050817";      // 📢お知らせ
export const WELCOME_CHANNEL_ID = "1411268702552461313";
export const RULES_CHANNEL_ID = "1572314565671260291"; // 📜rules・ルール・规则
export const DIARY_CHANNEL_ID = process.env.DIARY_CH_ID ?? "1487156313015320709";

// 反応しないチャンネル（返信しない。読むのは可）
export const NO_INTERACT_CHANNEL_IDS = new Set<string>([
  "1126570407420493927", // 🐾要望（返信は dcauto の自動対応）
  "1572546795307802644", // 🐞不具合（返信は dcauto の自動対応）
  "1175754548397215744", // 📋なんでも質問してね
  "1411251879614353449", // 📨お問い合わせガイド
  "1572314570050244716", // ❓help-and-feedback（English）
  "1572314580930265229", // ❓提问与反馈-help（中文）
  "1573377570748112957", // 🐱aiuto-italiano（返信は dcauto の自動対応）
  "1573377574774513714", // 🐱도움-한국어（返信は dcauto の自動対応）
  "1130319028662050817", // 📢お知らせ
  "1572314565671260291", // 📜rules
]);

// ──────────────────────────────────────────────────────────
// 永続化（R2 pictorchan-state のファイル名。src/state.ts）
// ──────────────────────────────────────────────────────────
export const DATA_DIR = "/data";
export const MEMORY_FILE_PATH = `${DATA_DIR}/user_memories.json`;
export const CHANNEL_MEMORY_FILE_PATH = `${DATA_DIR}/channel_memories.json`;
export const NAMES_FILE_PATH = `${DATA_DIR}/user_names.json`;
export const NOTES_FILE_PATH = `${DATA_DIR}/user_notes.json`;
export const SERVER_MESSAGE_LOG_FILE_PATH = `${DATA_DIR}/server_message_log.json`;
export const DIARY_STATE_PATH = `${DATA_DIR}/diary_state.json`;
export const ANNOUNCE_STATE_PATH = `${DATA_DIR}/announce_state.json`;
export const USAGE_STATE_PATH = `${DATA_DIR}/usage_state.json`;

export const MAX_MEMORY_LENGTH = 1000;
export const MAX_CHANNEL_MEMORY_LENGTH = 2000;
export const MAX_SERVER_MESSAGE_LOG_LENGTH = 50000;

// ──────────────────────────────────────────────────────────
// コスト・負荷の上限
// ──────────────────────────────────────────────────────────
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
// Cloudflare Media Transformations の入力は 100MB まで
export const MAX_VIDEO_BYTES = 100 * 1024 * 1024;
export const MAX_AGENT_ROUNDS = 5;
export const USER_REQUESTS_PER_MINUTE = 6;
// grok-imagine-image は 1 枚 $0.02。全員が上限まで使っても 1 日 $1.2 ほど
export const IMAGE_GEN_PER_USER_PER_DAY = 10;
export const IMAGE_GEN_PER_DAY = 60;
// 特別な日だけ上限を変える（日本時間の日付）。その日が終われば自動でいつもの上限に戻る
// 4 周年の日は 1 人 44 枚。全体は 44 枚 × 10 人ぶん（全員が上限まで使っても $8.8 ほど）
export const IMAGE_GEN_SPECIAL_DAYS: Record<string, { perUser: number; total: number }> = {
  "2026-11-21": { perUser: 44, total: 500 },
};
// 特別な日にだけ、決まった人の上限を変える（日本時間の日付 → Discord のユーザー ID → 1 日の枚数）
// 2026-11-21: ウンダバー＿さん（undaba_）を 100 枚に（オーナー依頼。全体の上限は 500 枚に広げた）
export const IMAGE_GEN_SPECIAL_USERS: Record<string, Record<string, number>> = {
  "2026-11-21": { "1308813531218706433": 100 },
};
