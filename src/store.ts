import type { Message } from "discord.js";
import {
  CHANNEL_MEMORY_FILE_PATH,
  MAX_CHANNEL_MEMORY_LENGTH,
  MAX_MEMORY_LENGTH,
  MAX_SERVER_MESSAGE_LOG_LENGTH,
  MEMORY_FILE_PATH,
  NAMES_FILE_PATH,
  NOTES_FILE_PATH,
  SERVER_MESSAGE_LOG_FILE_PATH,
  USAGE_STATE_PATH,
} from "./config";
import { debounced, getJapanTime, getJapanTimeFromTimestamp, japanDateKey, readJson, writeJsonAtomic } from "./util";

// ──────────────────────────────────────────────────────────
// ユーザー名
// ──────────────────────────────────────────────────────────
interface UserName {
  userId: string;
  preferredName: string;
  discordUsername: string;
  lastUpdated: number;
  nameHistory: Array<{ name: string; timestamp: number }>;
}

class NameMemory {
  private names = new Map<string, UserName>();
  private save = debounced(() => writeJsonAtomic(NAMES_FILE_PATH, Array.from(this.names.values())));

  constructor() {
    for (const name of readJson<UserName[]>(NAMES_FILE_PATH, [])) this.names.set(name.userId, name);
    console.log(`[NAMES] ${this.names.size}人の名前を読み込みました`);
  }

  getPreferredName(userId: string): string | null {
    return this.names.get(userId)?.preferredName ?? null;
  }

  /** Discord 表示名の変化を追跡し、「〜って呼んで」を拾う */
  observe(userId: string, discordUsername: string, messageContent = "") {
    let data = this.names.get(userId);
    if (!data) {
      data = {
        userId,
        preferredName: discordUsername,
        discordUsername,
        lastUpdated: Date.now(),
        nameHistory: [{ name: discordUsername, timestamp: Date.now() }],
      };
      this.names.set(userId, data);
      this.save();
    }
    if (data.discordUsername !== discordUsername) {
      // 呼び名を自分で決めていない人は表示名に追従
      if (data.preferredName === data.discordUsername) data.preferredName = discordUsername;
      data.discordUsername = discordUsername;
      data.nameHistory.push({ name: discordUsername, timestamp: Date.now() });
      data.lastUpdated = Date.now();
      this.save();
    }
    const match = messageContent.match(/(?:^|[、。\s])([^、。\s]{1,19}?)(?:って|と)呼んで/);
    if (match) {
      const name = match[1].replace(/^.*のこと(は|を)?/, "");
      if (name) this.setPreferredName(userId, discordUsername, name);
    }
  }

  setPreferredName(userId: string, discordUsername: string, name: string) {
    const trimmed = name.trim().slice(0, 20);
    if (!trimmed) return;
    this.observe(userId, discordUsername);
    const data = this.names.get(userId)!;
    data.preferredName = trimmed;
    data.nameHistory.push({ name: trimmed, timestamp: Date.now() });
    data.nameHistory = data.nameHistory.slice(-20);
    data.lastUpdated = Date.now();
    this.save();
    console.log(`[NAMES] ${userId} の呼び名を「${trimmed}」に更新`);
  }

  getAllNamesForDisplay(): string {
    if (this.names.size === 0) return "まだ誰の名前も覚えていないよ🥔";
    const list = Array.from(this.names.values())
      .sort((a, b) => b.lastUpdated - a.lastUpdated)
      .slice(0, 50)
      .map((n, i) => `${i + 1}. **${n.preferredName}** (Discord: ${n.discordUsername})`)
      .join("\n");
    return `覚えている人 (${this.names.size}人・最近の50人まで)✨\n${list}`;
  }

  clearUserName(userId: string) {
    this.names.delete(userId);
    this.save();
  }
}

// ──────────────────────────────────────────────────────────
// ユーザーごとの覚え書き（好きなもの・作風など）
// ──────────────────────────────────────────────────────────
interface UserNotes {
  userId: string;
  notes: Array<{ text: string; timestamp: number }>;
}

const MAX_NOTES_PER_USER = 20;

class NotesMemory {
  private notes = new Map<string, UserNotes>();
  private save = debounced(() => writeJsonAtomic(NOTES_FILE_PATH, Array.from(this.notes.values())));

  constructor() {
    for (const item of readJson<UserNotes[]>(NOTES_FILE_PATH, [])) this.notes.set(item.userId, item);
  }

