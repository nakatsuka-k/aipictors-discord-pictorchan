// discord.js は Workers で動かないので、使う分だけの REST・キャッシュ・権限計算を自前で持つ
import { DISCORD_TOKEN } from "./config";

const API = "https://discord.com/api/v10";

// ──────────────────────────────────────────────────────────
// 型（Discord API の生データのうち使うところだけ）
// ──────────────────────────────────────────────────────────
export type User = { id: string; username: string; global_name?: string | null; bot?: boolean; discriminator?: string };
export type Member = { user?: User; nick?: string | null; roles: string[] };
export type Attachment = {
  id: string;
  filename: string;
  url: string;
  proxy_url?: string;
  size: number;
  content_type?: string;
  width?: number | null;
  height?: number | null;
};
export type Embed = {
  title?: string;
  description?: string;
  url?: string;
  image?: { url: string };
  thumbnail?: { url: string };
  video?: { url?: string };
};
export type Message = {
  id: string;
  channel_id: string;
  guild_id?: string;
  author: User;
  member?: Member;
  content: string;
  timestamp: string;
  attachments: Attachment[];
  embeds: Embed[];
  mentions: Array<User & { member?: Member }>;
  message_reference?: { message_id?: string; channel_id?: string; guild_id?: string };
  referenced_message?: Message | null;
  sticker_items?: Array<{ id: string; name: string }>;
  webhook_id?: string;
};
export type Overwrite = { id: string; type: 0 | 1; allow: string; deny: string };
export type Channel = {
  id: string;
  type: number;
  guild_id?: string;
  name?: string;
  topic?: string | null;
  position?: number;
  parent_id?: string | null;
  permission_overwrites?: Overwrite[];
  last_message_id?: string | null;
};
export type Role = { id: string; permissions: string; position: number };
export type Emoji = { id: string; name: string; animated?: boolean; available?: boolean };

/** discord.js の AttachmentBuilder の代わり */
export type FileData = { name: string; data: Uint8Array; description?: string };

export type SendOptions =
  | string
  | {
      content?: string;
      files?: FileData[];
      embeds?: unknown[];
      allowedMentions?: { parse?: string[]; replied_user?: boolean };
      ephemeral?: boolean;
    };

export const ChannelType = {
  GuildText: 0,
  GuildVoice: 2,
  GuildCategory: 4,
  GuildAnnouncement: 5,
  AnnouncementThread: 10,
  PublicThread: 11,
  PrivateThread: 12,
  GuildStageVoice: 13,
  GuildForum: 15,
} as const;

const TEXT_TYPES = new Set([0, 2, 5, 10, 11, 12, 13]);
const THREAD_TYPES = new Set([10, 11, 12]);
export const isTextChannel = (c: Channel | undefined | null) => Boolean(c && TEXT_TYPES.has(c.type));
export const isThread = (c: Channel | undefined | null) => Boolean(c && THREAD_TYPES.has(c.type));

// ──────────────────────────────────────────────────────────
// REST
// ──────────────────────────────────────────────────────────
export class DiscordError extends Error {
  constructor(public status: number, public body: string) {
    super(`Discord API ${status}: ${body.slice(0, 300)}`);
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function discord<T = any>(
  method: string,
  path: string,
  body?: unknown,
  files?: FileData[],
  auth = true,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    let payload: BodyInit | undefined;
    const headers: Record<string, string> = {
      "User-Agent": "DiscordBot (https://aipictors.com, 3.0) pictorchan",
    };
    if (auth) headers.Authorization = `Bot ${DISCORD_TOKEN}`;
    if (files?.length) {
      const form = new FormData();
      const json = { ...(body as object), attachments: files.map((f, i) => ({ id: i, filename: f.name, description: f.description })) };
      form.append("payload_json", JSON.stringify(json));
      files.forEach((f, i) => form.append(`files[${i}]`, new Blob([f.data]), f.name));
      payload = form;
    } else if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      payload = JSON.stringify(body);
    }
    const res = await fetch(`${API}${path}`, { method, headers, body: payload, signal: AbortSignal.timeout(60_000) });
    if (res.status === 429 && attempt < 4) {
      const info = (await res.json().catch(() => ({}))) as { retry_after?: number };
      await sleep(Math.min(30, Number(info.retry_after ?? 1)) * 1000 + 100);
      continue;
    }
    if (res.status >= 500 && attempt < 2) {
      await res.body?.cancel();
      await sleep(1000 * (attempt + 1));
      continue;
    }
    if (!res.ok) throw new DiscordError(res.status, await res.text());
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }
}

