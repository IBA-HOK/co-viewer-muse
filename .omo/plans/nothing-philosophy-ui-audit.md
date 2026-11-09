<!-- sha256: 1a71dc8aafdbdf8c9fe844ae0495ffbcfa57f57e2b02c72c07b62bde141ec950 -->
# nothing-philosophy-ui-audit - Work Plan

## TL;DR (For humans)

**What you'll get:** NOTHING哲学（減算・透明性・Glyph的アンビエント）に照らしたUI修正を完成品としてお届け。映像を奪っていた全面LOCKEDオーバーレイと自動再生プレビュー、隠れたJOIN導線を撤廃し、状態表示と空状態に温もりを足す。色/フォントはそのまま。

**Why this approach:** 「市場調査はしない＝小チームでプロトタイプ」という哲学を尊重し、必須の減算3件だけをMANDATED化し残りは可逆なNICE-TO-HAVE波に分離。追加ではなく撤廃で直す。

**What it will NOT do:** 新色/新フォント/shadcn等の追加、バッジ/ポイント等のゲーミフィケーション、SYNC間隔1.5s/3s変更、PeerJS置換、プロキシ再設計はしない。

**Effort:** Medium (11プロダクトTODO + 3検証)
**Risk:** Low - 減算パッチ中心、可逆コミット、既存トークンのみ
**Decisions I made for you:** LOCKEDは赤ヘアライン+VIEWERラベルに置換(映像は隠さない)、プレビューはサムネ優先でiframeはQUEUEまで載せない、JOINはゲート撤廃+モーダルをボトムシート化(ジェスチャーは保持)、SYNC脈動はSYNC_PING再利用の300ms box-shadow脈動で新規タイマー0、sortはrelevance|viewsの2択に縮退、空状態コピーは3箇所で文字列固定、言語は英Mono+日補足のまま、全localStorageキーは移行付きで分離。

Your next move: approve → Wave1(3並列)から着手。 Full execution detail follows below.

---

> TL;DR (machine): Medium Effort, Low Risk, 11 product + 3 verification todos - philosophy-faithful subtraction

## Scope
### Must have
- C1 Player LOCKED→ambient border+label, scanline/REC/badge/fullscreen restraint (subtraction)
- C2 Browser preview non-autoplay thumbnail-first, per-result button reduction, engine/sort audit
- C3 Join gate removal, JoinModal non-blocking bottom-sheet, preserving handleJoinConfirm gesture
- C4 State single truth (SYSTEM vs header), ambient SYNC Glyph (no new timers)
- C5 Toggle split peers-voice-expanded → peers-expanded/voice-expanded with migration, empty-state Wakuwaku (Queue/Player/Browser)
- C6 Dead ControlPanel removal, VolumeMixer density + industrial consistency

### Must NOT have (guardrails, anti-slop, scope boundaries)
- 新色/新フォント/UIライブラリ(shadcn/radix) — --nothing-* のみ (src/index.css:8-27)
- ゲーミフィケーション(badges/points) — tribeは一貫トークンのみ
- SYNC_PING_INTERVAL / SYNC_DRIFT_THRESHOLD 値変更
- PeerJSクラウドブローカー置換
- browserParser.ts プロキシ大規模再設計

## Verification strategy
> Zero human intervention - all verification is agent-executed.
- Test decision: tests-after + vitest 4.1.11 (`npm run test`), 新回帰2件(preview anti-iframe, toggle split)のみ追加
- Evidence: .omo/qa/task-<N>-nothing-philosophy-ui-audit.<ext> + .omo/qa/f1-test.log, f2-lsp.json, f3-visual-qa.md, f4-philosophy-linter.log
- Type: `npm run build` (tsc --noEmit) + lsp_diagnostics clean per todo
- Visual: playwright + visual-qa skill, 1280x800 + 375x812, pixel diff ≤8% except subtraction
- Philosophy linter: grep no new hex outside index.css, no shadcn, SYNC constants 3000/1.5 unchanged

## Execution strategy
### Parallel execution waves
> Target 5-8 todos per wave. Fewer than 3 (except the final) means you under-split.