  get(userId: string): string[] {
    return (this.notes.get(userId)?.notes ?? []).map((n) => n.text);
  }

  add(userId: string, text: string) {
    const value = text.trim().slice(0, 200);
    if (!value) return;
    const entry = this.notes.get(userId) ?? { userId, notes: [] };
    entry.notes = entry.notes.filter((n) => n.text !== value);
    entry.notes.push({ text: value, timestamp: Date.now() });
    entry.notes = entry.notes.slice(-MAX_NOTES_PER_USER);
    this.notes.set(userId, entry);
    this.save();
  }

  clear(userId: string) {
    this.notes.delete(userId);
    this.save();
  }
}

// ──────────────────────────────────────────────────────────
// ぴくたーちゃんとの会話記録（日記・個人の文脈用）
// ──────────────────────────────────────────────────────────
type Conversation = {
  timestamp: number;
  timeString: string;
  userMessage: string;
  botResponse: string;
};

interface UserMemory {
  userId: string;
  conversations: Conversation[];
}

interface ChannelMemory {
  channelId: string;
  conversations: Array<Conversation & { userId: string; userName: string }>;
}

export type ChannelConversation = ChannelMemory["conversations"][number] & { channelId: string };

class ConversationMemory {
  private memories = new Map<string, UserMemory>();
  private channelMemories = new Map<string, ChannelMemory>();
  private saveUsers = debounced(() => writeJsonAtomic(MEMORY_FILE_PATH, Array.from(this.memories.values())));
  private saveChannels = debounced(() =>
    writeJsonAtomic(CHANNEL_MEMORY_FILE_PATH, Array.from(this.channelMemories.values())),
  );

  constructor() {
    for (const m of readJson<UserMemory[]>(MEMORY_FILE_PATH, [])) this.memories.set(m.userId, m);
    for (const m of readJson<ChannelMemory[]>(CHANNEL_MEMORY_FILE_PATH, [])) this.channelMemories.set(m.channelId, m);
    console.log(`[MEMORY] users=${this.memories.size} channels=${this.channelMemories.size}`);
  }

  getUserConversations(userId: string, limit = 6): Conversation[] {
    return (this.memories.get(userId)?.conversations ?? []).slice(-limit);
  }

  getAllChannelConversations(): ChannelConversation[] {
    return Array.from(this.channelMemories.values())
      .flatMap((memory) => memory.conversations.map((c) => ({ channelId: memory.channelId, ...c })))
      .sort((a, b) => a.timestamp - b.timestamp);
  }

  addConversation(userId: string, channelId: string, userName: string, userMessage: string, botResponse: string) {
    const base = { timestamp: Date.now(), timeString: getJapanTime(), userMessage, botResponse };

    const user = this.memories.get(userId) ?? { userId, conversations: [] };
    user.conversations.push(base);
    user.conversations = user.conversations.slice(-MAX_MEMORY_LENGTH);
    this.memories.set(userId, user);

    const channel = this.channelMemories.get(channelId) ?? { channelId, conversations: [] };
    channel.conversations.push({ ...base, userId, userName });
    channel.conversations = channel.conversations.slice(-MAX_CHANNEL_MEMORY_LENGTH);
    this.channelMemories.set(channelId, channel);

    this.saveUsers();
    this.saveChannels();
  }

  clearUserMemory(userId: string) {
    this.memories.delete(userId);
    this.saveUsers();
  }

  clearChannelMemory(channelId: string) {
    this.channelMemories.delete(channelId);
    this.saveChannels();
  }
}

// ──────────────────────────────────────────────────────────
// サーバ全体の発言ログ（日記・検索用）
// ──────────────────────────────────────────────────────────
export interface ObservedServerMessage {
  messageId: string;
  guildId: string | null;
  channelId: string;
  channelName: string;
  parentChannelId: string | null;
  parentChannelName: string | null;
  timestamp: number;
  timeString: string;
  userId: string;
  userName: string;
  content: string;
  attachmentNames: string[];
  attachmentUrls: string[];
  hasImage: boolean;
  replyToMessageId: string | null;
}

class ServerMessageLog {
  private messages: ObservedServerMessage[] = [];
  private indexById = new Map<string, number>();
  private save = debounced(() => writeJsonAtomic(SERVER_MESSAGE_LOG_FILE_PATH, this.messages), 30_000);

