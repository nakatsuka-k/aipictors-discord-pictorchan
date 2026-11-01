// Aipictors との連携（aipictors-api の /discord-bot を呼ぶ）
const API_BASE = process.env.AIPICTORS_API_BASE_URL ?? "https://backend.aipictors.com";
const TOKEN = process.env.DISCORD_BOT_API_TOKEN;

export type LinkedCard = {
  isLinked: boolean;
  userId?: string;
  name?: string | null;
  login?: string | null;
  level?: number | null;
  unlockedCount?: number | null;
  isAchievementVisible?: boolean;
};

const headers = () => ({ authorization: `Bearer ${TOKEN}` });

export async function notifyMemberJoined(discordUserId: string) {
  if (!TOKEN) return;
  await fetch(`${API_BASE}/discord-bot/member-joined/${discordUserId}`, {
    method: "POST",
    headers: headers(),
  });
}

export async function fetchLinkedCard(discordUserId: string): Promise<LinkedCard | null> {
  if (!TOKEN) return null;
  const response = await fetch(`${API_BASE}/discord-bot/card/${discordUserId}`, { headers: headers() });
  if (!response.ok) return null;
  const json = (await response.json()) as { data?: LinkedCard };
  return json.data ?? null;
}

/** シェアカード（達成数と日付が変わると Discord が新しい画像を取りに行く） */
export function toAchievementCardUrl(userId: string, unlockedCount: number, now = new Date()) {
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo" }).format(now).replace(/-/g, "");
  return `https://card.aipictors.com/achievements/${userId}/${unlockedCount}-${day}.png`;
}