- Wave 1 (MANDATED, no deps): 1, 2, 3 in parallel
- Wave 2 (MANDATED cont.): 4 (←1), 5 (←3) in parallel
- Wave 3 (NICE-TO-HAVE gated): 6, 7, 8, 9 in parallel → 10 after 8 → 11 after 9
- Wave 4 (Verification sequential): 12 → 13 → 14

### Dependency matrix
| Todo | Depends on | Blocks | Can parallelize with |
| --- | --- | --- | --- |
| 1 Player LOCKED ambient | - | 4,8,12 | 2,3 |
| 2 Browser preview thumbnail | - | 10,12 | 1,3 |
| 3 Join gate removal | - | 5,6,12 | 1,2 |
| 4 Player thieves reduction | 1 | 8,12 | 5 |
| 5 JoinModal bottom-sheet | 3 | 6,12 | 4 |
| 6 State single truth | 3,5 | 12 | 7,8,9,10 |
| 7 PEERS/VOICE split | - | 12 | 6,8,9,10 |
| 8 Empty Wakuwaku | 1,4 | 10,12 | 6,7,9 |
| 9 Dead ControlPanel | - | 11,12 | 6,7,10 |
| 10 Browser density | 2,8 | 12 | 6,7,9 |
| 11 Mixer density | 9 | 12 | 6,7,10 |
| 12 Tests | 1-11 | 13 | - |
| 13 LSP clean | 12 | 14 | - |
| 14 Visual QA + linter+hash | 13 | - | - |

## Todos
- [ ] 1. Player LOCKEDをambient Glyph枠へ置換
  What to do / Must NOT do: src/components/Player.tsx:225-235 の bg-black/55 backdrop-blur 全面オーバーレイを削除。nothing-glyph + border-[var(--nothing-red)]/30 + VIEWERラベル(11px, --nothing-text-dim)をchrome内に表示、aspect-videoは覆わない。canControl gatingは useRoomSync.ts:665-667 で維持、driveMode分岐は触らない。Must NOT 新色/新トークン追加、Must NOT 外部ライブラリ。
  Parallelization: Wave 1 | Blocked by: - | Blocks: 4,8,12
  References (executor has NO interview context - be exhaustive): src/components/Player.tsx:7-22,225-235,201-212,142-166, src/index.css:110-115, src/hooks/useRoomSync.ts:665-667, src/App.tsx:294-312
  Acceptance criteria (agent-executable): Player.tsx:225-235 に absolute inset-0 覆いが無い、ambient 赤ヘアライン+VIEWERラベルがchrome内で可視、viewerタップで PLAY/SEEK を発火しない（grep -n "canControl" src/hooks/useRoomSync.ts:665 保持 + regression spy canControl===false→controllerRef.play() not called）、isGuestDrive unchanged、npm run build pass + lsp_diagnostics clean
  QA scenarios (name the exact tool + invocation): happy Viewersee video+hairline no broadcast (playwright screenshot .omo/qa/m1-viewer-ambient.png) + failure Controller delegation restores control (.omo/qa/m1-controller-restored.png) + failure Drive AUDIO ONLY intact (.omo/qa/m1-drive-audio-only.png), Evidence .omo/qa/task-1-nothing-philosophy-ui-audit.png
  Commit: Y | fix(player): ambient VIEWER frame replaces LOCKED blur overlay (M1)

- [ ] 2. Browser previewをサムネ優先・非自動再生化
  What to do / Must NOT do: src/components/BrowserPanel.tsx:289-294 の iframe src={embedUrl(preview)} h-64 を削除し <img src={thumbnail}> h-36 + title + QUEUE/SAVE 2ボタンに置換。autoplay/allow="autoplay"をBrowserPanelから全除去。embedUrl自体は残置可だがpreviewで呼ばない。Must NOT browserParser.ts:228-233 のURLヘルパー変更。
  Parallelization: Wave 1 | Blocked by: - | Blocks: 10,12
  References (executor has NO interview context - be exhaustive): src/components/BrowserPanel.tsx:46,274-296,215-223,105,107-110, src/components/browserParser.ts:228-233, src/components/Player.tsx:147-149
  Acceptance criteria (agent-executable): BrowserPanel.tsx:289-294 に iframe が無い、img h-36で thumbnail 表示、grep -R "embedUrl" src/components/BrowserPanel.tsx で previewヒット0、onAddToQueue(watchUrl)単一経路維持、build+lsp clean
  QA scenarios (name the exact tool + invocation): happy PREVIEWで img 表示 Network 0 embed (.omo/qa/m3-preview-thumbnail.png + HAR) + failure Bookmark add可 (.omo/qa/m3-bookmark-from-preview.png) + failure sort 4種順序保持 (.omo/qa/m3-sort-views.png), Evidence .omo/qa/task-2-nothing-philosophy-ui-audit.png
  Commit: Y | fix(browser): thumbnail-first preview removes autoplay iframe (M3)

