import { useEffect, useRef } from 'react';
import type { MutableRefObject } from 'react';
import { useYouTubePlayer } from '../hooks/useYouTubePlayer';
import { useNiconicoPlayer } from '../hooks/useNiconicoPlayer';
import { toWatchUrl, type LocalPlayerEvent, type Platform, type PlayerController, type QueueItem } from '../types';

export interface PlayerProps {
  platform: Platform | null;
  videoId: string | null;
  canControl: boolean;
  isHost: boolean;
  controllerRef: MutableRefObject<PlayerController | null>;
  isRemoteSyncingRef: MutableRefObject<boolean>;
  reportLocalEvent: (e: LocalPlayerEvent) => void;
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

export function Player(props: PlayerProps) {
  const isGuestDrive = !!props.driveMode && !props.isHost;
  if (isGuestDrive) {
    const currentItem = props.queue?.find((q) => q.id === props.currentId) ?? null;
    const title = currentItem ? (props.titles?.[currentItem.id] ?? currentItem.videoId) : null;
    const thumb = currentItem
      ? currentItem.platform === 'youtube'
        ? `https://i.ytimg.com/vi/${currentItem.videoId}/hqdefault.jpg`
        : `https://tn.smilevideo.jp/smile?i=${currentItem.videoId}`
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
  if (isHostAudioOnly) {
    const currentItem = props.queue?.find((q) => q.id === props.currentId) ?? null;
    const title = currentItem ? (props.titles?.[currentItem.id] ?? currentItem.videoId) : null;
    const thumb = currentItem
      ? currentItem.platform === 'youtube'
        ? `https://i.ytimg.com/vi/${currentItem.videoId}/hqdefault.jpg`
        : `https://tn.smilevideo.jp/smile?i=${currentItem.videoId}`
      : null;
    return (
      <div className="nothing-panel relative w-full overflow-hidden">
        <div className="nothing-glyph" aria-hidden />
        {props.platform === 'youtube' && <YouTubeInner {...props} />}
        {props.platform === 'niconico' && <NiconicoInner {...props} />}
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
      </div>
    );
  }

  // ambient Glyph frame for VIEWER lock — video remains fully visible.
  // A transparent shield blocks iframe clicks, while reportLocalEvent also
  // rejects PLAY/PAUSE/SEEK from viewers (defence in depth).
  const isViewerLocked = !!props.platform && !props.canControl && !props.driveMode;

  return (
    <div
      className={`${props.isFullscreen ? 'relative h-full w-full overflow-hidden bg-black group' : 'nothing-panel relative w-full overflow-hidden bg-black group'} ${isViewerLocked ? 'border border-[var(--nothing-red)]/30' : ''}`}
    >
      {!props.isFullscreen && <div className="nothing-glyph absolute left-0 right-0 top-0 z-10" aria-hidden />}

      {props.platform === 'youtube' && <YouTubeInner {...props} />}
      {props.platform === 'niconico' && <NiconicoInner {...props} />}
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
    </div>
  );
}
