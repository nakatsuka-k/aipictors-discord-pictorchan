# ぴくたーちゃん Discord Bot

Aipictors Discord のマスコット Bot。Fly.io（app: `pictorchan-bot`, nrt, 1 台）で常駐。

## 仕組み

メンション・返信・`#🌈ぴくたーちゃん` の発言に、xAI Responses API のツール呼び出しで答える。1 返信あたり基本 1 回の API 呼び出しで、必要なときだけツールを使う。

| ファイル | 役割 |
| --- | --- |
| `src/index.ts` | Discord イベント、スラッシュコマンド、告知、cron |
| `src/agent.ts` | プロンプト、ツールループ、後処理（絵文字・長さ） |
| `src/tools.ts` | チャンネル閲覧/検索、URL・メディア閲覧、記憶、意見投稿、画像生成 |
| `src/web.ts` | Web/X(fxtwitter)/YouTube(概要欄+ストーリーボード) の読み取り |
| `src/media.ts` | SSRF 対策付き fetch、画像変換、ffmpeg で動画のコマ切り出し |
| `src/store.ts` | `/data` の JSON 永続化（遅延まとめ書き込み） |
| `src/changelog.ts` | アップデート告知の内容 |

- 他チャンネルは「質問した人が見られるチャンネル」だけ読む。別サーバーは読まない。
- 画像生成は 1 人 1 日 3 枚・全体 30 枚まで（`src/config.ts`）。
- モデルは環境変数 `CHAT_MODEL` / `TEXT_MODEL` / `GROK_VISION_MODEL` で差し替え可能。Web/X 検索は `ENABLE_WEB_SEARCH=0` で無効化。

## アップデート告知

`src/changelog.ts` の `CHANGELOG` 先頭に新しいバージョンを追加してデプロイすると、起動時に一度だけ `#🌈ぴくたーちゃん` と `#📢お知らせ` に投稿される（`/data/announce_state.json` で重複防止）。

## デプロイ

```sh
yarn install && yarn build   # 型チェック
flyctl deploy -a pictorchan-bot --remote-only
```

Secrets: `DISCORD_TOKEN` `GROK_API_KEY` `CLIENT_ID` `OPINION_CH_ID` `BUG_CH_ID` `GH_TOKEN` `GH_OWNER` `GH_REPO`（`flyctl secrets list -a pictorchan-bot`）。