- [ ] 3. Joinゲート撤廃 — ヘッダー単一導線化
  What to do / Must NOT do: src/App.tsx:55-56,479-518 の showJoinInput stateと setShowJoinInput(true)ゲートを削除。!roomIdFromUrl 分岐で joinInput + 参加(Primary) / キャンセル(クリア)行を常時表示。extractRoomId:25-31 と handleJoinByLink:143-150 ロジックは保持。Must NOT ?room= 遷移ロジック変更。
  Parallelization: Wave 1 | Blocked by: - | Blocks: 5,6,12
  References (executor has NO interview context - be exhaustive): src/App.tsx:55-56,143-150,472-520,19-23, src/types/index.ts:106-139
  Acceptance criteria (agent-executable): showJoinInput 変数削除、!roomIdFromUrl で常に input可視、invalid時 joinError「招待URL または ルームIDを確認してください」、roomIdFromUrl truthy時は JOIN区画非表示、Enterで handleJoinByLink、build+lsp clean
  QA scenarios (name the exact tool + invocation): happy /? で input可視 abcd1234 Enter→?room=abcd1234 (.omo/qa/m4-join-visible.png) + failure full URL ?room=XYZ&x=1 → XYZ抽出 (.omo/qa/m4-extract-room.png) + failure ?room=exists で header JOIN非表示 (.omo/qa/m4-with-room-hidden.png), Evidence .omo/qa/task-3-nothing-philosophy-ui-audit.png
  Commit: Y | fix(join): remove showJoinInput gate, expose Join field by default (M4)

- [ ] 4. Playerの注意窃取4点を削減
  What to do / Must NOT do: src/components/Player.tsx:201-247 の nothing-scanline 除去/低opacity化、REC ●:205-207 と platform·videoIdバッジ:208-212 を opacity-40 9px へ縮退(hidden sm維持、中央を覆わない)、fullscreenトグル:238-247 を opacity-60 idle / group-hoverで100% に。App.tsx:407-421 の3x3ドットグリフと赤レジストは保持。Must NOT 新トークン追加。
  Parallelization: Wave 2 | Blocked by: 1 | Blocks: 8,12
  References (executor has NO interview context - be exhaustive): src/components/Player.tsx:201-247, src/index.css:117-131,140-142, src/App.tsx:407-421, src/components/DriveModePanel.tsx:18
  Acceptance criteria (agent-executable): index.css:118-131 scanlineがPlayer chromeから除去 or opacity<0.015でvideo背後に、REC/badgeが opacity-40 9pxで中央非覆い、fullscreen mono 10px opacity-60→hover100% で aria-label保持、新色/サイズ無し、build+lsp clean
  QA scenarios (name the exact tool + invocation): happy NO SIGNALで ◇表示だがscanline無し (.omo/qa/m2-no-signal.png) + happy playing中央に競合オーバーレイ0 (.omo/qa/m2-playing-clean.png) + failure prefers-reduced-motion維持 (.omo/qa/m2-reduced-motion.png), Evidence .omo/qa/task-4-nothing-philosophy-ui-audit.png
  Commit: Y | refactor(player): reduce scanline/REC/badge/fullscreen attention thieves (M2)

