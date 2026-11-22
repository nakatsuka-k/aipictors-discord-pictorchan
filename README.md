# ぴくたーちゃん Discord Bot

Aipictors Discord のマスコット Bot。Cloudflare Workers（Worker `pictorchan-bot`、Aipictors のアカウント）の Durable Object `Bot` 1 個で常駐する。Container は使わない。

## 仕組み

- Durable Object `Bot` が Discord Gateway の WebSocket を外向きに張る（`src/gateway.ts`。heartbeat・resume・再接続を自前で行う）。毎分の cron と 30 秒ごとの alarm が、切れていたら繋ぎ直す。
- discord.js は Workers で動かないので、REST・キャッシュ・権限計算は `src/discord.ts` に必要な分だけ持つ。
- メンション・返信・`#🌈ぴくたーちゃん` の発言に、Gemini 3.5 Flash-Lite（失敗・安全フィルターで止まったら Grok）のツール呼び出しで答える。

| ファイル | 役割 |
| --- | --- |
| `cloudflare/worker.ts` | Worker 本体（cron、管理用 API、Durable Object `Bot`。`Runner` は前の Container 版） |
| `src/gateway.ts` | Discord Gateway の接続 |
| `src/bot.ts` | Discord イベント、スラッシュコマンド、告知、定期の処理（日記） |
| `src/discord.ts` | Discord REST・キャッシュ・権限計算 |
| `src/agent.ts` | プロンプト、ツールループ、後処理（絵文字・長さ） |
| `src/tools.ts` | チャンネル閲覧/検索、URL・メディア閲覧、記憶、意見投稿、画像生成 |
| `src/web.ts` | Web/X(fxtwitter)/YouTube(概要欄+ストーリーボード) の読み取り（HTMLRewriter） |
| `src/media.ts` | fetch、画像の縮小（Cloudflare Images）、動画のコマ切り出し（Media Transformations） |
| `src/state.ts` / `src/store.ts` | R2 `pictorchan-state` の JSON を起動時に読み込み、変更をまとめて書き戻す |
| `src/changelog.ts` | アップデート告知の内容 |

- 他チャンネルは「質問した人が見られるチャンネル」だけ読む。別サーバーは読まない。
- 画像生成の上限は `src/config.ts`。
- 動画は MP4/MOV なら長さと音声の有無を読んで等間隔に 6 コマ。WebM などは最初の 12 秒から数コマ。100MB まで。

## アップデート告知

`src/changelog.ts` の `CHANGELOG` 先頭に新しいバージョンを追加してデプロイすると、起動時に一度だけ `#🌈ぴくたーちゃん`（と `#📢お知らせ`）に投稿される（R2 の `announce_state.json` で重複防止）。

## デプロイ

```sh
corepack yarn install && corepack yarn typecheck
set -a; . ~/.config/aipictors/cloudflare.env; set +a
npx wrangler deploy
```

デプロイすると Durable Object が再起動し、30 秒以内に alarm（遅くとも毎分の cron）で繋ぎ直す（セッションを resume するので、その間のメッセージにも返事する）。

Secrets: `DISCORD_TOKEN` `GROK_API_KEY` `GEMINI_API_KEY` `CLIENT_ID` `OPINION_CH_ID` `BUG_CH_ID` `GH_TOKEN` `GH_OWNER` `GH_REPO` `DISCORD_BOT_API_TOKEN` `ADMIN_TOKEN` `BOT_ADMIN_TOKEN`（`npx wrangler secret list`）。

## 管理用 API

`Authorization: Bearer $BOT_ADMIN_TOKEN`（値は `~/.config/aipictors/pictorchan-bot-admin.env`）。

- `POST https://pictorchan-bot.aipictors.workers.dev/__admin/bot/status` 状態（接続・最後の heartbeat）
- `/__admin/bot/stop` 止める（記憶を R2 に書き出してから切断）／ `/__admin/bot/start` 動かす
- `/__state/<file>` R2 の記憶の読み書き

新旧が同時に Gateway に繋がると二重に返事するので、片方を止めてからもう片方を動かす。

## 前の Container 版に戻す

`Runner`（Cloudflare Containers、イメージは `wrangler.jsonc` で digest 固定）はまだ残してある。`/__admin/bot/stop` で Worker 版を止めてから `/__admin/start` で Container 版を起動する（`/__admin/stop`・`/__admin/status` も同じ）。
