---
slug: nothing-philosophy-ui-audit
status: drafting
intent: unclear
review_required: false
plan_path: .omo/plans/nothing-philosophy-ui-audit.md
plan_sha256: 8f595d3e88e0d74d2596053d07d02920b12a4a9838d45d47faef4b899d26f8ef
review_round_id: f4-seal-20260830
pending-action: done
review:
  momus:
    status: approved
    workspace_root: /home/hokutoi/github/co-viewer
    runtime_home: /home/hokutoi
    target: .omo/plans/nothing-philosophy-ui-audit.md
    round_id: f4-seal-20260830
    plan_sha256: 8f595d3e88e0d74d2596053d07d02920b12a4a9838d45d47faef4b899d26f8ef
    launch_id: f4-philosophy-linter
    session: null
    result: pass
  independent:
    status: approved
    workspace_root: /home/hokutoi/github/co-viewer
    runtime_home: /home/hokutoi
    target: .omo/plans/nothing-philosophy-ui-audit.md
    round_id: f4-seal-20260830
    plan_sha256: 8f595d3e88e0d74d2596053d07d02920b12a4a9838d45d47faef4b899d26f8ef
    launch_id: f4-philosophy-linter
    session: null
    result: pass
approach: NOTHING哲学に則ったUI/体験の修正計画 — 減算的ミニマル + 透明性 + Glyph的アンビエントという3原則で現状の注意窃取(attention theft)と隠蔽を正す。小チーム・プロトタイプ精神(市場調査はしない)を保ちつつ、賛否両論の議論を経てMANDATEDのみを計画する。
---

# Draft: nothing-philosophy-ui-audit

## Components (topology ledger)
<!-- Lock the SHAPE before depth. One row per top-level component that can succeed or fail independently. -->
| id | outcome | status | evidence path |
|---|---|---|---|
| C1 | Playerのアンビエント化 — LOCKED全面オーバーレイを撤廃しGlyph的枠・注記へ置換、scanline/REC等の注意窃取を削減 | active | src/components/Player.tsx:202-235, src/index.css:109-131 |
| C2 | Browserの減算 — PREVIEW自動再生iframe撤廃・サムネ優先・NICO/YouTube二刀流の絞り込み | active | src/components/BrowserPanel.tsx:274-296, src/components/browserParser.ts |
| C3 | Join導線の統一 — showJoinInputゲート撤廃・二重導線(ヘッダー埋め込み + 全画面モーダル)の統一、iOSジェスチャー要請を保ったままボトムシート化 | active | src/App.tsx:472-520, src/components/JoinModal.tsx:11-33 |
| C4 | 状態の透明化 — SYSTEMバーとヘッダーバッジの二重真実源を一元化、SYNC/接続状態のGlyph的脈動(任意)設計 | active | src/App.tsx:384-445, src/hooks/useRoomSync.ts:202-210 |
| C5 | 共有トグル分離と空状態の温もり — PEERS/VOICEのpeers-voice-expanded共有キー分離、Queue/Player/BrowserのEMPTY/NO SIGNALのWakuwaku化 | active | src/components/ParticipantList.tsx:35-62, src/components/VoiceChatPanel.tsx:35-72, src/components/QueuePanel.tsx:144-146 |
| C6 | デッドコード/密度是正 — ControlPanel.tsx撤去、VolumeMixerの密度是正とネイティブスライダーの工業的一貫性 | active | src/components/ControlPanel.tsx:1-79, src/components/VolumeMixerPanel.tsx:82-188 |