- [ ] 5. JoinModalをbottom-sheet化(非遮断)
  What to do / Must NOT do: src/components/JoinModal.tsx:11 の fixed inset-0 bg-black/80 backdrop-blur 全画面トラップを fixed inset-x-0 bottom-0 z-40 sheetへ再構築(nothing-panel + nothing-glyph上線、max-w-[640px] mx-auto、scrim bg-black/30のみ、backdrop-blur≤8pxはsheetのみ)。onConfirm→handleJoinConfirm:118-121 の play()+setJoined(true)単一路徑を保持、open={!peer.isHost && !joined}:600-604 駆動。Must NOT 追加副作用。
  Parallelization: Wave 2 | Blocked by: 3 | Blocks: 6,12
  References (executor has NO interview context - be exhaustive): src/components/JoinModal.tsx:1-37, src/App.tsx:118-121,600-604, src/hooks/usePeer.ts, src/index.css:78-88
  Acceptance criteria (agent-executable): JoinModalが fixed inset-x-0 bottom-0 sheetで nothing-panel+glyph、scrim 30% でクリックはplay semanticsをブロックしない、roomIdFromUrl+!joinedで表示、CTA後に translate-y-full で退場、Player fullscreenやbodyスクロールを遮断しない、build+lsp clean
  QA scenarios (name the exact tool + invocation): happy Guest ?room=HOSTID で Queue/Playerが見える位置にsheet、JOINタップで同期 (.omo/qa/m5-bottom-sheet.png) + failure ?room無しでsheet非表示 (.omo/qa/m5-no-room-no-sheet.png) + failure Hostは常時非表示 (.omo/qa/m5-host-no-sheet.png), Evidence .omo/qa/task-5-nothing-philosophy-ui-audit.png
  Commit: Y | fix(join): JoinModal bottom-sheet, preserve autoplay gesture (M5)

- [ ] 6. State単一真実源化 + SYNC脈動(実装固定)
  What to do / Must NOT do: src/App.tsx:384-399 の SYSTEMバーと 430-435 headerバッジの重複を headerバッジ(HOST/GUEST/CONNECTING + red/amber dot)に一元化。SYSTEMバーは削除 or h-px nothing-glyph opacity-40 線のみに。SYNC脈動は handleIncoming SYNC_PING:234-248 経由で const [isSyncPulse,setPulse]=useState(false) を App.tsx に追加 → handleIncoming内で setPulse(true); setTimeout(()=>setPulse(false),300) → .nothing-glyph に box-shadow var(--nothing-red-glow) を isSyncPulse時のみ適用、新規 setInterval 0 を grep -R "setInterval" src/App.tsx で検証。Must NOT SYNC_PING_INTERVAL 3000 / THRESHOLD 1.5変更。
  Parallelization: Wave 3 | Blocked by: 3,5 | Blocks: 12
  References (executor has NO interview context - be exhaustive): src/App.tsx:384-399,401-445,103-106,392-396, src/hooks/useRoomSync.ts:202-210,234-248,637-648, src/types/index.ts:100-104, src/index.css:110-115
  Acceptance criteria (agent-executable): header badgeのみが HOST/GUEST/CONNECTING+dotを表示、SYSTEMバーは重複バッジ無し、パルスはSYNC_PING再利用で新規タイマー無し（grep setInterval 0）、inviteCopied CTAはheaderに残置、grep SYNC_PING_INTERVAL→3000 保持、build+lsp clean
  QA scenarios (name the exact tool + invocation): happy Connected HOSTで single red dotのみ (.omo/qa/n1-single-truth.png) + failure peer.connected=falseで amber CONNECTING 単独 (.omo/qa/n1-disconnected.png) + failure 30s再生で ping cadence 3000ms維持 (.omo/qa/n1-ping-cadence.har), Evidence .omo/qa/task-6-nothing-philosophy-ui-audit.png
  Commit: Y | refactor(header): single truth badge, ambient SYSTEM glyph (N1)

