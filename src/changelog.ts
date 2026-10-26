// アップデート告知。新しいバージョンを先頭に追加すると、起動時に一度だけ
// #🌈ぴくたーちゃん と #📢お知らせ に投稿される（/data/announce_state.json で重複防止）。
export type ChangelogEntry = {
  version: string;
  date: string;
  title: string;
  items: string[];
  footer?: string;
};

export const CHANGELOG: ChangelogEntry[] = [
  {
    version: "2.0.0",
    date: "2026-10-27",
    title: "ぴくたーちゃん 2.0 にアップデートしたよ🥔✨",
    items: [
      "🧠 **かしこくなった！** ぜんぶ自分で考えて、必要なら調べものをしてからお返事するようになったよ",
      "🔗 **リンクの中身が読める！** Webページ・Xのポスト・YouTube・Discordのメッセージリンクを貼ってくれたら中身を見てお話できるよ",
      "🎬 **動画が見られる！** 動画を貼ってくれたら、コマを切り出して中身を見るよ（YouTubeは動画全体のコマから雰囲気をつかむよ。音はまだ聞こえないの🙏）",
      "📚 **他のチャンネルも参照できる！** 「アート広場で最近なに話してた？」「技術と質問のまとめして」みたいに聞いてね（あなたが見られるチャンネルだけ見るよ）",
      "🔎 **過去ログ検索・Web検索** 「前に〇〇の話してたのいつだっけ？」「〇〇の最新情報ある？」もおまかせ",
      "🎨 **お絵かき** 「〇〇描いて」で1人1日3枚まで描けるよ",
      "💬 **お話がもっと自然に** 流れを読んで、長さもちょうどよく、絵文字やサーバーのスタンプも使うようになったよ",
      "📝 **覚えておける** 好きなものや作風を覚えて、次のお話にいかすよ（/forget で忘れさせられるよ）",
      "🐛 **不具合・要望** 話の中で不具合や要望を伝えてくれたら、運営さんに届けるよ（/huguai /iken もそのまま使えるよ）",
    ],
    footer: "@ぴくたーちゃん でメンションするか、<#1273078367293276233> で話しかけてね！これからもよろしくね🫶",
  },
];

export const CURRENT_VERSION = CHANGELOG[0].version;

export function formatAnnouncement(entry: ChangelogEntry): string {
  return [
    `## ${entry.title}`,
    `-# v${entry.version}・${entry.date}`,
    "",
    ...entry.items.map((item) => `- ${item}`),
    "",
    entry.footer ?? "",
  ].join("\n").trim();
}
