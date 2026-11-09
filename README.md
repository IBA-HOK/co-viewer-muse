# Co-Viewer — P2P 動画同時視聴・共同操作 Web アプリ

GitHub Pages（静的 SPA）で動作する、P2P 型の動画同時視聴＆操作権限管理アプリです。
YouTube を MVP とし、ニコニコ動画は `postMessage` アダプター構造で対応しています。

---

## 機能一覧

| 分類 | 機能 | 詳細 |
|------|------|------|
| 接続 | P2P スター型（PeerJS） | ホストがルームID (= Peer ID) を生成。ゲストは招待URLで自動接続。 |
| 接続 | 切断・再接続ケア | 一時的な通信切断時に自動で再接続を試行（`usePeer` のリトライハンドラ）。 |
| 再生 | 同期再生 | `LOAD_MEDIA` / `PLAY` / `PAUSE` / `SEEK` / `SYNC_PING` で同期。 |
| 再生 | ズレ自動補正 | `SYNC_PING`（3秒ごと）で 1.5秒以上のズレを検知しシーク補正。YouTube では低性能端末の実測バッファ時間に応じて許容ズレを最大12秒まで拡大（2分で失効）。 |
| 再生 | 低性能端末フォールバック | バッファリング中・シーク直後は自動補正を保留。シーク要求は読み込み完了後に最新位置1回へ集約。補正が2回連続で効かない場合は自動追従を 20秒→40秒→60秒 と保留し、再生を優先（プレーヤーに「再同期」ボタンを表示）。 |
| 再生 | ループ防止 | `isRemoteSyncing` フラグで、P2P受信命令によるローカル変更検知の再送を抑制。シーク完了直後の PLAY も再送しない。 |
| 権限 | Host / Controller / Viewer | ホストは初期的に Controller を兼任。ホストが参加者リストから Controller を譲渡・共有可能。 |
| 権限 | Viewer 操作ブロック | Viewer にはプレーヤー上に透明オーバーレイを配置し、誤タップによるズレを物理的に防止。 |
| プラットフォーム | YouTube | YouTube IFrame Player API (`window.YT`) を使用。 |
| プラットフォーム | ニコニコ動画 | 公式埋め込みの `postMessage` 抽象インターフェース。再生不可時は原因別（埋め込み禁止 / 削除・非公開・限定公開）にメッセージを出し、「ニコニコで開く」リンクと「再読み込み」ボタンを表示。 |
| UX | 自動再生ポリシー対策 | ゲストが招待URLでアクセス時に「ルームに参加して再生を有効化」モーダルを表示。明示タップで再生をアンミュート／初期化し、以降の同期再生をブロックしない。 |
| 運用 | GitHub Pages デプロイ | `npm run build` 後、GitHub Actions 経由で GitHub Pages へ配備（`base: './'`）。 |

---

## 技術スタック

- **フレームワーク**: Vite + React + TypeScript
- **P2P 通信**: PeerJS（`peerjs`）— デフォルトのクラウドサーバー利用。将来のカスタムサーバー切り替えは `new Peer()` の引数で容易。
- **スタイル**: Tailwind CSS v4（モバイルファースト）

## ディレクトリ構成

```
src/
├── components/        # Player, QueuePanel, ParticipantList, JoinModal etc.
├── hooks/
│   ├── usePeer.ts           # PeerJS 初期化・接続管理・送受信
│   ├── useRoomSync.ts       # 同期イベント集約・ループ防止ガード
│   ├── useYouTubePlayer.ts  # YouTube IFrame API 操作（シーク集約・復帰時間計測）
│   └── useNiconicoPlayer.ts # ニコニコ postMessage 操作
├── sync/
│   └── driftGuard.ts        # 低性能端末向けズレ補正ポリシー（保留・バックオフ）
├── types/             # P2P メッセージ型・ルーム状態型
└── App.tsx
vite.config.ts         # base: './'（GitHub Pages 用）
.github/workflows/deploy.yml
serve.py               # Python による簡易静的サーバー
```

---

## セットアップと起動

### 1. 依存インストールと開発サーバー

```bash
npm install
npm run dev          # Vite 開発サーバー (http://localhost:5173)
```

### 2. 本番ビルド

```bash
npm run build        # tsc --noEmit 型チェック + vite build → dist/
```

### 3. Python での簡易ホスト（静的配信）