- [ ] 7. PEERS/VOICE共有トグル分離
  What to do / Must NOT do: src/components/ParticipantList.tsx:35-62 と src/components/VoiceChatPanel.tsx:35-72 の共用キー co-viewer:peers-voice-expanded + CustomEvent peers-voice-expanded を co-viewer:peers-expanded / co-viewer:voice-expanded へ分離。初回レンダで旧キーが存在し新キー無ければ legacy==='1' を両方へ複製し旧キー削除。CustomEvent派遣/購読を削除し各panelは storage のみ購読。vcActive自動展開:71 はvoiceキーのみに作用。Must NOT 駆動ロジック以外変更。
  Parallelization: Wave 3 | Blocked by: - | Blocks: 12
  References (executor has NO interview context - be exhaustive): src/components/ParticipantList.tsx:35-62, src/components/VoiceChatPanel.tsx:35-72, src/components/DriveModePanel.tsx:20-28
  Acceptance criteria (agent-executable): ParticipantListは peers-expanded、VoiceChatPanelは voice-expanded を使用、共用定数0、旧キー移行で新両方へ複製後旧削除、CustomEvent peers-voice-expanded 派遣/購読0、vcActiveはvoiceのみに作用、build+lsp clean
  QA scenarios (name the exact tool + invocation): happy PEERS展開≠VOICE (.omo/qa/n2-split.png DOM assert peers 1 voice 0) + failure 旧1移行で両1後旧削除 (.omo/qa/n2-migration.png) + failure リロード後 per-panel永続 (.omo/qa/n2-persistence.png), Evidence .omo/qa/task-7-nothing-philosophy-ui-audit.png
  Commit: Y | fix(peers-voice): split shared toggle into independent keys with migration (N2)

- [ ] 8. 空状態にWakuwaku温もり付与
  What to do / Must NOT do: Queue EMPTY:144-147→「◇ EMPTY」下に nothing-glyph opacity-30 + nothing-label + 10px「TAP BROWSER TO SEARCH · YT / NICO」 + 8px「メディアを追加してね」表示。Player NO SIGNAL:216-223→「◇ NO SIGNAL」下に 10px「YOKOSO · LOAD MEDIA TO START」+ 8px「キューかブラウザから選んでね」維持 aspect-video中央。Browser IDLE:133/146-148→ IDLE pill維持 + 10px「◆ さあ、検索 — YT / NICO」温もり行。◇/◆/◌のみ、新イラスト無し。Must NOT 新フォント/色/トークン。
  Parallelization: Wave 3 | Blocked by: 1,4 | Blocks: 10,12
  References (executor has NO interview context - be exhaustive): src/components/QueuePanel.tsx:144-147, src/components/Player.tsx:216-223, src/components/BrowserPanel.tsx:133-135,146-148, src/index.css:8-27
  Acceptance criteria (agent-executable): Queue emptyで上記3文字列が可視、Player NO SIGNALでYOKOSO可視、Browser IDLEで「さあ、検索」可視、新トークン無し、build+lsp clean
  QA scenarios (name the exact tool + invocation): happy fresh空3点で温もり行triptych (.omo/qa/n3-empties-warm.png) + failure 1本ロード後 empty温もり消失 (.omo/qa/n3-after-load.png), Evidence .omo/qa/task-8-nothing-philosophy-ui-audit.png
  Commit: Y | feat(empty): add Wakuwaku microcopy warmth to Queue/Player/Browser (N3)

- [ ] 9. 死蔵ControlPanel撤去
  What to do / Must NOT do: src/components/ControlPanel.tsx:1-79 を削除。App.tsx:5-12 で未import、Grep "ControlPanel" でヒット0を確認、vite buildが dangling import無しで緑、READMEの src/components 列挙があれば更新。Must NOT package.json scripts変更。
  Parallelization: Wave 3 | Blocked by: - | Blocks: 11,12
  References (executor has NO interview context - be exhaustive): src/components/ControlPanel.tsx:1-79, src/App.tsx:1-13, src/components/BrowserPanel.tsx:27-28
  Acceptance criteria (agent-executable): Grep ControlPanel 0 hits(plan docs除く)、ファイル削除、vite build緑、README更新 or 履歴に文書化、build+lsp clean
  QA scenarios (name the exact tool + invocation): happy npm run build green + npm run test green (.omo/qa/n4-build-log.txt) + failure git show HEAD~1:ControlPanel.tsxで削除前存在確認, Evidence .omo/qa/task-9-nothing-philosophy-ui-audit.txt
  Commit: Y | chore(dead): remove ControlPanel.tsx unused component (N4)

