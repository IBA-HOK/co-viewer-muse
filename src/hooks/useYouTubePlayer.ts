import { useCallback, useEffect, useRef, useState } from 'react';
import type { LocalPlayerEvent, PlayerController, YouTubePlaybackQuality } from '../types';

export interface UseYouTubePlayerOptions {
  isRemoteSyncingRef: React.MutableRefObject<boolean>;
  onLocalEvent: (e: LocalPlayerEvent) => void;
}

export interface UseYouTubePlayerResult extends PlayerController {
  ready: boolean;
  error: string | null;
  /** Attach to a stable wrapper element; YT replaces an inner node, not this one. */
  containerRef: React.RefObject<HTMLDivElement>;
}

let ytApiPromise: Promise<void> | null = null;

const YOUTUBE_API_LOAD_TIMEOUT_MS = 10000;

function loadYouTubeApi(): Promise<void> {
  if (typeof window === 'undefined') return Promise.resolve();
  if (window.YT && window.YT.Player) return Promise.resolve();
  if (ytApiPromise) return ytApiPromise;
  let promise: Promise<void>;
  promise = new Promise<void>((resolve, reject) => {
    let settled = false;
    let timer: number | undefined;
    const tag = document.createElement('script');
    const prev = window.onYouTubeIframeAPIReady;

    const cleanup = () => {
      if (timer != null) {
        window.clearTimeout(timer);
        timer = undefined;
      }
      tag.onerror = null;
      if (window.onYouTubeIframeAPIReady === onReady) {
        window.onYouTubeIframeAPIReady = prev;
      }
    };

    const fail = (reason: string) => {
      if (settled) return;
      settled = true;
      cleanup();
      // The failed script is useless and may block a later retry.
      tag.remove();
      if (ytApiPromise === promise) ytApiPromise = null;
      reject(new Error(reason));
    };

    const onReady = () => {
      if (settled) return;
      settled = true;
      prev?.();
      cleanup();
      resolve();
    };

    window.onYouTubeIframeAPIReady = onReady;
    timer = window.setTimeout(
      () => fail('YouTube IFrame API load timed out'),
      YOUTUBE_API_LOAD_TIMEOUT_MS
    );
    tag.src = 'https://www.youtube.com/iframe_api';
    tag.onerror = () => fail('YouTube IFrame API failed to load');
    document.head.appendChild(tag);
  });
  ytApiPromise = promise;
  return promise;
}

/**
 * Suppress re-loading the same video when two call sites race (room sync
 * applies a snapshot and the Player effect reacts to the same state change).
 * Loading again resets playback to 0 and re-fetches the stream — on a slow
 * device that restarts the very buffering the sync layer is trying to settle.
 */
const LOAD_DEDUPE_MS = 1500;

/**
 * If a seek request arrives while the player is still buffering, it is queued
 * instead of restarting the fetch. A perpetually stuck buffer must not swallow
 * that request forever, so force the newest queued position after this long.
 */
const PENDING_SEEK_MAX_WAIT_MS = 10000;

/**
 * A seek normally produces a BUFFERING state, whose end is the recovery time.
 * If no state change arrives (seek inside the buffered range, or a lost event)
 * the recovery phase must expire quickly so a later pause/play is not mistaken
 * for a slow seek and is not swallowed as a seek echo.
 */
const SEEK_RECOVERY_MAX_WAIT_MS = 8000;

/**
 * How long a measured seek recovery stays relevant. After a couple of minutes
 * of healthy playback the device should start from the normal tolerance again;
 * otherwise one slow seek on a previous video would mask real desync forever.
 */
const SEEK_RECOVERY_TTL_MS = 120000;

/**
 * YouTube IFrame Player API wrapper. Exposes a PlayerController and reports
 * genuine local play/pause transitions (for broadcast) while suppressing echoes
 * caused by remote commands via isRemoteSyncingRef.
 *
 * Low-performance fallbacks (seek → buffer → seek loop):
 *  - `seekTo()` while the player is BUFFERING only remembers the newest target
 *    and applies it once the current load finishes, instead of restarting the
 *    buffering phase on every request.
 *  - the first PLAYING event after a seek is treated as the seek completing,
 *    not as a user "play" intent, so a guest that slowly recovers from a seek
 *    does not broadcast a stale position back to the room.
 *  - `getSeekRecoveryMs()` reports how long the last seek spent buffering; the
 *    room-sync layer widens its drift tolerance accordingly.
 *  - `isBuffering()` lets the room-sync layer pause automatic corrections while
 *    the guest is loading.
 *
 * Bandwidth saving: when audioOnly is true (driveMode + audioOnly + isHost),
 * callers should request low quality via loadMedia(videoId, 'tiny') or
 * setPlaybackQuality('tiny') / setLowQualityMode(true). Valid qualities are
 * 'tiny' (144p), 'small' (240p), 'medium' (360p), 'large' (480p), 'hd720',
 * 'hd1080', 'highres', 'default'. 'tiny' is tried first, falling back to
 * 'small' if unavailable.
 */
