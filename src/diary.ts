import type { Client } from "discord.js";
import { DIARY_CHANNEL_ID, DIARY_STATE_PATH } from "./config";
import { conversationMemory, serverMessageLog, type ObservedServerMessage } from "./store";
import { getJapanNow, japanDateKey, japanDateTitle, readJson, sampleEvenly, splitForDiscord, writeJsonAtomic } from "./util";
import { chatText } from "./xai";

function formatObservedMessage(message: ObservedServerMessage): string {
  const channel = message.parentChannelName ? `${message.parentChannelName}/${message.channelName}` : message.channelName;
  const content = message.content || (message.attachmentNames.length > 0 ? "[添付のみ]" : "[内容なし]");
  const attachments = message.attachmentNames.length > 0 ? ` / attachments: ${message.attachmentNames.join(", ")}` : "";
  return `[${message.timeString}] #${channel} ${message.userName}: ${content}${attachments}${message.hasImage ? " / image:true" : ""}`;
}

export function parseDiaryDateInput(input: string): Date | null {
  const value = (input ?? "").trim();
  const full = value.match(/^(\d{4})[./-](\d{1,2})[./-](\d{1,2})$/);
  const short = value.match(/^(\d{1,2})[./-](\d{1,2})$/);
  const [y, m, d] = full
    ? [Number(full[1]), Number(full[2]), Number(full[3])]
    : short
      ? [getJapanNow().getFullYear(), Number(short[1]), Number(short[2])]
      : [NaN, NaN, NaN];
  if (Number.isNaN(y)) return null;
  const date = new Date(y, m - 1, d);
  return date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === d ? date : null;
}

export async function postDiary(
  client: Client,
  options: { targetDate?: Date; skipStateCheck?: boolean; updateState?: boolean } = {},
): Promise<{ posted: boolean; dateKey: string; title: string }> {
  const targetDate = options.targetDate ? new Date(options.targetDate) : getJapanNow();
  if (!options.targetDate) targetDate.setDate(targetDate.getDate() - 1);
  const dateKey = japanDateKey(targetDate);
  const title = `${japanDateTitle(targetDate)}｜ぴくたーちゃん日記`;

  const state = readJson<{ lastPostedDate?: string }>(DIARY_STATE_PATH, {});
  if (!options.skipStateCheck && state.lastPostedDate === dateKey) return { posted: false, dateKey, title };

  try {
    const channel: any = await client.channels.fetch(DIARY_CHANNEL_ID);
    if (!channel?.send) return { posted: false, dateKey, title };

    const observed = serverMessageLog.getMessagesByDate(dateKey);
    const conversations = conversationMemory
      .getAllChannelConversations()
      .filter((c) => japanDateKey(c.timestamp) === dateKey)
      .slice(-160);

    let body = "昨日は会話ログが少なめで、ちょっと静かな一日だったよ🥔 また次のおしゃべりを楽しみにしてるね。";
    if (observed.length > 0 || conversations.length > 0) {
      const generated = await chatText(
        [
          {
            role: "system",
            content:
              "あなたはAipictorsのマスコット『ぴくたーちゃん』です。Discordサーバ内で昨日観測できた発言ログと、ぴくたーちゃん自身の会話記録をもとに、振り返り日記を書いてください。" +
              "サーバ全体の完全な履歴ではない可能性があるので、見えている範囲から自然に全体像をまとめてください。" +
              "チャンネルごとの空気感、印象的なやり取り、ぴくたーちゃんが会話した内容、感想や小さな気づきを自然に織り込んでください。" +
              "事実にない出来事は作らず、観測できていない時間帯や会話を断定しないでください。" +
              "日本語で3〜6段落。見出しや箇条書きは不要。やわらかい口調で、絵文字を段落にひとつ程度添え、軽い余韻で締めてください。",
          },
          {
            role: "user",
            content:
              `対象日: ${japanDateTitle(targetDate)}\n観測メッセージ数: ${observed.length}\nぴくたーちゃん会話数: ${conversations.length}\n\n` +
              `サーバ観測ログ:\n${sampleEvenly(observed, 320).map(formatObservedMessage).join("\n") || "なし"}\n\n` +
              `ぴくたーちゃん会話ログ:\n${sampleEvenly(conversations, 160).map((c) => `[${c.timeString}] ${c.userName}: ${c.userMessage} / ぴくたーちゃん: ${c.botResponse}`).join("\n") || "なし"}`,
          },
        ],
        { maxTokens: 1200, temperature: 0.7 },
      );
      if (generated) body = generated.replace(/```[\s\S]*?```/g, "").trim();
    }

    const segments = splitForDiscord(`**${title}**\n\n${body}`, 1900);
    for (const segment of segments) await channel.send(segment);

    if (options.updateState !== false) writeJsonAtomic(DIARY_STATE_PATH, { lastPostedDate: dateKey });
    console.log(`[DIARY] posted dateKey=${dateKey}`);
    return { posted: true, dateKey, title };
  } catch (error) {
    console.error(`[DIARY] post error dateKey=${dateKey}`, error);
    return { posted: false, dateKey, title };
  }
}
