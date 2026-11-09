import { useCallback, useEffect, useRef, useState } from 'react';
import { classifyNicoError, type NicoError } from '../nicoErrors';
import type { LocalPlayerEvent, PlayerController } from '../types';

export interface UseNiconicoPlayerOptions {
  isRemoteSyncingRef: React.MutableRefObject<boolean>;
  onLocalEvent: (e: LocalPlayerEvent) => void;
}

export interface UseNiconicoPlayerResult extends PlayerController {
  ready: boolean;
  error: NicoError | null;
  insecureContext: boolean;
  containerRef: React.RefObject<HTMLDivElement>;
  /**
   * Best-effort low-bandwidth hint for the Niconico embed.
   *
   * Currently a NO-OP for bandwidth: the embed has no postMessage quality API
   * and its URL ignores quality/economy params (see module docs). The method is
   * kept as a stable extension point so callers (e.g. audioOnly mode) can
   * signal intent without branching on platform. If Niconico ever exposes a
   * quality API, wire it here without changing callers.
   */
  setLowBandwidthMode(enabled: boolean): void;
  /** Current low-bandwidth hint state (mirrors last `setLowBandwidthMode` call). */
  lowBandwidthMode: boolean;
}

const NICO_ORIGIN = 'https://embed.nicovideo.jp';

/**
 * Bandwidth / quality investigation (2026-03 / 2026-09) — summary for future
 * maintainers:
 *
 * 1. postMessage API surface (unofficial but stable, `jsapi=1`):
 *    Confirmed commands by cross-referencing the app, the Zenn unofficial
 *    reference (xpadev, 2023-04), the GitHub gist `wkurosawa/nicovideo-html5-
 *    embed-player-api`, `mf-Mii/nicovideo-iframe-api`, and
 *    `bonjinnorenka/multi_embed_player`:
 *      - inbound (embed → host): `loadComplete`, `playerStatusChange`,
 *        `playerMetadataChange`, `statusChange`, `error`, `seekStatusChange`,
 *        `enterProgrammaticFullScreen` / `exitProgrammaticFullScreen`
 *      - outbound (host → embed): `play`, `pause`, `seek` (ms),
 *        `volumeChange` (0..1), `mute` (bool), `commentVisibilityChange`
 *        (bool), `incrementViewCount`
 *    No `quality` / `setQuality` / `setPlaybackQuality` / `economy` command
 *    exists. YouTube's `setPlaybackQuality` has no Niconico equivalent.
 *
 * 2. Embed URL params:
 *    Documented/observed params are `jsapi`, `playerId`, `referer`, `from`,
 *    and in some wrappers `w`/`h`. There is no documented `quality`,
 *    `economy`, or `eco` param for `embed.nicovideo.jp`. The classic watch-
 *    page flag `?eco=1` / `?economy=1` forced the old "エコノミーモード"
 *    (low-bitrate transcode served at peak hours to non-premium users). That
 *    mode was **abolished 2024-03-01** (Dwango/Niconico Info 215661): all users
 *    now receive up to 720p and the server no longer downgrades by time-of-day.
 *    Even before abolition, the flag applied to `nicovideo.jp/watch/*`, not to
 *    the embed. Adding `eco=1` / `economy=1` to the embed URL is silently
 *    ignored.
 *
 * 3. Fundamental limitation:
 *    The embed serves a single **muxed** MP4/DASH stream (video + audio
 *    interleaved). The jsapi does not expose separate audio/video tracks, so
 *    there is no "audio-only" stream to select. Hiding the iframe with a 0×0
 *    div (as `Player.tsx` does in host audioOnly mode) removes paint/composite
 *    cost but does **not** stop the CDN fetch — the same bytes are downloaded.
 *    True audio-only would require either a server-side audio extraction
 *    (out of scope, ToS risk) or a future Niconico embed quality API.
 *
 * 4. What we CAN do (implemented below):
 *    - Never re-assign `iframe.src` for the same `videoId` — toggling
 *      `audioOnly` (which only changes CSS visibility) must not trigger a
 *      reload / extra segment fetch.
 *    - Track `lowBandwidthMode` as state + expose `setLowBandwidthMode()` as a
 *      no-op extension point; if the embed ever gains a quality command or
 *      meaningful URL param, this is the single place to wire it.
 *    - When `lowBandwidthMode` is enabled, `buildNicoEmbedSrc` appends the
 *      legacy `eco=1` param as a best-effort hint. Currently it has no effect
 *      but is harmless (unknown params are ignored) and will take effect
 *      automatically if Niconico reintroduces an economy flag.
 *    - Keep `loadMedia` / `postCommand` side-effect free with respect to
 *      `audioOnly` so callers can toggle the mode without reloading.
 */

