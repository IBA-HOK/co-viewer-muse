import { useCallback, useEffect, useRef, useState } from 'react';
import type { MutableRefObject, RefObject } from 'react';
import type { LocalPlayerEvent, PlayerController } from '../types';

export interface UseLocalFilePlayerOptions {
  isRemoteSyncingRef: MutableRefObject<boolean>;
  onLocalEvent: (e: LocalPlayerEvent) => void;
  /** videoId -> object URL. Returns null while the file is not selected yet. */
  resolveUrl: (videoId: string) => string | null;
  /** Do not propagate END (duration did not match the host's metadata). */
  suppressEnd?: boolean;
}

export interface UseLocalFilePlayerResult extends PlayerController {
  ready: boolean;
  error: string | null;
  /** Autoplay was rejected by the browser; show a "tap to play" affordance. */
  needsGesture: boolean;
  /** The file ended while `suppressEnd` was active. */
  endedSuppressed: boolean;
  mediaRef: RefObject<HTMLVideoElement>;
}

/** A measured seek recovery stays relevant for this long. */
const SEEK_RECOVERY_TTL_MS = 120000;
/** Safety net for a load that never completes (no loadedmetadata). */
const LOAD_SUPPRESSION_MS = 8000;
/** Do not leave a queued play/pause echo armed forever. */
const COMMAND_SUPPRESSION_MS = 1200;

function describeMediaError(el: HTMLVideoElement): string {
  const code = el.error?.code;
  switch (code) {
    case 1:
      return '読み込みが中断されました。もう一度ファイルを選択してください。';
    case 2:
      return 'ネットワークエラーでファイルを読み込めませんでした。再選択してください。';
    case 3:
      return 'ファイルをデコードできませんでした。別の形式で再選択してください。';
    case 4:
      return 'この形式はブラウザで再生できません。別の形式で再選択してください。';
    default:
      return 'ファイルを再生できませんでした。もう一度ファイルを選択してください。';
  }
}

/**
 * `PlayerController` implementation for a user-selected local audio/video file.
 *
 * The file bytes never leave the device: each participant binds their own copy
 * through an object URL, while the existing SYNC_PING / drift-guard machinery
 * drives play / pause / seek exactly as it does for the embedded players.
 */
