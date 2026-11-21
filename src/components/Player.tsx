import { useEffect, useRef } from 'react';
import type { MutableRefObject } from 'react';
import { useYouTubePlayer } from '../hooks/useYouTubePlayer';
import { useNiconicoPlayer } from '../hooks/useNiconicoPlayer';
import { useLocalFilePlayer } from '../hooks/useLocalFilePlayer';
import { nicoThumbnailUrl } from '../nicoThumbnail';
import { formatBytes, formatDuration, type LocalMatchResult } from '../localFile';
import { transferRatio } from '../transfer/fileTransfer';
import {
  toWatchUrl,
  type FileTransferStatus,
  type LocalMediaMeta,
  type LocalPlayerEvent,
  type Platform,
  type PlayerController,
  type QueueItem,
} from '../types';

export interface LocalFilePending {
  meta: LocalMediaMeta;
  match: LocalMatchResult;
}

export interface PlayerProps {
  platform: Platform | null;
  videoId: string | null;
  canControl: boolean;
  isHost: boolean;
  controllerRef: MutableRefObject<PlayerController | null>;
  isRemoteSyncingRef: MutableRefObject<boolean>;
  reportLocalEvent: (e: LocalPlayerEvent) => void;
  /** Notify the room-sync layer that a snapshot can now be applied. */
  onControllerReady?: () => void;
  driveMode?: boolean;
  audioOnly?: boolean;
  titles?: Record<string, string>;
  queue?: QueueItem[];
  currentId?: string | null;
  onToggleFullscreen?: () => void;
  isFullscreen?: boolean;
  /** >0 while the low-performance fallback hold is active (auto correction paused). */
  syncFallbackLevel?: number;
  /** A manual resync is in flight/waiting for a playable ping. */
  syncResyncing?: boolean;
  /** Seconds of tolerated (adaptive) lag currently in effect; 0 = in sync. */
  syncToleranceLag?: number;
  /** Manual re-align to the host's latest position (clears the fallback). */
  onResync?: () => void;
  // ── local file source ──
  /** Host-shared metadata for the current local item. */
  localMeta?: LocalMediaMeta;
  /** Object URL for the locally selected copy, or null while unselected. */
  localFileUrl?: string | null;
  /** Match result of the bound file (null until a file is bound). */
  localMatch?: LocalMatchResult | null;
  /** Candidate file awaiting explicit confirmation (duration mismatch). */
  localPending?: LocalFilePending | null;
  /** Selection / probe error to show in the local prompt. */
  localError?: string | null;
  /** Resolve a videoId to its bound object URL (used by the local player). */
  localResolveUrl?: (videoId: string) => string | null;
  onSelectLocalFile?: (file: File) => void;
  onConfirmLocalFile?: () => void;
  onCancelLocalFile?: () => void;
  /** Guest receive state when the host distributes the file over PeerJS. */
  localTransfer?: FileTransferStatus | null;
  /** True when the guest should receive automatically instead of picking. */
  localTransferEnabled?: boolean;
  onRetryLocalTransfer?: () => void;
  onCancelLocalTransfer?: () => void;
}