ビルド済みの `dist/` をシンプルな Python サーバーで配信できます。

```bash
npm run build                 # まず dist/ を生成
python3 serve.py              # http://localhost:8000/ で配信（ポート指定: python3 serve.py 8080）
```

あるいは Python 標準のコマンドでも可：

```bash
python3 -m http.server 8000 --directory dist
```

> アプリは `?room=<id>` というクエリパラメータのみを使用し、パスベースのルーティングは行わないため、一般的な静的ファイルサーバーでそのまま動作します。

---

## 動作テスト手順

P2P 同期は 2 つのクライアント間で確認します。**ホスト**と**ゲスト**を別ブラウザ／別デバイス／シークレットウィンドウで開いてください。

### A. ルーム作成と参加（自動再生対策）

1. **ホスト**: アプリを開くとルームIDが生成され、「招待URLをコピー」ボタンが表示される。これをコピー。
2. **ゲスト**: コピーした `?room=<ID>` 付き URL を別ウィンドウで開く。
3. 中央に「ルームに参加して再生を有効化」モーダルが表示される → **ボタンをタップ**する。
   - このタップ（ユーザージェスチャ）により以降の同期再生がブラウザの自動再生制限にブロックされなくなる。

### B. 同期再生の確認

1. ホストのコントロールパネルでプラットフォームを「YouTube」にし、YouTube の URL または動画ID を入力して「読み込み」。
2. ゲスト側にも同じ動画が読み込まれる（空のプレースホルダーが消える）。
3. ホストで「▶ 再生」「⏸ 一時停止」、シークバーを動かす → ゲストも同期して再生／停止／シークされる。
4. 意図的にズレが生じても、数秒以内に `SYNC_PING` で 1.5秒以上の差が補正される。

### C. 操作権限（Controller）の確認

1. 初期状態ではホストのみ操作可能。ゲストは Viewer 扱いで、プレーヤー上に透明なオーバーレイがあり誤タップがブロックされる。
2. ホストの「参加者」リストでゲストの「Controllerにする」をタップ。
3. ゲストのオーバーレイが消え、ゲストも再生／停止／シーク／動画変更ができるようになる（共有 Controller）。
4. 「Viewerにする」で再びブロックされる。

### D. ニコニコ動画の確認

1. プラットフォームを「ニコニコ動画」に切り替え、ニコニコの URL または動画ID（`sm9` 等）を入力して「読み込み」。
2. 埋め込みプレーヤーが表示される。
3. **再生できない動画**の場合、原因に応じたエラー UI が表示されます。
   - 投稿者が埋め込みを禁止している / プレミアム・チャンネル・有料(PPV)限定：「この動画は外部再生に対応していません」
   - 削除・非公開・限定公開など（詳細は埋め込み側で判別不可）：「この動画は再生できません（削除・非公開・限定公開の可能性）」
   - いずれの場合も「ニコニコで開く」リンクと「再読み込み」ボタンが表示され、ゲストの場合は「ホスト側では視聴できても視聴制限のある動画は再生できない場合がある」旨の補足が出ます。

### E. 再接続の確認

1. ゲスト側のネットワークを一時的に切り替える等で接続が切れた場合、自動で再接続が試行される。

### F. 低性能端末（ゲスト）のフォールバック確認

低スペックな端末・回線の遅い端末をゲストにして、以下を確認します。

1. ホストでシークバーを大きく動かす。
2. ゲストが読み込み中（バッファリング）の間、自動補正による再シークは発生しない。
   - 従来は3秒ごとの `SYNC_PING` が「読み込みで止まっている位置」をズレと判定し、再シーク→再読み込みのループになっていました。
3. 読み込み完了後、ズレがその端末の読み込み時間内に収まっていれば、**再シークせずそのまま再生を継続**します（許容ズレは実測値に応じて最大12秒）。
   - この間、プレーヤー左上に「ズレ X.Xs を許容中 · 再生優先」と「再同期」が表示されます（ズレを黙って放置しない）。
4. それでも補正が繰り返し効かない場合、ゲストのプレーヤー左上に「自動追従を保留中 · 再生優先」と「再同期」が表示され、自動補正が20秒停止します（繰り返すと40秒 → 60秒に延長。ズレが安定して解消すれば早期解除）。
5. 「再同期」を押すと、ホストの最新位置（最終 `SYNC_PING` からの経過時間で予測）へ1回だけ合わせ、自動補正を再開します。
   - プレーヤーには「再同期中 · ホスト位置に合わせています」が表示され、再同期シーク自体の読み込みで残ったズレは、次の再生可能なタイミングで基準の許容値（1.5秒）でもう一度だけ補正します。
   - 読み込み中に押した場合も、再生中の読み込みを中断せず、読み込み完了後に最新位置へ1回だけ移動します。