  constructor() {
    this.messages = readJson<ObservedServerMessage[]>(SERVER_MESSAGE_LOG_FILE_PATH, []);
    this.reindex();
    console.log(`[SERVER_LOG] ${this.messages.length}件のメッセージログを読み込みました`);
  }

  private reindex() {
    this.indexById.clear();
    this.messages.forEach((m, i) => this.indexById.set(m.messageId, i));
  }

  addMessage(msg: Message) {
    const channel = msg.channel as any;
    const parent = typeof channel?.isThread === "function" && channel.isThread() ? channel.parent : null;
    const attachments = Array.from(msg.attachments.values());
    const record: ObservedServerMessage = {
      messageId: msg.id,
      guildId: msg.guildId ?? null,
      channelId: msg.channel.id,
      channelName: label(channel?.name ?? "unknown-channel"),
      parentChannelId: parent?.id ?? null,
      parentChannelName: parent?.name ? label(parent.name) : null,
      timestamp: msg.createdTimestamp,
      timeString: getJapanTimeFromTimestamp(msg.createdTimestamp),
      userId: msg.author.id,
      userName: label(msg.member?.displayName ?? msg.author.displayName ?? msg.author.username),
      content: normalize(msg.content),
      attachmentNames: attachments.map((a) => a.name ?? "attachment").slice(0, 6),
      attachmentUrls: attachments.map((a) => a.url).filter(Boolean).slice(0, 6),
      hasImage: attachments.some((a) => /^image\//.test(a.contentType ?? "") || /\.(png|jpe?g|gif|webp)$/i.test(a.name ?? "")),
      replyToMessageId: msg.reference?.messageId ?? null,
    };

    const existing = this.indexById.get(msg.id);
    if (existing !== undefined) {
      this.messages[existing] = record;
    } else {
      this.indexById.set(msg.id, this.messages.length);
      this.messages.push(record);
    }
    if (this.messages.length > MAX_SERVER_MESSAGE_LOG_LENGTH * 1.1) {
      this.messages = this.messages.slice(-MAX_SERVER_MESSAGE_LOG_LENGTH);
      this.reindex();
    }
    this.save();
  }

  updateMessage(messageId: string, content: string) {
    const index = this.indexById.get(messageId);
    if (index === undefined) return;
    this.messages[index] = { ...this.messages[index], content: normalize(content) };
    this.save();
  }

  markDeleted(messageId: string) {
    const index = this.indexById.get(messageId);
    if (index === undefined) return;
    const prev = this.messages[index];
    this.messages[index] = { ...prev, content: prev.content ? `${prev.content} [deleted later]` : "[deleted later]" };
    this.save();
  }

  getMessagesByDate(dateKey: string): ObservedServerMessage[] {
    return this.messages.filter((m) => japanDateKey(m.timestamp) === dateKey).sort((a, b) => a.timestamp - b.timestamp);
  }

  /** 新しい順に条件に合うものを返す */
  search(filter: (m: ObservedServerMessage) => boolean, limit: number): ObservedServerMessage[] {
    const result: ObservedServerMessage[] = [];
    for (let i = this.messages.length - 1; i >= 0 && result.length < limit; i--) {
      if (filter(this.messages[i])) result.push(this.messages[i]);
    }
    return result;
  }
}

function normalize(content: string): string {
  return (content ?? "").replace(/\s+/g, " ").trim().slice(0, 1000);
}

function label(value: string): string {
  return (value ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
}

// ──────────────────────────────────────────────────────────
// 日次の利用回数（画像生成などコストのかかる機能の上限管理）
// ──────────────────────────────────────────────────────────
type UsageState = { date: string; counts: Record<string, number> };

class UsageCounter {
  private state: UsageState = readJson<UsageState>(USAGE_STATE_PATH, { date: japanDateKey(), counts: {} });
  private save = debounced(() => writeJsonAtomic(USAGE_STATE_PATH, this.state), 2_000);

  private rollover() {
    const today = japanDateKey();
    if (this.state.date !== today) this.state = { date: today, counts: {} };
  }

  get(key: string): number {
    this.rollover();
    return this.state.counts[key] ?? 0;
  }

  increment(key: string) {
    this.rollover();
    this.state.counts[key] = (this.state.counts[key] ?? 0) + 1;
    this.save();
  }
}

export const nameMemory = new NameMemory();
export const notesMemory = new NotesMemory();
export const conversationMemory = new ConversationMemory();
export const serverMessageLog = new ServerMessageLog();
export const usageCounter = new UsageCounter();
