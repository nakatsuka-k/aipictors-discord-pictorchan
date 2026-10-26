import "dotenv/config";

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

// サーバー側ツール（xAI が実行・課金）
export const ENABLE_WEB_SEARCH = process.env.ENABLE_WEB_SEARCH !== "0";

// ──────────────────────────────────────────────────────────
// Discord チャンネル
// ──────────────────────────────────────────────────────────
export const PICTORCHAN_CHANNEL_ID = process.env.PICTORCHAN_CH_ID ?? "1273078367293276233"; // 🌈ぴくたーちゃん（自動返信）
export const ANNOUNCE_CHANNEL_ID = process.env.ANNOUNCE_CH_ID ?? "1130319028662050817";      // 📢お知らせ
export const WELCOME_CHANNEL_ID = "1411268702552461313";
export const DIARY_CHANNEL_ID = process.env.DIARY_CH_ID ?? "1487156313015320709";

// 反応しないチャンネル（返信しない。読むのは可）
export const NO_INTERACT_CHANNEL_IDS = new Set<string>([
  "1126570407420493927",
  "1175754548397215744",
  "1130319028662050817",
]);

// ──────────────────────────────────────────────────────────
// 永続化
// ──────────────────────────────────────────────────────────
export const DATA_DIR = process.env.DATA_DIR ?? "/data";
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
export const MAX_VIDEO_BYTES = 200 * 1024 * 1024;
export const MAX_AGENT_ROUNDS = 5;
export const USER_REQUESTS_PER_MINUTE = 6;
export const IMAGE_GEN_PER_USER_PER_DAY = 3;
export const IMAGE_GEN_PER_DAY = 30;