- [ ] 10. Browser結果密度是正(ボタン/ソート)
  What to do / Must NOT do: src/components/BrowserPanel.tsx:237-267 の per-result 4ボタン(＋QUEUE·▶PREVIEW·↗OPEN·☆SAVE)を可視2つへ(＋QUEUE primary bg-[var(--nothing-red)] + ☆SAVE、↗OPENは9pxリンクとしてメタ行へ、PREVIEWボタン削除しサムネタップへ統合)。sort select:193-202 は relevance|views の2択へ縮退（全維持pill案は不採用）、sortResults browserParser.ts:240-253 は不変、proxy/fetchは不変。Must NOT 新ロジック追加。
  Parallelization: Wave 3 | Blocked by: 2,8 | Blocks: 12
  References (executor has NO interview context - be exhaustive): src/components/BrowserPanel.tsx:193-203,209-272, src/components/browserParser.ts:240-253,322-356
  Acceptance criteria (agent-executable): per-result可視ボタン≤2(QUEUE+☆、OPENは9pxリンク)、PREVIEWボタン無し/サムネ統合、sortは relevance|views の2択のみ（grep -c "<option" =2）、再fetch無し、proxy/fetch不変、build+lsp clean
  QA scenarios (name the exact tool + invocation): happy lofi検索で行は2CTA+OPENリンクのみ (.omo/qa/n6-row-density.png) + failure sort viewsで views降順に再整列 (.omo/qa/n6-sort-views.png), Evidence .omo/qa/task-10-nothing-philosophy-ui-audit.png
  Commit: Y | refactor(browser): reduce per-result buttons to 2, trim sort options (N6)

- [ ] 11. VolumeMixer密度是正
  What to do / Must NOT do: src/components/VolumeMixerPanel.tsx:82-196 の5+スライダースタックを工業的ミニマルへ。collapsed要約 MIXER·YT·NICO·VC masterは維持、expandedは YT/NICO grid + VC MASTER full-width維持、peer行は border hairline w-20 range text-[10px] で idleは ·idle 背後に畳む。MIXER_KEY:21-38 DEFAULT_MIXER/loadMixer と setVolume:54-70,116-140 / setMasterVolume/setPeerVolume契約は不変、600ms debounce維持。Must NOT 永続キー変更。
  Parallelization: Wave 3 | Blocked by: 9 | Blocks: 12
  References (executor has NO interview context - be exhaustive): src/components/VolumeMixerPanel.tsx:82-196,21-38,54-70,116-140, src/hooks/useVoiceChat.ts
  Acceptance criteria (agent-executable): MIXER_KEY/DEFAULT_MIXER/loadMixer semantics不変、expandedで YT/NICO grid + VC MASTER + peer hairline w-20、peer idle畳み、controller setVolume呼出不変、build+lsp clean
  QA scenarios (name the exact tool + invocation): happy 3peer expandedで hairline並び溢れ無し (.omo/qa/n5-mixer-density.png) + failure YT 100→60で setVolume(60)発火 spy log (.omo/qa/n5-volume-spy.log), Evidence .omo/qa/task-11-nothing-philosophy-ui-audit.png
  Commit: Y | refactor(mixer): reduce VolumeMixer density, hairline peer sliders (N5)

- [ ] 12. Tests after — 回帰2件追加
  What to do / Must NOT do: 既存3スイート(browserParser/nicoErrors/nicoEmbedSrc)緑を維持し、回帰2件追加: BrowserPanel previewで iframe[src*="embed"] 不在アサート、peers-voice splitで localStorageキー独立アサート(jsdom mock)。SYNC閾値/間隔の値アサートは変更しない。Must NOT 新ツール追加。
  Parallelization: Wave 4 seq1 | Blocked by: 1-11 | Blocks: 13
  References (executor has NO interview context - be exhaustive): package.json:9-10, src/components/browserParser.test.ts, src/nicoErrors.test.ts, src/nicoEmbedSrc.test.ts, src/components/browserParser.ts:228-233, src/types/index.ts:100-104
  Acceptance criteria (agent-executable): npm run test (vitest run) exit 0 (全3+新2)、新回帰PASS、SYNC constantsアサート不変
  QA scenarios (name the exact tool + invocation): happy npm run test 2>&1 | tee .omo/qa/f1-test.log exit 0 + failure 旧iframe復元で regression FAIL, Evidence .omo/qa/task-12-nothing-philosophy-ui-audit.log
  Commit: Y | test(qa): preview anti-iframe + toggle split regressions (F1)