6. ホストがシークバーを動かした場合（ホスト時刻の不連続を `SYNC_PING.sentAt` で検出）は、フォールバック中・許容ズレ内であっても新しい位置に追従します。
   - ホスト側の単なる再バッファリング（再生位置の停止）はシークと誤判定しません。
7. このフォールバックのバッファリング検出・シーク直後の保留・保留バックオフは YouTube / ニコニコ共通です。実測バッファ時間による許容ズレ拡大は YouTube のみ（ニコニコは埋め込み API に再生位置の詳細イベントがないため）です。

調整用の定数は `src/sync/driftGuard.ts` にあります（`DRIFT_SETTLE_MS`, `DRIFT_ADAPTIVE_MAX_SEC`, `DRIFT_FALLBACK_HOLD_MS`）。

### G. 自動化 QA（Playwright）

手動と同じフローを 2 コンテキストで自動検証する Playwright スクリプトを作成可能です。
検証ポイント：ホスト参加者リストへのゲスト追加、`LOAD_MEDIA` の同期、Viewer オーバーレイの表示／Controller 譲渡での消去、およびコンソール上の非捕捉エラー不在。
（本リポジトリでは手動検証用スクリプトは含みませんが、上記 A〜E をそのまま自動化できます。）

---

## GitHub Pages へのデプロイ

1. このディレクトリを GitHub リポジトリとして `master` ブランチへ push する。
2. リポジトリの **Settings → Pages → Source** を **GitHub Actions** に設定。
3. `master` への push で `.github/workflows/deploy.yml` が実行され、`dist/` が GitHub Pages へ配備される（`vite.config.ts` の `base: './'` によりプロジェクトサイトのパスでも動作）。

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `VITE_TRANSPORT` | `peerjs` | Transport selection: `peerjs` (PeerJS P2P) or `mqtt` (MQTT WSS). Any other value falls back to `peerjs`. |
| `VITE_MQTT_BROKER_URL` | `wss://broker.emqx.io:8084/mqtt` | MQTT broker WebSocket URL used when `VITE_TRANSPORT=mqtt`. |

Hybrid mode: when `VITE_TRANSPORT=mqtt`, sync messages (`LOAD_MEDIA`, `PLAY`, etc.) travel over MQTT, while voice chat stays on PeerJS (`useVoiceChat` always uses the PeerJS transport). If MQTT does not connect within 5s, the app falls back to PeerJS for sync and logs `[transport] MQTT fallback to peerjs`.

Example:

```bash
VITE_TRANSPORT=mqtt VITE_MQTT_BROKER_URL=wss://broker.emqx.io:8084/mqtt npm run build
VITE_TRANSPORT=peerjs npm run build
```

---

## 注意事項

- **自動再生ポリティー**: モバイル Safari / Chrome では音声付き自動再生がブロックされます。必ずゲストの「参加して再生を有効化」タップを経由してください。
- **ニコニコ埋め込み制限**: 有料・チャンネル・プレミアム限定・地域制限・非公開の動画は、埋め込みプレーヤーでの再生ができません（エラー UI で案内）。本アプリは操作信号のみを同期するため、こうした視聴制限のある動画はゲスト側でも再生できません。「ニコニコで開く」で元動画の視聴可否をご確認ください。
- **ニコニコ埋め込みは HTTPS / localhost 必須**: ニコニコの埋め込み再生はセキュアコンテキスト（HTTPS または `localhost`）での接続を必要とします。`http://192.168.x.x:8000` のような**平文 HTTP の IP アドレス経由で開くと、ホストでも再生できません**（サムネイルは表示されます）。LAN で他の端末と共有する場合は、GitHub Pages 等の HTTPS 環境、または `ngrok` 等のトンネルで HTTPS 化してご利用ください。localhost での動作は問題ありません。
- **PeerJS サーバー**: デフォルトは公開クラウドブローカーを使用します。将来的に専用サーバーへ切り替える場合は `src/hooks/usePeer.ts` の `new Peer()` にオプションを渡すだけです。