/**
 * Builds the Niconico embed iframe URL. The `referer` param is required: without
 * it the embed relies on the HTTP Referer header, which browsers strip for
 * IP-based origins (e.g. http://192.168.x.x). That makes Niconico reject the
 * embed on plain-HTTP LAN IPs while localhost (a secure context) works.
 *
 * Bandwidth note: when `opts.lowBandwidth` is true the legacy `eco=1` param is
 * appended as a best-effort hint for Niconico's (now-abolished) economy mode.
 * It is currently ignored by `embed.nicovideo.jp` but is retained harmlessly so
 * that a server-side reintroduction would be picked up without a code change.
 * See module-level docs for the full investigation.
 */
export function buildNicoEmbedSrc(
  videoId: string,
  playerId: string,
  referer: string,
  opts?: { lowBandwidth?: boolean },
): string {
  const params = new URLSearchParams({
    jsapi: '1',
    playerId,
    referer,
    from: '0',
  });
  if (opts?.lowBandwidth) {
    // Legacy flag: watch-page `?eco=1` forced economy transcode. Embed ignores
    // it today; harmless to include. Do NOT use `economy=1` — same effect but
    // less historically accurate.
    params.set('eco', '1');
  }
  return `${NICO_ORIGIN}/watch/${encodeURIComponent(videoId)}?${params.toString()}`;
}

// playerStatus values reported by the embed player.
const NICO_STATUS = {
  BUFFERING: 1,
  PLAYING: 2,
  PAUSED: 3,
  ENDED: 4,
} as const;

/**
 * Maps a Niconico `playerStatus` to the room event it should broadcast.
 *
 * BUFFERING (1) is a transient network state, not a user intent, so it must
 * never become a PAUSE. Unknown statuses are likewise ignored. Callers still
 * update `bufferingRef` separately from this mapping.
 */
export function nicoStatusToLocalEvent(
  status: number,
  currentTime: number,
): LocalPlayerEvent | null {
  switch (status) {
    case NICO_STATUS.PLAYING:
      return { kind: 'PLAY', currentTime };
    case NICO_STATUS.PAUSED:
      return { kind: 'PAUSE', currentTime };
    case NICO_STATUS.ENDED:
      return { kind: 'END' };
    default:
      return null;
  }
}

function postCommand(
  iframe: HTMLIFrameElement | null,
  playerId: string,
  eventName: string,
  data?: Record<string, unknown>,
) {
  iframe?.contentWindow?.postMessage(
    { sourceConnectorType: 1, playerId, eventName, data },
    NICO_ORIGIN,
  );
}

/**
 * Niconico embed player adapter. Uses the unofficial-but-stable postMessage
 * protocol (jsapi=1, playerId multiplexing). Time values are in MILLISECONDS on
 * the wire; we convert to seconds for the PlayerController contract.
 *
 * AudioOnly bandwidth behaviour: see module-level docs. In short, the iframe
 * stays mounted even when the host hides it (0×0 div) because unmounting would
 * destroy playback and force a full re-fetch on return. The hook therefore
 * avoids any reload when `audioOnly` toggles and deduplicates `loadMedia` for
 * the same videoId.
 */