- [ ] 13. LSP Diagnostics clean
  What to do / Must NOT do: 実LSPラウンドトリップで lsp_diagnostics src/ が 0 errors, 0 warnings(hints可)。Platform/Role unions src/types/index.ts:4-12 を anyで潰さない。Must NOT tscのみで代用。
  Parallelization: Wave 4 seq2 | Blocked by: 12 | Blocks: 14
  References (executor has NO interview context - be exhaustive): .codex/lsp-client.json, .opencode/lsp.json, src/**/*.{ts,tsx}
  Acceptance criteria (agent-executable): lsp_diagnostics src/ empty、any導入無し
  QA scenarios (name the exact tool + invocation): happy lsp_diagnostics src/ empty → .omo/qa/f2-lsp.json, Evidence .omo/qa/task-13-nothing-philosophy-ui-audit.json
  Commit: Y | chore(lsp): diagnostics clean (F2)

- [ ] 14. Visual QA + Philosophy linter + plan hash封印
  What to do / Must NOT do: playwright MCP + visual-qa skillで vite preview(dist/)に対し 1280x800+375x812 撮影(Player Viewer ambient, playing clean, Browser thumbnail, Join bottom-sheet, header single truth, empty triptych)、pixel diff ≤8% (subtraction除く)、prefers-reduced-motion検証、grepリント(新hexはindex.css外0, shadcn0, SYNC_PING_INTERVAL 3000 1件)、sha256sum .omo/plans/nothing-philosophy-ui-audit.md を plan_sha256へ記入し draft review fieldsを review_required:falseへ。Must NOT 差分を手編集で隠蔽。
  Parallelization: Wave 4 seq3 | Blocked by: 13 | Blocks: -
  References (executor has NO interview context - be exhaustive): serve.py, vite.config.ts:8, src/App.tsx:282-608, .omo/plans/nothing-philosophy-ui-audit.md, .omo/drafts/nothing-philosophy-ui-audit.md:7-30, src/index.css:8-27
  Acceptance criteria (agent-executable): screenshots 6種+375幅、visual-qa verdict good、CJK clipping無し、grep linter PASS、sha256 frontmatter記入、git log --oneline -12 で原子波維持、npm run build green on dist/
  QA scenarios (name the exact tool + invocation): happy linter PASS .omo/qa/f4-philosophy-linter.log + failure #123456注入で linter FAIL trap、visual diffで bg-black/55除去>0px確認, Evidence .omo/qa/task-14-nothing-philosophy-ui-audit.md
  Commit: Y | chore(plan): seal philosophy linter + sha (F4) + docs(qa): visual QA screenshots + pixel diff (F3)

## Final verification wave
> Runs in parallel after ALL todos. ALL must APPROVE. Surface results and wait for the user's explicit okay before declaring complete.
- [ ] F1. Plan compliance audit
- [ ] F2. Code quality review
- [ ] F3. Real manual QA
- [ ] F4. Scope fidelity

## Commit strategy
One todo = one commit. Never squash Mandated. Verification docsはF波内でsquash可。Pushは M波緑後1回、N波後1回、F波後最終。force-push禁止。

## Success criteria
- [ ] Mandated 3 fixes shipped and visually verified (M1,M3,M4+M5) — no bg-black/55 LOCKED, no h-64 preview iframe, no showJoinInput gate
- [ ] No philosophy violation: grep linter PASS, SYNC constants unchanged, zero new deps/colors/fonts
- [ ] Tests green: vitest run 0 failures, new regressions PASS
- [ ] LSP clean: lsp_diagnostics 0 errors for src/
- [ ] Visual QA good: design-system + CJK reviewers pass, diffs reflect only subtraction
- [ ] Immutability sealed: plan_sha256 set, draft review_required:false when both momus+independent pass
- [ ] Pushable history: git log atomic M/N/F waves, no any/unwrap, npm run build green