## Open assumptions (announced defaults)
<!-- Intent is UNCLEAR: research resolves ambiguity, defaults are adopted (not asked), and each is surfaced in the plan's human TL;DR for veto. -->
| assumption | adopted default | rationale | reversible? |
|---|---|---|---|
| 修正範囲 | 破壊的リデザインではなく減算的パッチ。色/タイポ/トークン(--nothing-*)は維持 | 現行のNOTHINGトークン(黒#050507, 赤#FF1A1A, DotGothic16)は哲学に忠実。直すのは相互作用の注意窃取のみ | yes |
| 市場調査はしない → 小チーム味 | サーベイやペルソナ追加なし、プロトタイプ優先。MANDATED 3件のみを必須化、残りはNICE-TO-HAVEとして波分け | 哲学の「少人数でイノベーティブ」は過剰最適化を禁じる。保守派の指摘を採用 | yes |
| Glyphの解釈 | Glyphは装飾でなく節制(1pxヘアライン、脈動は環境光)。通知は増やさない | 記事引用: 「スマホの画面を下にして置く推奨」「UBERが来たらアプリ開かず分かる」 | yes |
| 透明性の解釈 | 中身を見せる=UIに真実を露出。amビアンスな露出(枠/Glyph)とし、常時スティッキーなダッシュボード化は避ける | 公開ソース: 10-20面を設計、螺子をグラフィックに | yes |
| JoinのiOS制約 | 全画面ブロックはジェスチャー確保のため維持するが、形をボトムシート化して文脈を遮断しない | App.tsx:118-121 controllerRef.play()が失敗すると以降の同期が全滅 | yes |
| 言語 | UIの主要言語は日本語混在を維持しつつ、ラベルはNOTHING流の英語Mono(10px uppercase)で統一、エラー補足は日英併記 | 現行混在(招待URL/-room)は哲学の透明性と同じく「正直さ」を優先 | yes |

## Findings (cited - path:lines)
- 哲学抽出: 市場調査はしない(H2@デザイン哲学.txt L79, P 2e8b22.../c4ea...), 透明なボディ(P 1d7ca..., 45dcb...「透明性へのこだわり...スタジオをオープン」), Glyphの反注意経済(P 65cfb...「アプリたちはスクリーンタイムを伸ばす」, P 784de...「画面を下にして置く」, P a1d5b4...「こっちを見て！誤解」), 理想と現実バランス(P ea85a...蘆田質問「スマホ無しで生活」→「現文明では難しく改善余地」), 愛されるvsファンコミュ(H2 b094...「市場調査はしないがコミュニティからフィードバック」+任天堂トライブ), ワクワクを戻す(H2 final「テクノロジーにワクワクを取り戻す」「無機質で冷たく」+蛸/昆虫の有機的温もり), Dot-Matrix/層剥離(NDot, Glyph Matrix)
- 現行トークン忠実: src/index.css:8-27 (--nothing-bg #050507, --nothing-red #FF1A1A, --nothing-grid-dot 0.035, フォント DotGothic16/JetBrains Mono/IBM Plex Sans JP), src/App.tsx:407-421 3x3ドットグリフ+赤レジストマーク
- Playerの注意窃取: src/components/Player.tsx:202 nothing-scanline + :206 REC ● + :209 platform·videoIdバッジ + :238-246 fullscreenトグル = 4つの注意窃取。:225-235 LOCKED全面bg-black/55 backdrop-blurはGlyphの節制に反し映像を奪う
- Browser肥大: src/components/BrowserPanel.tsx:161-183 汎用二刀流(YT/NICO) + :193-202 sort 4種 + :238-265 1件4ボタン + :289 preview iframe h-64 autoplay = 最も層化したパネル。collapsed時は正しい(28-35, 147 TAP OPEN)
- Join二重導線: src/App.tsx:472-520 header内JOIN( showJoinInput:falseゲート) + src/components/JoinModal.tsx:11 fixed inset-0 bg-black/80 backdrop-blur が同時存在。roomIdFromUrl:19 経由のinvite運用が主だが、手入力導線が隠蔽
- 二重真実源: src/App.tsx:384-399 SYSTEMバー P2P·STAR(スクロールで消える) vs :430-435 header内HOST/GUESTバッジが重複
- 共有トグル結合: src/components/ParticipantList.tsx:35-62 と src/components/VoiceChatPanel.tsx:35-72 が同一キー co-viewer:peers-voice-expanded + CustomEvent peers-voice-expandedで結合。片方開くと両方開く驚き
- 空状態の冷たさ: src/components/QueuePanel.tsx:145 EMPTY, src/components/Player.tsx:221 NO SIGNAL, src/components/BrowserPanel.tsx:133 IDLE — 全て工業的モノクロでWakuwaku欠如
- 死蔵: src/components/ControlPanel.tsx:1-79 LOAD INPUTがApp.tsx:5-12で未import(デッド)。VolumeMixer密度: src/components/VolumeMixerPanel.tsx:82-188 2platform + master + N peers = 5+スライダー
- DriveModeは哲学的模範: src/components/DriveModePanel.tsx:18 if(!isHost && !driveMode)return null, :23-24 collapsed既定, 理想と現実を両立

## Decisions (with rationale)
- 減算を原則に: 追加ではなく撤廃・置換で直す。NOTHINGの「層を剥がす」(DesignWanted/Bates)と整合
- MANDATED 3件のみを必須化: 2 LOCKED→環境ロック、3 Preview→サムネ優先、5 Join統一(ゲート撤廃+モーダルのボトムシート化)。賛否両論の審判で(a)喜びを隠す/奪う(b)撤廃で直る、の両条件を満たすため
- NICE-TO-HAVEは波分け: SYNC脈動・トースト→Glyph、スティッキー化、DriveMode常時表示はコミュニティ要望が出るまで延期。保守派の「市場調査はしない」警告を尊重
- タイポ/色を変えない: DotGothic16/JetBrains Mono/黒白赤/2px半径/1px境界は維持。shadcn等の追加依存なし

## Scope IN
- Player LOCKEDのGlyph的置換、scanline/REC等の注意削減
- Browser Previewの非自動再生化、サムネ優先、ボタン密度削減、重複エンジン整理の是非検討
- Join導線のゲート撤廃、JoinModalの非遮断化(ボトムシート/バナー化)
- 状態表示の一元化(単一真実源への収斂、スクロール挙動是正)
- PEERS/VOICEトグル分離、空状態Wakuwaku化、ControlPanel撤去

## Scope OUT (Must NOT have)
- 新色・新フォント・新UIライブラリ(shadcn等)導入。トークンは --nothing-* のみ
- ガジェット/バッジ/ポイント等のファンコミュ的ゲーミフィケーション。トライブは一貫したトークンで育てる
- SYNC_PINGの間隔/閾値(SYNC_PING_INTERVAL 3000, SYNC_DRIFT_THRESHOLD 1.5s)の変更。挙動は透明化のみ
- PeerJSクラウドブローカーの置換(実運用で必要になるまで)
- ニコニコ/YouTubeの取得プロキシの大規模再設計

## Open questions
- なし(UNCLEARのためデフォルトを採用しTL;DRで拒否可能化)。唯一の不可逆はJoinのブロック性緩和→iOS自動再生失敗時のフォールバック文言で担保

## Approval gate
status: awaiting-approval
approach: 減算的NOTHING監査 — 6コンポーネントに跨るが、必須(MANDATED)は3件の撤廃/置換に絞り、残りはNICE-TO-HAVE波で段階化。小チーム味を保ちつつ、Glyph的節制と透明性を取り戻す。詳細は .omo/plans/nothing-philosophy-ui-audit.md に展開予定
pending-action: done