function YouTubeInner(props: PlayerProps) {
  const yt = useYouTubePlayer({
    isRemoteSyncingRef: props.isRemoteSyncingRef,
    onLocalEvent: props.reportLocalEvent,
  });

  const audioOnly = !!props.driveMode && !!props.audioOnly && !!props.isHost;
  const audioOnlyRef = useRef(audioOnly);
  audioOnlyRef.current = audioOnly;

  useEffect(() => {
    props.controllerRef.current = yt;
    return () => {
      if (props.controllerRef.current === yt) props.controllerRef.current = null;
    };
  }, [yt, props.controllerRef]);

  // Only (re)load when the media or player readiness changes. `audioOnly` is
  // handled by setLowQualityMode below: re-running loadVideoById for a quality
  // toggle would restart the stream (and reset the position) instead.
  useEffect(() => {
    if (props.videoId && yt.ready) {
      yt.loadMedia(props.videoId, audioOnlyRef.current ? 'tiny' : 'default');
    }
  }, [props.videoId, yt.ready, yt.loadMedia]);

  // Let room sync apply a snapshot that arrived before this player existed.
  // Runs after the load effect above so the snapshot seek is not overwritten.
  useEffect(() => {
    if (!props.videoId || !yt.ready) return;
    props.onControllerReady?.();
  }, [props.videoId, yt.ready, props.onControllerReady]);

  useEffect(() => {
    if (!yt.ready) return;
    if (audioOnly) yt.setLowQualityMode?.(true);
    else yt.setLowQualityMode?.(false);
  }, [audioOnly, yt.ready, yt.setLowQualityMode]);
  if (audioOnly) {
    return (
      <div className="relative w-full bg-black">
        <div ref={yt.containerRef} className="absolute h-0 w-0 overflow-hidden opacity-0" aria-hidden />
        {yt.error && (
          <div className="nothing-mono p-4 text-center text-xs text-[var(--nothing-red)]">⚠ {yt.error}</div>
        )}
      </div>
    );
  }

  return (
    <div className={`youtube-host relative bg-black ${props.isFullscreen ? 'h-full w-full' : 'w-full aspect-video'}`}>
      <div ref={yt.containerRef} className="w-full h-full" />
      {yt.error && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/80 p-4 text-center">
          <span className="nothing-mono text-xs text-[var(--nothing-red)]">⚠ {yt.error}</span>
        </div>
      )}
    </div>
  );
}

