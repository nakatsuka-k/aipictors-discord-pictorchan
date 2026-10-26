import { AttachmentBuilder, ChannelType, type Attachment, type Client } from "discord.js";
import { BUG_CH_ID, GH_OWNER, GH_REPO, GH_TOKEN, OPINION_CH_ID } from "./config";
import { chatText } from "./xai";

let discordClient: Client | null = null;
export function setFeedbackClient(client: Client) {
  discordClient = client;
}

async function createGitHubIssue(title: string, body: string, labels: string[]): Promise<{ url: string; number: number } | null> {
  if (!GH_TOKEN || !GH_OWNER || !GH_REPO) return null;
  try {
    const res = await fetch(`https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/issues`, {
      method: "POST",
      headers: {
        Authorization: `token ${GH_TOKEN}`,
        "Content-Type": "application/json",
        Accept: "application/vnd.github.v3+json",
      },
      body: JSON.stringify({ title, body, labels }),
    });
    if (!res.ok) {
      console.error(`[GitHub] Issue作成エラー: ${res.status} ${await res.text()}`);
      return null;
    }
    const issue = (await res.json()) as { html_url: string; number: number };
    return { url: issue.html_url, number: issue.number };
  } catch (error) {
    console.error("[GitHub] Issue作成エラー", error);
    return null;
  }
}

/** 意見・不具合をフォーラム（＋GitHub Issue）へ投稿する */
export async function postFeedback(params: {
  kind: "bug" | "opinion";
  title: string;
  content: string;
  userTag: string;
  attachments?: Attachment[];
}): Promise<{ posted: boolean; message: string }> {
  const channelId = params.kind === "opinion" ? OPINION_CH_ID : BUG_CH_ID;
  if (!channelId || !discordClient) return { posted: false, message: "投稿先チャンネルが設定されていないよ" };

  const title = (params.title || (params.kind === "opinion" ? "意見・要望" : "不具合報告")).slice(0, 90);
  const label = params.kind === "opinion" ? "ご意見フォーラム" : "不具合フォーラム";

  try {
    const channel: any = await discordClient.channels.fetch(channelId);
    if (!channel) return { posted: false, message: "チャンネルが見つからないよ" };

    const labels = params.kind === "opinion" ? ["enhancement", "user-feedback"] : ["bug", "user-report"];
    const issue = await createGitHubIssue(title, `${params.content}\n\n---\n投稿者: ${params.userTag}`, labels);

    let postContent = `${params.content}\n\n*投稿者: ${params.userTag}*`;
    if (issue) postContent += `\n\n🔗 GitHub Issue: ${issue.url}`;

    const files: AttachmentBuilder[] = [];
    for (const att of (params.attachments ?? []).slice(0, 4)) {
      try {
        const res = await fetch(att.url);
        if (res.ok) files.push(new AttachmentBuilder(Buffer.from(await res.arrayBuffer()), { name: att.name || "attachment" }));
      } catch (error) {
        console.error("[FEEDBACK] attachment error", error);
      }
    }

    let url = "";
    if (channel.type === ChannelType.GuildForum) {
      const thread = await channel.threads.create({
        name: title,
        message: { content: postContent.slice(0, 1990), files: files.length ? files : undefined },
      });
      url = thread.url;
    } else if (channel.isTextBased?.()) {
      const sent = await channel.send({ content: `**${title}**\n\n${postContent}`.slice(0, 1990), files: files.length ? files : undefined });
      url = sent.url;
    } else {
      return { posted: false, message: "サポートされていないチャンネルタイプだよ" };
    }

    let message = `[${label}](${url})に投稿したよ`;
    if (issue) message += ` / [GitHub Issue #${issue.number}](${issue.url})`;
    return { posted: true, message };
  } catch (error) {
    console.error("[FEEDBACK] post error", error);
    return { posted: false, message: "投稿に失敗しちゃった" };
  }
}

/** スラッシュコマンド用：文章を整えてから投稿 */
export async function organizeAndPostFeedback(content: string, userTag: string, kind: "bug" | "opinion") {
  const organized = await chatText(
    [
      {
        role: "system",
        content: "以下の内容を運営が読みやすいように整理し、次の形式だけで出力してください。\nTitle: (簡潔なタイトル)\nMessage: (整理された内容。元の意図を変えない)",
      },
      { role: "user", content },
    ],
    { maxTokens: 600, temperature: 0 },
  );
  const title = organized?.match(/Title:\s*(.+)/i)?.[1]?.trim() ?? "";
  const message = organized?.match(/Message:\s*([\s\S]+)/i)?.[1]?.trim() || content;
  return postFeedback({ kind, title, content: message, userTag });
}