export function useYouTubePlayer(
  opts: UseYouTubePlayerOptions
): UseYouTubePlayerResult {
  const containerRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<YTPlayer | null>(null);
  const isPlayingRef = useRef(false);
  const bufferingRef = useRef(false);
  const stateRef = useRef<number | null>(null);
  const lowQualityRef = useRef(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Low-performance guard state.
  const seekStartedAtRef = useRef(0);
  const seekRecoveringRef = useRef(false);
  /** Whether the current seek actually entered a BUFFERING phase. */
  const seekSawBufferingRef = useRef(false);
  const seekRecoveryTimerRef = useRef<number | null>(null);
  const lastSeekRecoveryMsRef = useRef(0);
  const seekRecoveryAtRef = useRef(0);
  const pendingSeekRef = useRef<number | null>(null);
  const pendingSeekTimerRef = useRef<number | null>(null);
  const loadedVideoIdRef = useRef<string | null>(null);
  const loadedVideoAtRef = useRef(0);

  const optsRef = useRef(opts);
  optsRef.current = opts;

  const clearSeekRecoveryTimer = useCallback(() => {
    if (seekRecoveryTimerRef.current != null) {
      window.clearTimeout(seekRecoveryTimerRef.current);
      seekRecoveryTimerRef.current = null;
    }
  }, []);

  const applySeek = useCallback((seconds: number) => {
    const player = playerRef.current;
    if (!player) return;
    // Only a seek on an already-playing video measures "seek recovery": the
    // initial load / video switch lag must stay correctable at the normal
    // threshold, otherwise a freshly joined guest would be left seconds behind
    // for the whole video.
    const YT = window.YT;
    const wasPlaying = YT != null && stateRef.current === YT.PlayerState.PLAYING;
    seekStartedAtRef.current = Date.now();
    seekRecoveringRef.current = wasPlaying;
    seekSawBufferingRef.current = false;
    clearSeekRecoveryTimer();
    if (wasPlaying) {
      // This timer only guards the "seek produced no state change at all" case.
      // A real BUFFERING event clears it and the recovery is measured when
      // buffering ends, however long that takes.
      seekRecoveryTimerRef.current = window.setTimeout(() => {
        seekRecoveryTimerRef.current = null;
        if (!seekSawBufferingRef.current) seekRecoveringRef.current = false;
      }, SEEK_RECOVERY_MAX_WAIT_MS);
    }
    try {
      player.seekTo(seconds, true);
    } catch {
      // The YT API throws while the iframe is being torn down; ignore.
    }
  }, [clearSeekRecoveryTimer]);

  const clearPendingSeek = useCallback(() => {
    pendingSeekRef.current = null;
    if (pendingSeekTimerRef.current != null) {
      window.clearTimeout(pendingSeekTimerRef.current);
      pendingSeekTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    loadYouTubeApi().then(() => {
      if (cancelled || !containerRef.current || !window.YT) return;
      const inner = document.createElement('div');
      containerRef.current.appendChild(inner);
      playerRef.current = new window.YT.Player(inner, {
        playerVars: {
          autoplay: 0,
          controls: 1,
          rel: 0,
          modestbranding: 1,
          playsinline: 1,
          origin: window.location.origin,
        },
        events: {
          onReady: () => {
            if (!cancelled) setReady(true);
          },
          onStateChange: (e: YTPlayerEvent) => {
            const YT = window.YT!;
            try {
              const state = e.data;
              stateRef.current = state;
              if (state === YT.PlayerState.PLAYING) setError(null);
              const wasRecovering = seekRecoveringRef.current;
              bufferingRef.current = state === YT.PlayerState.BUFFERING;

              if (state === YT.PlayerState.PLAYING) isPlayingRef.current = true;
              else if (
                state === YT.PlayerState.PAUSED ||
                state === YT.PlayerState.ENDED
              )
                isPlayingRef.current = false;

              if (
                state === YT.PlayerState.BUFFERING &&
                seekRecoveringRef.current
              ) {
                // A real rebuffer is in progress; wait for it to finish instead
                // of expiring the measurement on a timer.
                seekSawBufferingRef.current = true;
                clearSeekRecoveryTimer();
              }

              // Leaving BUFFERING ends the recovery phase: record how long the
              // seek needed so the sync layer can widen its tolerance. Only a
              // return to PLAYING counts — a pause is not a recovery and would
              // inflate the tolerance.
              if (state !== YT.PlayerState.BUFFERING) {
                if (seekRecoveringRef.current) {
                  if (state === YT.PlayerState.PLAYING) {
                    lastSeekRecoveryMsRef.current = Math.max(
                      0,
                      Date.now() - seekStartedAtRef.current
                    );
                    seekRecoveryAtRef.current = Date.now();
                  }
                  seekRecoveringRef.current = false;
                  seekSawBufferingRef.current = false;
                  clearSeekRecoveryTimer();
                }
                // A seek that arrived while loading is applied now, as a single
                // newest-wins jump, instead of restarting the load each time.
                // It is only valid once the new position is actually playable:
                // an explicit pause wins over a queued seek (and the pause must
                // still be reported below), and an ended video has nothing to
                // seek to.
                if (state === YT.PlayerState.ENDED) {
                  clearPendingSeek();
                } else if (state === YT.PlayerState.PLAYING) {
                  if (pendingSeekRef.current != null) {
                    const target = pendingSeekRef.current;
                    clearPendingSeek();
                    applySeek(target);
                    return;
                  }
                } else {
                  clearPendingSeek();
                }
              }

              // Loop prevention: remote commands set the flag; ignore the resulting echo.
              if (optsRef.current.isRemoteSyncingRef.current) return;

              // The YT API may fire onStateChange with a bare iframe as target
              // during init/teardown — guard against a missing getCurrentTime.
              const t = e.target as YTPlayer;
              const time =
                typeof t.getCurrentTime === 'function' ? t.getCurrentTime() : 0;
              if (state === YT.PlayerState.PLAYING) {
                // The first PLAYING after a seek is the seek finishing, not a
                // user pressing play. Broadcasting it would send this device's
                // (lagging) position as a "live" play event.
                if (wasRecovering) return;
                optsRef.current.onLocalEvent({ kind: 'PLAY', currentTime: time });
              } else if (state === YT.PlayerState.PAUSED) {
                optsRef.current.onLocalEvent({ kind: 'PAUSE', currentTime: time });
              } else if (state === YT.PlayerState.ENDED) {
                optsRef.current.onLocalEvent({ kind: 'END' });
              }
            } catch {
              // Ignore transient quirks from the third-party YT IFrame API.
            }
          },
          onError: (e: YTPlayerEvent) => {
            // 101 / 150 = owner disabled embedding.
            setError(`YouTube再生エラー (code ${e.data})`);
          },
        },
      });
    }).catch(() => {
      if (!cancelled) {
        setError(
          'YouTubeプレーヤーを読み込めませんでした。ネットワーク・広告ブロッカー・CSP の設定を確認してください。'
        );
      }
    });
    return () => {
      cancelled = true;
      clearPendingSeek();
      clearSeekRecoveryTimer();
      playerRef.current?.destroy();
      playerRef.current = null;
    };
  }, [applySeek, clearPendingSeek, clearSeekRecoveryTimer]);

  const loadMedia = useCallback((videoId: string, suggestedQuality?: YouTubePlaybackQuality | string) => {
    const player = playerRef.current;
    if (!player) return;
    const now = Date.now();
    if (
      loadedVideoIdRef.current === videoId &&
      now - loadedVideoAtRef.current < LOAD_DEDUPE_MS
    ) {
      return;
    }
    // A new load replaces the previous video, so an error from that video must
    // not stay overlaid. Only clear once the dedupe check has passed: skipping
    // the load must not hide an error for a video that is still current.
    setError(null);
    loadedVideoIdRef.current = videoId;
    loadedVideoAtRef.current = now;
    // A new video invalidates any position queued against the old one.
    clearPendingSeek();
    clearSeekRecoveryTimer();
    seekRecoveringRef.current = false;
    lastSeekRecoveryMsRef.current = 0;
    seekRecoveryAtRef.current = 0;
    bufferingRef.current = false;
    stateRef.current = null;
    const effectiveQuality = suggestedQuality ?? (lowQualityRef.current ? 'tiny' : undefined);
    try {
      if (effectiveQuality && effectiveQuality !== 'default') {
        const loader = playerRef.current as unknown as {
          loadVideoById?: (args: string | { videoId: string; startSeconds?: number; suggestedQuality?: string }) => void;
        };
        if (loader.loadVideoById) {
          try {
            loader.loadVideoById({ videoId, suggestedQuality: effectiveQuality });
            return;
          } catch {
          }
        }
      }
      player.loadVideoById(videoId);
    } catch {
    }
  }, [clearPendingSeek, clearSeekRecoveryTimer]);

  const play = useCallback(() => {
    playerRef.current?.playVideo();
  }, []);
  const pause = useCallback(() => {
    playerRef.current?.pauseVideo();
  }, []);
  const seekTo = useCallback((seconds: number) => {
    if (!playerRef.current) return;
    if (bufferingRef.current) {
      // Do not restart the load: remember the newest target and apply it once
      // the buffering phase ends (see onStateChange).
      pendingSeekRef.current = seconds;
      if (pendingSeekTimerRef.current == null) {
        pendingSeekTimerRef.current = window.setTimeout(() => {
          pendingSeekTimerRef.current = null;
          const target = pendingSeekRef.current;
          if (target == null) return;
          pendingSeekRef.current = null;
          applySeek(target);
        }, PENDING_SEEK_MAX_WAIT_MS);
      }
      return;
    }
    applySeek(seconds);
  }, [applySeek]);
  const getCurrentTime = useCallback(() => {
    return playerRef.current?.getCurrentTime() ?? 0;
  }, []);
  const getIsPlaying = useCallback(() => isPlayingRef.current, []);
  const isBuffering = useCallback(() => bufferingRef.current, []);
  const getSeekRecoveryMs = useCallback(() => {
    const measuredAt = seekRecoveryAtRef.current;
    if (!measuredAt || Date.now() - measuredAt > SEEK_RECOVERY_TTL_MS) return 0;
    return lastSeekRecoveryMsRef.current;
  }, []);
  const setVolume = useCallback((volume: number) => {
    const v = Math.max(0, Math.min(100, Math.round(volume)));
    try { (playerRef.current as unknown as { setVolume: (v: number) => void })?.setVolume(v); } catch {}
  }, []);
  const getVolume = useCallback(() => {
    try { return (playerRef.current as unknown as { getVolume: () => number })?.getVolume() ?? 100; } catch { return 100; }
  }, []);

  const setPlaybackQuality = useCallback((quality: string) => {
    try {
      const p = playerRef.current as unknown as {
        setPlaybackQuality?: (q: string) => void;
        setPlaybackQualityRange?: (min: string, max: string) => void;
        getAvailableQualityLevels?: () => string[];
      } | null;
      if (!p) return;
      // If requested quality not available, fallback tiny -> small
      let target: string = quality;
      if (quality === 'tiny') {
        try {
          const levels = p.getAvailableQualityLevels?.();
          if (levels && levels.length > 0 && !levels.includes('tiny')) {
            if (levels.includes('small')) target = 'small';
          }
        } catch {
          // ignore availability check failure, keep original
        }
      }
      p.setPlaybackQuality?.(target);
      // Also constrain range if API supports it, to prevent auto upswitch
      p.setPlaybackQualityRange?.(target, target);
    } catch {
      // Ignore if method doesn't exist on this player version
    }
  }, []);

  const getPlaybackQuality = useCallback((): string => {
    try {
      const p = playerRef.current as unknown as {
        getPlaybackQuality?: () => string;
      } | null;
      const q = p?.getPlaybackQuality?.();
      return typeof q === 'string' && q.length > 0 ? q : 'default';
    } catch {
      return 'default';
    }
  }, []);

  const setLowQualityMode = useCallback((enabled: boolean) => {
    lowQualityRef.current = enabled;
    try {
      if (enabled) setPlaybackQuality('tiny');
      else setPlaybackQuality('default');
    } catch {
    }
  }, [setPlaybackQuality]);

  return {
    ready,
    error,
    containerRef,
    loadMedia,
    play,
    pause,
    seekTo,
    getCurrentTime,
    getIsPlaying,
    isBuffering,
    getSeekRecoveryMs,
    setVolume,
    getVolume,
    setPlaybackQuality,
    getPlaybackQuality,
    setLowQualityMode,
  };
}