function NiconicoInner(props: PlayerProps) {
  const nc = useNiconicoPlayer({
    isRemoteSyncingRef: props.isRemoteSyncingRef,
    onLocalEvent: props.reportLocalEvent,
  });

  const audioOnly = !!props.driveMode && !!props.audioOnly && !!props.isHost;

  useEffect(() => {
    props.controllerRef.current = nc;
    return () => {
      if (props.controllerRef.current === nc) props.controllerRef.current = null;
    };
  }, [nc, props.controllerRef]);

  useEffect(() => {
    if (props.videoId) nc.loadMedia(props.videoId);
  }, [props.videoId, nc.loadMedia]);

  // Let room sync apply a snapshot once the embed finished loading (loadComplete).
  useEffect(() => {
    if (!props.videoId || !nc.ready) return;
    props.onControllerReady?.();
  }, [props.videoId, nc.ready, props.onControllerReady]);

  useEffect(() => {
    nc.setLowBandwidthMode(audioOnly);
  }, [audioOnly, nc.setLowBandwidthMode]);
  if (audioOnly) {
    return (
      <div className="relative w-full bg-black">
        <div ref={nc.containerRef} className="absolute h-0 w-0 overflow-hidden opacity-0" aria-hidden />
        {nc.error && (
          <div className="nothing-mono p-4 text-center text-xs text-[var(--nothing-red)]">{nc.error.title}</div>
        )}
      </div>
    );
  }

  return (
    <div className={`nico-host relative bg-black ${props.isFullscreen ? 'h-full w-full' : 'w-full aspect-video'}`}>
      <div
        ref={nc.containerRef}
        className="w-full h-full"
      />
      {nc.error && (
        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-black/90 p-4 text-center">
          <p className="nothing-mono text-xs font-medium tracking-widest text-[var(--nothing-red)]">{nc.error.title}</p>
          <p className="max-w-md text-xs leading-relaxed text-[var(--nothing-text-muted)]">
            {nc.error.detail}
          </p>
          <div className="flex flex-wrap items-center justify-center gap-2">
            <a
              href={toWatchUrl({ platform: 'niconico', videoId: props.videoId ?? '' })}
              target="_blank"
              rel="noopener noreferrer"
              className="nothing-mono bg-[var(--nothing-red)] px-3 py-1 text-xs tracking-widest text-white hover:bg-[var(--nothing-red-hover)]"
            >
              ニコニコで開く ↗
            </a>
            {props.videoId && (
              <button
                type="button"
                onClick={() => {
                  const controller = props.controllerRef.current;
                  if (controller?.reloadMedia) controller.reloadMedia();
                  else controller?.loadMedia(props.videoId as string);
                }}
                className="nothing-mono border border-[var(--nothing-border)] bg-[var(--nothing-surface-raised)] px-3 py-1 text-xs tracking-widest text-[var(--nothing-text)] hover:bg-[var(--nothing-surface-hover)]"
              >
                再読み込み
              </button>
            )}
          </div>
          {!props.isHost && (
            <p className="max-w-md text-[11px] leading-relaxed text-amber-300/90">
              ※ ホスト側では視聴できても、視聴制限のある動画はゲスト側のブラウザでは再生できない場合があります。
            </p>
          )}
          {nc.insecureContext && (
            <p className="max-w-md text-[11px] leading-relaxed text-amber-300/90">
              ※ このアプリが http://IPアドレス で開かれている場合、ニコニコの埋め込み再生は HTTPS または localhost での接続を必要とします。
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function LocalFilePicker(props: {
  onSelectLocalFile?: (file: File) => void;
  label: string;
  testId: string;
}) {
  return (
    <label className="nothing-mono inline-flex cursor-pointer items-center gap-1.5 border border-[var(--nothing-border)] bg-[var(--nothing-surface-raised)] px-3 py-1 text-xs tracking-widest text-[var(--nothing-text)] hover:bg-[var(--nothing-surface-hover)]">
      {props.label}
      <input
        type="file"
        accept="video/*,audio/*"
        data-testid={props.testId}
        className="sr-only"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) props.onSelectLocalFile?.(file);
          e.currentTarget.value = '';
        }}
      />
    </label>
  );
}

function transferPhaseLabel(status: FileTransferStatus): string {
  switch (status.phase) {
    case 'offering':
      return '受信待ち';
    case 'transferring':
      return '受信中';
    case 'verifying':
      return '照合中';
    case 'ready':
      return '準備中';
    case 'error':
      return 'エラー';
    case 'cancelled':
      return 'キャンセル';
    default:
      return '受信待ち';
  }
}

function LocalFilePrompt(props: PlayerProps) {
  const meta = props.localMeta;
  const pending = props.localPending;
  const transfer: FileTransferStatus = props.localTransfer ?? { phase: 'idle' };
  const tooLargeFallback =
    transfer.phase === 'error' && transfer.fallbackToManual;
  const autoReceive = !!props.localTransferEnabled && !tooLargeFallback;
  const showProgress =
    autoReceive &&
    (transfer.phase === 'transferring' || transfer.phase === 'verifying');
  const ratio =
    transfer.phase === 'transferring' || transfer.phase === 'verifying'
      ? transferRatio(transfer.receivedBytes, transfer.totalBytes)
      : 0;

  return (
    <div
      className={`flex flex-col items-center justify-center gap-3 p-6 text-center bg-black ${
        props.isFullscreen ? 'h-full w-full' : 'aspect-video'
      }`}
      data-testid="local-file-unselected"
    >
      <div className="flex h-12 w-12 items-center justify-center border border-[var(--nothing-border)] bg-[var(--nothing-surface)]">
        <span className="text-lg text-[var(--nothing-text-dim)]">◇</span>
      </div>
      <p className="nothing-label" data-testid="local-file-phase">
        LOCAL FILE · {autoReceive ? transferPhaseLabel(transfer) : '未選択'}
      </p>
      {meta && (
        <div className="space-y-1">
          <p className="nothing-mono max-w-md truncate text-sm text-[var(--nothing-text)]">
            {meta.fileName}
          </p>
          <p className="nothing-mono text-[10px] tracking-widest text-[var(--nothing-text-dim)]">
            {formatBytes(meta.sizeBytes)} · {formatDuration(meta.durationSec)} ·{' '}
            {meta.mimeType || 'unknown type'}
          </p>
        </div>
      )}

      {autoReceive && transfer.phase === 'transferring' && (
        <div className="w-full max-w-md space-y-1" data-testid="local-transfer-progress">
          <div className="h-1 w-full bg-[var(--nothing-surface-raised)]">
            <div
              className="h-full bg-[var(--nothing-red)] transition-[width] duration-150"
              style={{ width: `${Math.round(ratio * 100)}%` }}
            />
          </div>
          <p className="nothing-mono text-[10px] tracking-widest text-[var(--nothing-text-dim)]">
            {formatBytes(transfer.receivedBytes)} / {formatBytes(transfer.totalBytes)} ·{' '}
            {Math.round(ratio * 100)}%
          </p>
        </div>
      )}

      {autoReceive && transfer.phase === 'verifying' && showProgress && (
        <p className="nothing-mono text-[10px] tracking-widest text-[var(--nothing-text-dim)]">
          {formatBytes(transfer.receivedBytes)} / {formatBytes(transfer.totalBytes)} · 照合中
        </p>
      )}

      {autoReceive &&
        (transfer.phase === 'idle' ||
          transfer.phase === 'offering' ||
          transfer.phase === 'verifying' ||
          transfer.phase === 'ready') && (
          <p className="nothing-mono text-xs text-[var(--nothing-text-muted)]">
            {transfer.phase === 'verifying'
              ? '受信したファイルを照合中…'
              : transfer.phase === 'ready'
                ? '再生を準備中…'
                : 'ホストからの受信待ち'}
          </p>
        )}

      {autoReceive &&
        (transfer.phase === 'error' || transfer.phase === 'cancelled') && (
          <div className="w-full max-w-md space-y-2 border border-[var(--nothing-border)] bg-[var(--nothing-surface-raised)] px-3 py-2">
            <p
              className={`nothing-mono text-[11px] leading-relaxed ${
                transfer.phase === 'error'
                  ? 'text-[var(--nothing-red)]'
                  : 'text-[var(--nothing-text-muted)]'
              }`}
            >
              {transfer.phase === 'error'
                ? `⚠ ${transfer.message}`
                : '受信をキャンセルしました'}
            </p>
            <div className="flex flex-wrap justify-center gap-2">
              {(transfer.phase === 'cancelled' || transfer.retryable) &&
                props.onRetryLocalTransfer && (
                  <button
                    type="button"
                    onClick={props.onRetryLocalTransfer}
                    className="nothing-mono bg-[var(--nothing-red)] px-3 py-1 text-xs tracking-widest text-white hover:bg-[var(--nothing-red-hover)]"
                  >
                    再試行
                  </button>
                )}
              {props.onCancelLocalTransfer &&
                !tooLargeFallback &&
                (transfer.phase === 'error' || transfer.phase === 'cancelled') && (
                  <button
                    type="button"
                    onClick={props.onCancelLocalTransfer}
                    className="nothing-mono border border-[var(--nothing-border)] bg-black px-3 py-1 text-xs tracking-widest text-[var(--nothing-text-dim)] hover:text-[var(--nothing-text)]"
                  >
                    閉じる
                  </button>
                )}
            </div>
          </div>
        )}

      {autoReceive &&
        (transfer.phase === 'offering' || transfer.phase === 'transferring') &&
        props.onCancelLocalTransfer && (
          <button
            type="button"
            onClick={props.onCancelLocalTransfer}
            className="nothing-mono border border-[var(--nothing-border)] bg-black px-3 py-1 text-xs tracking-widest text-[var(--nothing-text-dim)] hover:text-[var(--nothing-text)]"
          >
            キャンセル
          </button>
        )}

      {!autoReceive && (
        <>
          {tooLargeFallback && transfer.phase === 'error' && (
            <p className="nothing-mono max-w-md text-[11px] leading-relaxed text-[var(--nothing-text-muted)]">
              {transfer.message}
            </p>
          )}
          <p className="max-w-md text-xs leading-relaxed text-[var(--nothing-text-muted)]">
            ホストと同じファイルを選択してください。
          </p>
        </>
      )}

      {!autoReceive && pending && (
        <div className="w-full max-w-md space-y-2 border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-left">
          <p className="nothing-mono text-[11px] leading-relaxed text-amber-300">
            ⚠ {pending.match.message}
          </p>
          <p className="nothing-mono truncate text-[10px] text-[var(--nothing-text-dim)]">
            {pending.meta.fileName} · {formatBytes(pending.meta.sizeBytes)} ·{' '}
            {formatDuration(pending.meta.durationSec)}
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={props.onConfirmLocalFile}
              className="nothing-mono bg-[var(--nothing-red)] px-3 py-1 text-xs tracking-widest text-white hover:bg-[var(--nothing-red-hover)]"
            >
              このファイルを使用
            </button>
            <button
              type="button"
              onClick={props.onCancelLocalFile}
              className="nothing-mono border border-[var(--nothing-border)] bg-black px-3 py-1 text-xs tracking-widest text-[var(--nothing-text-dim)] hover:text-[var(--nothing-text)]"
            >
              選び直す
            </button>
          </div>
        </div>
      )}

      {!autoReceive && props.localError && (
        <p className="nothing-mono max-w-md border border-[var(--nothing-red)]/30 bg-[var(--nothing-red-dim)] px-2 py-1 text-xs text-[var(--nothing-red)]">
          ⚠ {props.localError}
        </p>
      )}

      {!autoReceive && (
        <LocalFilePicker
          onSelectLocalFile={props.onSelectLocalFile}
          label="ファイルを選択"
          testId="local-file-input"
        />
      )}
    </div>
  );
}

function LocalFileInner(props: PlayerProps) {
  const local = useLocalFilePlayer({
    isRemoteSyncingRef: props.isRemoteSyncingRef,
    onLocalEvent: props.reportLocalEvent,
    resolveUrl: (videoId) => {
      const resolved = props.localResolveUrl?.(videoId);
      if (resolved) return resolved;
      return videoId === props.videoId ? props.localFileUrl ?? null : null;
    },
    suppressEnd: !!props.localMatch?.suppressEnd,
  });

  const audioOnly = !!props.driveMode && !!props.audioOnly && !!props.isHost;

  useEffect(() => {
    props.controllerRef.current = local;
    return () => {
      if (props.controllerRef.current === local) props.controllerRef.current = null;
    };
  }, [local, props.controllerRef]);

  useEffect(() => {
    if (props.videoId && props.localFileUrl) local.loadMedia(props.videoId);
  }, [props.videoId, props.localFileUrl, local.loadMedia]);

  // Let room sync apply a snapshot that arrived while the file was unselected.
  useEffect(() => {
    if (!props.videoId || !local.ready) return;
    props.onControllerReady?.();
  }, [props.videoId, local.ready, props.onControllerReady]);

  const warning = props.localMatch?.message;

  return (
    <div
      className={`relative bg-black ${
        props.isFullscreen && !audioOnly
          ? 'h-full w-full'
          : audioOnly
            ? 'h-0 w-0 overflow-hidden'
            : 'w-full aspect-video'
      }`}
    >
      <video
        ref={local.mediaRef}
        controls={!audioOnly}
        playsInline
        preload="metadata"
        data-testid="local-file-video"
        className={
          audioOnly
            ? 'h-0 w-0 opacity-0'
            : 'h-full w-full object-contain bg-black'
        }
      />

      {!audioOnly && warning && (
        <div className="absolute left-2 top-2 z-20 max-w-[calc(100%-1rem)] border border-amber-500/40 bg-black/85 px-2 py-1 backdrop-blur">
          <p className="nothing-mono text-[10px] leading-relaxed text-amber-300">
            ⚠ {warning}
          </p>
        </div>
      )}

      {!audioOnly && local.needsGesture && (
        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-2 bg-black/70 p-4 text-center">
          <p className="nothing-mono text-xs text-[var(--nothing-text-muted)]">
            ブラウザの自動再生がブロックされました
          </p>
          <button
            type="button"
            onClick={() => local.play()}
            className="nothing-mono bg-[var(--nothing-red)] px-3 py-1 text-xs tracking-widest text-white hover:bg-[var(--nothing-red-hover)]"
          >
            タップして再生
          </button>
        </div>
      )}

      {local.error && (
        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-black/90 p-4 text-center">
          <p className="nothing-mono max-w-md text-xs text-[var(--nothing-red)]">
            ⚠ {local.error}
          </p>
          <LocalFilePicker
            onSelectLocalFile={props.onSelectLocalFile}
            label="再選択"
            testId="local-file-reselect"
          />
        </div>
      )}

      {local.endedSuppressed && (
        <div className="absolute inset-x-0 bottom-14 z-20 flex justify-center">
          <p className="nothing-mono border border-[var(--nothing-border)] bg-black/85 px-2 py-1 text-[10px] tracking-widest text-[var(--nothing-text-dim)]">
            手元のファイルが終了しました（ルームは継続）
          </p>
        </div>
      )}

      {!audioOnly && (
        <div className="absolute right-2 top-2 z-20">
          <LocalFilePicker
            onSelectLocalFile={props.onSelectLocalFile}
            label="別のファイル"
            testId="local-file-reselect"
          />
        </div>
      )}
    </div>
  );
}


export function Player(props: PlayerProps) {
  const isGuestDrive = !!props.driveMode && !props.isHost;
  if (isGuestDrive) {
    const currentItem = props.queue?.find((q) => q.id === props.currentId) ?? null;
    const title = currentItem
      ? (props.titles?.[currentItem.id] ?? currentItem.local?.fileName ?? currentItem.videoId)
      : null;
    const thumb = currentItem
      ? currentItem.platform === 'youtube'
        ? `https://i.ytimg.com/vi/${currentItem.videoId}/hqdefault.jpg`
        : currentItem.platform === 'niconico'
          ? nicoThumbnailUrl(currentItem.videoId)
          : null
      : null;
    return (
      <div className="nothing-panel relative w-full overflow-hidden p-6 text-center">
        <div className="nothing-glyph absolute left-0 right-0 top-0" aria-hidden />
        <p className="nothing-label mb-3">DRIVE · AUDIO SYNC</p>
        {currentItem ? (
          <div className="space-y-3">
            {thumb && <img src={thumb} alt="" className="mx-auto h-28 w-auto border border-[var(--nothing-border)] object-cover" loading="lazy" />}
            <p className="nothing-mono truncate text-sm text-[var(--nothing-text)]">{title}</p>
            <span className="nothing-mono inline-block border border-[var(--nothing-border)] px-2 py-0.5 text-[10px] tracking-widest text-[var(--nothing-text-dim)]">♪ PLAYING</span>
          </div>
        ) : (
          <p className="nothing-mono text-sm text-[var(--nothing-text-dim)]">STANDBY</p>
        )}
      </div>
    );
  }

  const isHostAudioOnly = !!props.driveMode && !!props.audioOnly && !!props.isHost && !!props.platform;
  const currentItem = isHostAudioOnly
    ? props.queue?.find((q) => q.id === props.currentId) ?? null
    : null;
  const title = currentItem
    ? (props.titles?.[currentItem.id] ?? currentItem.local?.fileName ?? currentItem.videoId)
    : null;
  const thumb = currentItem
    ? currentItem.platform === 'youtube'
      ? `https://i.ytimg.com/vi/${currentItem.videoId}/hqdefault.jpg`
      : currentItem.platform === 'niconico'
        ? nicoThumbnailUrl(currentItem.videoId)
        : null
    : null;

  // ambient Glyph frame for VIEWER lock — video remains fully visible.
  // A transparent shield blocks iframe clicks, while reportLocalEvent also
  // rejects PLAY/PAUSE/SEEK from viewers (defence in depth).
  const isViewerLocked = !!props.platform && !props.canControl && !props.driveMode;

  // Keep YouTubeInner / NiconicoInner at the same position in the tree in
  // both modes. React matches children by position and type, so moving the
  // player into a different branch (as the old AUDIO ONLY early-return did)
  // unmounts and remounts it: YouTube reloads from the start and Niconico
  // rebuilds its iframe, losing the host's playback position. Only the
  // surrounding chrome (hidden wrapper / footer) may change.
  return (
    <div
      className={
        isHostAudioOnly
          ? 'nothing-panel relative w-full overflow-hidden'
          : `${props.isFullscreen ? 'relative h-full w-full overflow-hidden bg-black group' : 'nothing-panel relative w-full overflow-hidden bg-black group'} ${isViewerLocked ? 'border border-[var(--nothing-red)]/30' : ''}`
      }
    >
      {(isHostAudioOnly || !props.isFullscreen) && (
        <div
          className={`nothing-glyph ${isHostAudioOnly ? '' : 'absolute left-0 right-0 top-0 z-10'}`}
          aria-hidden
        />
      )}

      {props.platform === 'youtube' && <YouTubeInner {...props} />}
      {props.platform === 'niconico' && <NiconicoInner {...props} />}
      {props.platform === 'local' &&
        (props.localFileUrl ? (
          <LocalFileInner {...props} />
        ) : (
          <LocalFilePrompt {...props} />
        ))}

      {isHostAudioOnly ? (
        <div className="flex items-center gap-3 border-t border-[var(--nothing-border)] bg-[var(--nothing-surface-raised)] p-3">
          {thumb && <img src={thumb} alt="" className="h-14 w-24 border border-[var(--nothing-border)] object-cover" loading="lazy" />}
          <div className="min-w-0 flex-1">
            <p className="nothing-mono truncate text-sm text-[var(--nothing-text)]">{title ?? '再生中'}</p>
            <p className="nothing-label">AUDIO ONLY · GLYPH</p>
          </div>
          <button
            type="button"
            onClick={() => props.controllerRef.current?.getIsPlaying() ? props.controllerRef.current?.pause() : props.controllerRef.current?.play()}
            className="nothing-mono shrink-0 border border-[var(--nothing-red)] bg-[var(--nothing-red)] px-3 py-1.5 text-xs tracking-widest text-white hover:bg-[var(--nothing-red-hover)] active:scale-[0.98]"
            aria-label="再生/一時停止"
          >
            ▶ / ⏸
          </button>
        </div>
      ) : (
        <>
          {!props.platform && (
            <div className={`flex flex-col items-center justify-center gap-3 p-6 ${props.isFullscreen ? 'h-full w-full' : 'aspect-video'}`} >
              <div className="flex h-12 w-12 items-center justify-center border border-[var(--nothing-border)] bg-[var(--nothing-surface)]">
                <span className="text-lg text-[var(--nothing-text-dim)]">◇</span>
              </div>
              <p className="nothing-mono text-xs tracking-widest text-[var(--nothing-text-dim)]">READY · NO MEDIA</p>
            </div>
          )}
          {isViewerLocked && (
            <div
              className="absolute inset-0 z-10"
              aria-hidden
              data-testid="viewer-input-shield"
            />
          )}
          {(!!props.syncFallbackLevel ||
            !!props.syncResyncing ||
            (props.syncToleranceLag ?? 0) > 0) && (
            <div
              className="absolute left-2 top-2 z-20 flex max-w-[calc(100%-1rem)] items-center gap-2 border border-[var(--nothing-border-strong)] bg-black/85 px-2 py-1 backdrop-blur"
              title={
                props.syncResyncing && !props.syncFallbackLevel
                  ? 'ホストの再生位置に再同期しています'
                  : props.syncFallbackLevel
                    ? '低スペック端末向けフォールバック: 自動補正を一時停止して再生を優先しています'
                    : 'この端末のシーク読み込み時間を考慮してズレを許容しています。再同期で合わせ直せます。'
              }
            >
              <span className="nothing-mono truncate text-[10px] tracking-widest text-[var(--nothing-text-dim)]">
                {props.syncResyncing && !props.syncFallbackLevel
                  ? '再同期中 · ホスト位置に合わせています'
                  : props.syncFallbackLevel
                    ? '自動追従を保留中 · 再生優先'
                    : `ズレ ${(props.syncToleranceLag ?? 0).toFixed(1)}s を許容中 · 再生優先`}
              </span>
              {props.onResync && (
                <button
                  type="button"
                  onClick={props.onResync}
                  className="nothing-mono shrink-0 border border-[var(--nothing-red)] bg-[var(--nothing-red)] px-2 py-0.5 text-[10px] tracking-widest text-white hover:bg-[var(--nothing-red-hover)] active:scale-[0.98]"
                  aria-label="最新の再生位置に再同期"
                >
                  再同期
                </button>
              )}
            </div>
          )}
          {isViewerLocked && (
            <div className="pointer-events-none absolute bottom-2 left-2 z-10 flex items-center gap-1.5">
              <span className="nothing-mono border border-[var(--nothing-red)]/25 bg-black/70 px-2 py-1 text-[10px] tracking-widest text-[var(--nothing-text-dim)]">
                VIEWER · LOCKED
              </span>
            </div>
          )}

          {/* fullscreen toggle — visible on hover / always on mobile */}
          <button
            type="button"
            onClick={props.onToggleFullscreen}
            className="nothing-mono absolute bottom-2 right-2 z-20 flex items-center gap-1 border border-white/15 bg-black/70 px-2 py-1 text-[10px] tracking-widest text-white backdrop-blur hover:bg-black/90 active:scale-[0.98] opacity-60 hover:opacity-100 sm:opacity-60 sm:group-hover:opacity-100 transition-opacity"
            aria-label={props.isFullscreen ? '全画面を解除' : '全画面表示'}
            title={props.isFullscreen ? '全画面を解除 (Esc)' : '全画面表示'}
          >
            <span className="text-[11px]">{props.isFullscreen ? '⛶' : '⛶'}</span>
            <span className="hidden sm:inline">{props.isFullscreen ? 'EXIT' : 'FULL'}</span>
          </button>
        </>
      )}
    </div>
  );
}