function toMessageBody(options: SendOptions) {
  const o = typeof options === "string" ? { content: options } : options;
  return {
    body: {
      content: o.content,
      embeds: o.embeds,
      allowed_mentions: o.allowedMentions ?? { parse: [], replied_user: true },
      flags: o.ephemeral ? 64 : undefined,
    },
    files: o.files,
  };
}

export async function sendMessage(channelId: string, options: SendOptions): Promise<Message> {
  const { body, files } = toMessageBody(options);
  const sent = await discord<Message>("POST", `/channels/${channelId}/messages`, body, files);
  cache.noteMessage(sent);
  return sent;
}

export async function replyTo(msg: Message, options: SendOptions): Promise<Message> {
  const { body, files } = toMessageBody(options);
  const sent = await discord<Message>(
    "POST",
    `/channels/${msg.channel_id}/messages`,
    { ...body, message_reference: { message_id: msg.id, fail_if_not_exists: false } },
    files,
  );
  cache.noteMessage(sent);
  return sent;
}

export const sendTyping = (channelId: string) => discord("POST", `/channels/${channelId}/typing`);

export const react = (msg: Message, emoji: string) =>
  discord("PUT", `/channels/${msg.channel_id}/messages/${msg.id}/reactions/${encodeURIComponent(emoji)}/@me`);

export async function fetchMessages(channelId: string, options: { limit: number; before?: string }): Promise<Message[]> {
  const query = new URLSearchParams({ limit: String(Math.min(100, options.limit)) });
  if (options.before) query.set("before", options.before);
  return discord<Message[]>("GET", `/channels/${channelId}/messages?${query}`);
}

export const fetchMessage = (channelId: string, messageId: string) =>
  discord<Message>("GET", `/channels/${channelId}/messages/${messageId}`);

export const messageUrl = (m: { guild_id?: string; channel_id: string; id: string }, guildId?: string) =>
  `https://discord.com/channels/${m.guild_id ?? guildId ?? "@me"}/${m.channel_id}/${m.id}`;

export function base64ToBytes(b64: string): Uint8Array {
  return Uint8Array.from(Buffer.from(b64, "base64"));
}

// ──────────────────────────────────────────────────────────
// キャッシュ（Gateway のイベントで更新）
// ──────────────────────────────────────────────────────────
export type GuildState = {
  id: string;
  name: string;
  ownerId: string;
  roles: Map<string, Role>;
  emojis: Map<string, Emoji>;
  members: Map<string, { nick?: string | null; roles: string[]; user?: User }>;
};

class Cache {
  botId = "";
  botUser: User | null = null;
  guilds = new Map<string, GuildState>();
  channels = new Map<string, Channel>();

  guildCreate(d: any) {
    const guild: GuildState = {
      id: d.id,
      name: d.name,
      ownerId: d.owner_id,
      roles: new Map((d.roles ?? []).map((r: Role) => [r.id, r])),
      emojis: new Map((d.emojis ?? []).map((e: Emoji) => [e.id, e])),
      members: this.guilds.get(d.id)?.members ?? new Map(),
    };
    for (const m of d.members ?? []) if (m.user) guild.members.set(m.user.id, { nick: m.nick, roles: m.roles, user: m.user });
    this.guilds.set(d.id, guild);
    for (const c of [...(d.channels ?? []), ...(d.threads ?? [])]) this.channels.set(c.id, { ...c, guild_id: d.id });
  }

  guildUpdate(d: any) {
    const guild = this.guilds.get(d.id);
    if (!guild) return;
    guild.name = d.name;
    guild.ownerId = d.owner_id;
    if (d.roles) guild.roles = new Map(d.roles.map((r: Role) => [r.id, r]));
  }

  roleUpsert(guildId: string, role: Role) {
    this.guilds.get(guildId)?.roles.set(role.id, role);
  }

  roleDelete(guildId: string, roleId: string) {
    this.guilds.get(guildId)?.roles.delete(roleId);
  }

  emojisUpdate(guildId: string, emojis: Emoji[]) {
    const guild = this.guilds.get(guildId);
    if (guild) guild.emojis = new Map(emojis.map((e) => [e.id, e]));
  }

  channelUpsert(c: Channel) {
    const previous = this.channels.get(c.id);
    this.channels.set(c.id, { ...previous, ...c });
  }

  channelDelete(id: string) {
    this.channels.delete(id);
  }