export function useNiconicoPlayer(
  opts: UseNiconicoPlayerOptions,
): UseNiconicoPlayerResult {
  const containerRef = useRef<HTMLDivElement>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const playerIdRef = useRef(`nico-${Math.random().toString(36).slice(2, 9)}`);
  const currentTimeRef = useRef(0); // seconds
  const isPlayingRef = useRef(false);
  const bufferingRef = useRef(false);
  const pendingSeekRef = useRef<number | null>(null);
  const shouldPlayRef = useRef(false);
  const loadedVideoIdRef = useRef<string | null>(null);
  const lowBandwidthRef = useRef(false);
  const [lowBandwidthMode, setLowBandwidthModeState] = useState(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<NicoError | null>(null);
  const insecureContext =
    typeof window !== 'undefined' && !window.isSecureContext;

  const optsRef = useRef(opts);
  optsRef.current = opts;

  // Create the iframe once and wire the global message listener.
  useEffect(() => {
    if (!containerRef.current) return;
    const iframe = document.createElement('iframe');
    iframe.className = 'h-full w-full';
    iframe.setAttribute('frameborder', '0');
    iframe.setAttribute('allow', 'autoplay; fullscreen');
    iframe.setAttribute('allowfullscreen', 'true');
    containerRef.current.appendChild(iframe);
    iframeRef.current = iframe;

    const onIframeLoad = () => {
      // Handshake required before the player streams status events.
      postCommand(iframe, playerIdRef.current, 'loadComplete');
    };
    iframe.addEventListener('load', onIframeLoad);

    const onMessage = (event: MessageEvent) => {
      if (event.origin !== NICO_ORIGIN) return;
      const data = event.data as
        | { sourceConnectorType?: number; playerId?: string; eventName?: string; data?: Record<string, unknown> }
        | undefined;
      if (!data || data.sourceConnectorType !== 0) return;
      if (data.playerId !== playerIdRef.current) return;

      switch (data.eventName) {
        case 'loadComplete':
          setReady(true);
          // The embed finished its handshake/load; a stale BUFFERING flag would
          // suppress drift correction forever.
          bufferingRef.current = false;
          if (shouldPlayRef.current) {
            if (pendingSeekRef.current != null) {
              postCommand(iframe, playerIdRef.current, 'seek', {
                time: Math.round(pendingSeekRef.current * 1000),
              });
            }
            postCommand(iframe, playerIdRef.current, 'play');
            shouldPlayRef.current = false;
          }
          break;
        case 'playerStatusChange': {
          const status = Number(data.data?.playerStatus);
          isPlayingRef.current = status === NICO_STATUS.PLAYING;
          // Drift corrections are meaningless while the embed is loading; the
          // sync layer reads this to hold off seeks during a rebuffer.
          bufferingRef.current = status === NICO_STATUS.BUFFERING;
          if (optsRef.current.isRemoteSyncingRef.current) break;
          const localEvent = nicoStatusToLocalEvent(
            status,
            currentTimeRef.current,
          );
          if (localEvent) optsRef.current.onLocalEvent(localEvent);
          break;
        }
        case 'playerMetadataChange': {
          const ms = Number(data.data?.currentTime);
          if (!Number.isNaN(ms)) currentTimeRef.current = ms / 1000;
          break;
        }
        case 'error': {
          setError(classifyNicoError(data.data?.code));
          break;
        }
      }
    };
    window.addEventListener('message', onMessage);

    return () => {
      iframe.removeEventListener('load', onIframeLoad);
      window.removeEventListener('message', onMessage);
      iframe.remove();
      iframeRef.current = null;
    };
  }, []);

  const loadMedia = useCallback((videoId: string) => {
    // Defensive dedupe: callers (e.g. Player.tsx effects) may re-invoke with
    // the same id when `audioOnly` toggles or when React re-renders. Re-
    // assigning `iframe.src` would abort in-flight segments and re-fetch the
    // video from the CDN, wasting bandwidth without any benefit.
    if (loadedVideoIdRef.current === videoId && iframeRef.current?.src) {
      // Already loaded — ensure we are still playing at the pending position
      // but do not reload the iframe.
      return;
    }
    setError(null);
    setReady(false);
    currentTimeRef.current = 0;
    isPlayingRef.current = false;
    bufferingRef.current = true;
    shouldPlayRef.current = true;
    pendingSeekRef.current = 0;
    loadedVideoIdRef.current = videoId;
    const referer = typeof window !== 'undefined' ? window.location.href : '';
    const src = buildNicoEmbedSrc(videoId, playerIdRef.current, referer, {
      lowBandwidth: lowBandwidthRef.current,
    });
    if (iframeRef.current) {
      iframeRef.current.src = src;
    }
  }, []);

  const play = useCallback(() => {
    postCommand(iframeRef.current, playerIdRef.current, 'play');
  }, []);
  const pause = useCallback(() => {
    postCommand(iframeRef.current, playerIdRef.current, 'pause');
  }, []);
  const seekTo = useCallback((seconds: number) => {
    // Wire protocol expects milliseconds.
    pendingSeekRef.current = seconds;
    postCommand(iframeRef.current, playerIdRef.current, 'seek', {
      time: Math.round(seconds * 1000),
    });
    currentTimeRef.current = seconds;
  }, []);
  const getCurrentTime = useCallback(() => currentTimeRef.current, []);
  const getIsPlaying = useCallback(() => isPlayingRef.current, []);
  const isBuffering = useCallback(() => bufferingRef.current, []);
  const setVolume = useCallback((volume: number) => {
    const v = Math.max(0, Math.min(100, Math.round(volume)));
    postCommand(iframeRef.current, playerIdRef.current, 'volumeChange', { volume: v / 100 });
  }, []);
  const getVolume = useCallback(() => 100, []);

  /**
   * Best-effort low-bandwidth hint. Today this only flips an internal flag so
   * that the *next* `loadMedia` will include the legacy `eco=1` param, and
   * records state for future wiring (e.g. if a `quality` postMessage command
   * appears). It intentionally does NOT reload the current video when toggled,
   * because that would *increase* bandwidth (full re-fetch) for a hint that is
   * currently ignored. Callers can call this on `audioOnly` changes without
   * fear of extra network traffic.
   *
   * Future extension point: if Niconico adds `eventName: 'qualityChange'` or
   * similar, send it here via `postCommand` and/or reload with the new URL
   * param behind a feature flag.
   */
  const setLowBandwidthMode = useCallback((enabled: boolean) => {
    lowBandwidthRef.current = enabled;
    setLowBandwidthModeState(enabled);
    // Intentionally no reload and no postMessage: no quality command exists.
    // Unknown postMessage eventNames are silently ignored by the embed, so
    // sending one would be harmless but also useless. Keep this stub minimal
    // until a real API is confirmed via network inspection of embed.nicovideo.jp.
  }, []);

  return {
    ready,
    error,
    insecureContext,
    containerRef,
    loadMedia,
    play,
    pause,
    seekTo,
    getCurrentTime,
    getIsPlaying,
    isBuffering,
    setVolume,
    getVolume,
    setLowBandwidthMode,
    lowBandwidthMode,
  };
}