export function useLocalFilePlayer(
  opts: UseLocalFilePlayerOptions
): UseLocalFilePlayerResult {
  const mediaRef = useRef<HTMLVideoElement>(null);
  const optsRef = useRef(opts);
  optsRef.current = opts;

  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsGesture, setNeedsGesture] = useState(false);
  const [endedSuppressed, setEndedSuppressed] = useState(false);

  const loadedKeyRef = useRef<string | null>(null);
  const pendingSeekRef = useRef<number | null>(null);
  const pendingPlayRef = useRef(false);
  const mountedRef = useRef(true);

  /** Suppresses the programmatic-event echo after load / seek / remote play. */
  const suppressRef = useRef(false);
  const suppressTimerRef = useRef<number | null>(null);

  const seekingRef = useRef(false);
  const seekStartedAtRef = useRef(0);
  const lastSeekRecoveryMsRef = useRef(0);
  const seekRecoveryAtRef = useRef(0);

  const clearSuppressionTimer = useCallback(() => {
    if (suppressTimerRef.current != null) {
      window.clearTimeout(suppressTimerRef.current);
      suppressTimerRef.current = null;
    }
  }, []);

  const clearSuppression = useCallback(() => {
    suppressRef.current = false;
    clearSuppressionTimer();
  }, [clearSuppressionTimer]);

  const armSuppression = useCallback(
    (ms: number) => {
      suppressRef.current = true;
      clearSuppressionTimer();
      suppressTimerRef.current = window.setTimeout(() => {
        suppressTimerRef.current = null;
        suppressRef.current = false;
      }, ms);
    },
    [clearSuppressionTimer]
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      clearSuppressionTimer();
    };
  }, [clearSuppressionTimer]);

  useEffect(() => {
    const el = mediaRef.current;
    if (!el) return;

    const emit = (event: LocalPlayerEvent) => {
      if (optsRef.current.isRemoteSyncingRef.current || suppressRef.current) {
        return;
      }
      optsRef.current.onLocalEvent(event);
    };

    const onLoadedMetadata = () => {
      if (!mountedRef.current) return;
      setReady(true);
      setError(null);
      const pending = pendingSeekRef.current;
      if (pending != null) {
        pendingSeekRef.current = null;
        try {
          el.currentTime = pending;
          // The seeked event is the echo of this programmatic jump.
          armSuppression(LOAD_SUPPRESSION_MS);
        } catch {
          clearSuppression();
        }
      } else {
        // Keep a short window so a remote play(), issued just after the load,
        // cannot broadcast a PLAY echo once the 400ms sync flag expires.
        armSuppression(COMMAND_SUPPRESSION_MS);
      }
      // A play() issued while the file was still loading (e.g. a sync
      // correction that beat loadedmetadata) is replayed now.
      if (pendingPlayRef.current) {
        pendingPlayRef.current = false;
        try {
          void (el.play() as Promise<void> | undefined)?.catch?.(
            (err: unknown) => {
              if (
                mountedRef.current &&
                (err as { name?: string })?.name === 'NotAllowedError'
              ) {
                setNeedsGesture(true);
              }
            }
          );
        } catch {
          // ignore
        }
      }
    };

    const onCanPlay = () => {
      if (mountedRef.current) setReady(true);
    };

    const onPlay = () => {
      setNeedsGesture(false);
      emit({ kind: 'PLAY', currentTime: el.currentTime || 0 });
      clearSuppression();
    };

    const onPause = () => {
      // `ended` fires after the final pause; do not report a spurious PAUSE.
      if (el.ended) return;
      emit({ kind: 'PAUSE', currentTime: el.currentTime || 0 });
      clearSuppression();
    };

    const onSeeking = () => {
      seekingRef.current = true;
      seekStartedAtRef.current = Date.now();
    };

    const onSeeked = () => {
      seekingRef.current = false;
      if (seekStartedAtRef.current > 0) {
        lastSeekRecoveryMsRef.current = Math.max(
          0,
          Date.now() - seekStartedAtRef.current
        );
        seekRecoveryAtRef.current = Date.now();
        seekStartedAtRef.current = 0;
      }
      const wasProgrammatic = suppressRef.current;
      clearSuppression();
      if (!wasProgrammatic) {
        emit({ kind: 'SEEK', currentTime: el.currentTime || 0 });
      }
    };

    const onEnded = () => {
      seekingRef.current = false;
      clearSuppression();
      if (optsRef.current.suppressEnd) {
        if (mountedRef.current) setEndedSuppressed(true);
        return;
      }
      if (mountedRef.current) setEndedSuppressed(false);
      if (!optsRef.current.isRemoteSyncingRef.current) {
        optsRef.current.onLocalEvent({ kind: 'END' });
      }
    };

    const onError = () => {
      if (!mountedRef.current) return;
      setReady(false);
      setError(describeMediaError(el));
    };

    el.addEventListener('loadedmetadata', onLoadedMetadata);
    el.addEventListener('canplay', onCanPlay);
    el.addEventListener('play', onPlay);
    el.addEventListener('pause', onPause);
    el.addEventListener('seeking', onSeeking);
    el.addEventListener('seeked', onSeeked);
    el.addEventListener('ended', onEnded);
    el.addEventListener('error', onError);

    return () => {
      el.removeEventListener('loadedmetadata', onLoadedMetadata);
      el.removeEventListener('canplay', onCanPlay);
      el.removeEventListener('play', onPlay);
      el.removeEventListener('pause', onPause);
      el.removeEventListener('seeking', onSeeking);
      el.removeEventListener('seeked', onSeeked);
      el.removeEventListener('ended', onEnded);
      el.removeEventListener('error', onError);
      clearSuppression();
    };
  }, [armSuppression, clearSuppression]);

  const loadMedia = useCallback(
    (videoId: string) => {
      const el = mediaRef.current;
      const url = optsRef.current.resolveUrl(videoId);
      if (!el || !url) {
        loadedKeyRef.current = null;
        setReady(false);
        setError(null);
        setEndedSuppressed(false);
        return;
      }
      const key = `${videoId}|${url}`;
      if (loadedKeyRef.current === key) return;
      loadedKeyRef.current = key;
      setReady(false);
      setError(null);
      setEndedSuppressed(false);
      setNeedsGesture(false);
      pendingSeekRef.current = null;
      pendingPlayRef.current = false;
      armSuppression(LOAD_SUPPRESSION_MS);
      try {
        el.src = url;
        el.load();
      } catch {
        setError('ファイルを読み込めませんでした。もう一度ファイルを選択してください。');
      }
    },
    [armSuppression]
  );

  const play = useCallback(() => {
    const el = mediaRef.current;
    if (!el) return;
    if (el.readyState < 1) {
      pendingPlayRef.current = true;
      return;
    }
    if (optsRef.current.isRemoteSyncingRef.current) {
      armSuppression(COMMAND_SUPPRESSION_MS);
    }
    try {
      const promise = el.play() as Promise<void> | undefined;
      if (promise && typeof promise.catch === 'function') {
        promise.catch((err: unknown) => {
          if (!mountedRef.current) return;
          if ((err as { name?: string })?.name === 'NotAllowedError') {
            setNeedsGesture(true);
          }
        });
      }
    } catch {
      // `play()` can throw synchronously when the source is not ready.
    }
  }, [armSuppression]);

  const pause = useCallback(() => {
    const el = mediaRef.current;
    if (!el) return;
    pendingPlayRef.current = false;
    if (optsRef.current.isRemoteSyncingRef.current) {
      armSuppression(COMMAND_SUPPRESSION_MS);
    }
    try {
      el.pause();
    } catch {
      // ignore
    }
  }, [armSuppression]);

  const seekTo = useCallback(
    (seconds: number) => {
      const el = mediaRef.current;
      if (!el) return;
      const target = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
      if (el.readyState < 1) {
        // Metadata is not available yet; apply once it is.
        pendingSeekRef.current = target;
        return;
      }
      armSuppression(LOAD_SUPPRESSION_MS);
      try {
        el.currentTime = target;
      } catch {
        pendingSeekRef.current = target;
        clearSuppression();
      }
    },
    [armSuppression, clearSuppression]
  );

  const getCurrentTime = useCallback(() => {
    const t = mediaRef.current?.currentTime;
    return typeof t === 'number' && Number.isFinite(t) ? t : 0;
  }, []);

  const getIsPlaying = useCallback(() => {
    const el = mediaRef.current;
    return !!el && !el.paused && !el.ended;
  }, []);

  const isBuffering = useCallback(() => {
    const el = mediaRef.current;
    if (!el) return false;
    return seekingRef.current || el.readyState < 3;
  }, []);

  const getSeekRecoveryMs = useCallback(() => {
    const measuredAt = seekRecoveryAtRef.current;
    if (!measuredAt || Date.now() - measuredAt > SEEK_RECOVERY_TTL_MS) return 0;
    return lastSeekRecoveryMsRef.current;
  }, []);

  const setVolume = useCallback((volume: number) => {
    const el = mediaRef.current;
    if (!el) return;
    const v = Math.max(0, Math.min(100, Math.round(volume)));
    try {
      el.volume = v / 100;
    } catch {
      // ignore
    }
  }, []);

  const getVolume = useCallback(() => {
    const el = mediaRef.current;
    return el ? Math.round(el.volume * 100) : 100;
  }, []);

  return {
    ready,
    error,
    needsGesture,
    endedSuppressed,
    mediaRef,
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
  };
}