  memberUpsert(guildId: string, userId: string, member: { nick?: string | null; roles?: string[]; user?: User }) {
    const guild = this.guilds.get(guildId);
    if (!guild) return;
    const previous = guild.members.get(userId);
    guild.members.set(userId, {
      nick: member.nick !== undefined ? member.nick : previous?.nick,
      roles: member.roles ?? previous?.roles ?? [],
      user: member.user ?? previous?.user,
    });
    // 何万人も入れないよう、古いものから捨てる
    if (guild.members.size > 20_000) {
      const oldest = guild.members.keys().next().value;
      if (oldest && oldest !== this.botId) guild.members.delete(oldest);
    }
  }

  memberRemove(guildId: string, userId: string) {
    this.guilds.get(guildId)?.members.delete(userId);
  }

  /** Gateway で見たメッセージ（投稿者の表示名・チャンネルの最新メッセージ） */
  noteMessage(m: Message) {
    const channel = this.channels.get(m.channel_id);
    if (channel) channel.last_message_id = m.id;
    if (m.guild_id && m.member) this.memberUpsert(m.guild_id, m.author.id, { ...m.member, user: m.author });
    if (m.guild_id) {
      for (const u of m.mentions ?? []) if (u.member) this.memberUpsert(m.guild_id, u.id, { ...u.member, user: u });
    }
  }

  async getChannel(id: string): Promise<Channel | null> {
    const hit = this.channels.get(id);
    if (hit) return hit;
    try {
      const channel = await discord<Channel>("GET", `/channels/${id}`);
      this.channels.set(id, channel);
      return channel;
    } catch {
      return null;
    }
  }

  async getMember(guildId: string, userId: string) {
    const guild = this.guilds.get(guildId);
    const hit = guild?.members.get(userId);
    if (hit) return hit;
    try {
      const member = await discord<Member>("GET", `/guilds/${guildId}/members/${userId}`);
      this.memberUpsert(guildId, userId, member);
      return guild?.members.get(userId) ?? { nick: member.nick, roles: member.roles, user: member.user };
    } catch {
      return null;
    }
  }
}

export const cache = new Cache();

/** discord.js の displayName と同じ（サーバーのニックネーム → 表示名 → ユーザー名） */
export function userDisplayName(user: User | undefined | null, nick?: string | null): string {
  return nick || user?.global_name || user?.username || "誰か";
}

export function memberDisplayName(guildId: string | undefined, user: User): string {
  const member = guildId ? cache.guilds.get(guildId)?.members.get(user.id) : undefined;
  return userDisplayName(user, member?.nick);
}

/** メッセージの投稿者の表示名（Gateway のメッセージは member を含む。取得したメッセージはキャッシュから） */
export function authorName(m: Message): string {
  if (m.member?.nick) return m.member.nick;
  return memberDisplayName(m.guild_id, m.author);
}

export function emojiToString(e: Emoji): string {
  return `<${e.animated ? "a" : ""}:${e.name}:${e.id}>`;
}

// ──────────────────────────────────────────────────────────
// 権限（discord.js の permissionsFor と同じ計算）
// ──────────────────────────────────────────────────────────
export const Permission = {
  Administrator: 1n << 3n,
  ViewChannel: 1n << 10n,
  ReadMessageHistory: 1n << 16n,
} as const;
const ALL = (1n << 53n) - 1n;

export function permissionsFor(guild: GuildState, channel: Channel, userId: string, roles: string[]): bigint {
  if (userId === guild.ownerId) return ALL;
  let base = BigInt(guild.roles.get(guild.id)?.permissions ?? "0");
  for (const roleId of roles) base |= BigInt(guild.roles.get(roleId)?.permissions ?? "0");
  if (base & Permission.Administrator) return ALL;

  // スレッドは親チャンネルの権限
  const target = isThread(channel) && channel.parent_id ? (cache.channels.get(channel.parent_id) ?? channel) : channel;
  const overwrites = target.permission_overwrites ?? [];
  let perms = base;
  const everyone = overwrites.find((o) => o.id === guild.id);
  if (everyone) perms = (perms & ~BigInt(everyone.deny)) | BigInt(everyone.allow);
  let allow = 0n;
  let deny = 0n;
  for (const o of overwrites) {
    if (o.type === 0 && roles.includes(o.id)) {
      allow |= BigInt(o.allow);
      deny |= BigInt(o.deny);
    }
  }
  perms = (perms & ~deny) | allow;
  const member = overwrites.find((o) => o.type === 1 && o.id === userId);
  if (member) perms = (perms & ~BigInt(member.deny)) | BigInt(member.allow);
  return perms;
}

export function hasPermissions(perms: bigint, needed: bigint[]): boolean {
  return needed.every((p) => (perms & p) === p);
}
