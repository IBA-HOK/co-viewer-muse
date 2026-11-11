import { useCallback, useEffect, useRef, useState } from 'react';
import type { MediaConnection } from 'peerjs';
import { RnnoiseWorkletNode, loadRnnoise } from '@sapphi-red/web-noise-suppressor';
import rnnoiseWorkletUrl from '@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url';
import rnnoiseWasmUrl from '@sapphi-red/web-noise-suppressor/rnnoise.wasm?url';
import rnnoiseSimdWasmUrl from '@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url';
import type { UsePeerResult } from './usePeer';
import type { UseRoomSyncResult } from './useRoomSync';
import { resolvePeerGain, type SavedMixerValues } from './voiceMixer';

export interface UseVoiceChatOptions {
  peer: UsePeerResult;
  roomSync: UseRoomSyncResult;
  isHost: boolean;
  myId: string | null;
}

export interface UseVoiceChatResult {
  inVc: boolean;
  muted: boolean;
  noiseCancel: boolean;
  noiseCancelAvailable: boolean;
  starting: boolean;
  error: string | null;
  remoteStreams: Record<string, MediaStream>;
  audioLevels: Record<string, number>;
  localLevel: number;
  hostStart: () => void;
  hostStop: () => void;
  guestJoin: () => void;
  leave: () => void;
  toggleMute: () => void;
  toggleNoiseCancel: () => void;
  setPeerVolume: (peerId: string, volume: number) => void;
  setMasterVolume: (volume: number) => void;
  getPeerVolume: (peerId: string) => number;
  getMasterVolume: () => number;
}

interface RemoteAnalyser {
  source: MediaStreamAudioSourceNode;
  analyser: AnalyserNode;
  gain: GainNode;
}

/**
 * iOS (Safari / WKWebView = Brave・Chrome含む全iOSブラウザ) か否か。
 * iOS WebKit には「AudioContext.createMediaStreamDestination() の出力を
 * RTCPeerConnection に送ると無音になる」という長年の不具合がある。
 * そのため iOS では加工済みストリームを送らず生マイクを送る。
 */
function isIOSDevice(): boolean {
  try {
    const ua = navigator.userAgent || '';
    if (/iPad|iPhone|iPod/.test(ua)) return true;
    // iPadOS 13+ は MacIntel と名乗る + タッチあり
    if (navigator.platform === 'MacIntel' && (navigator.maxTouchPoints ?? 0) > 1) return true;
    return false;
  } catch {
    return false;
  }
}

/**
 * Voice-chat orchestration over PeerJS media connections.
 *
 * Topology: a full mesh where every participant exchanges a 1:1 media call with
 * every other participant. To avoid double-calls between a pair, the peer with
 * the lexicographically greater id is the sole initiator; the smaller answers.
 * This is echo-free (you never receive your own mic) and needs no mixing.
 *
 * Local audio is routed through a stable MediaStreamDestination. The
 * noise-cancellation worklet is inserted/removed by rewiring the Web Audio graph
 * so the stream identity never changes — no re-negotiation required.
 *
 * Remote audio is played through the AudioContext destination (not a media
 * element) so it rides the WebRTC/voice audio path on mobile, keeping it
 * separate from the video iframe's media-element audio (speaker). Each remote
 * stream is also tapped by an AnalyserNode for per-user volume bars.
 */
export function useVoiceChat(opts: UseVoiceChatOptions): UseVoiceChatResult {
  const { peer, roomSync, isHost, myId } = opts;

  const [inVc, setInVc] = useState(false);
  const [muted, setMuted] = useState(false);
  const [noiseCancel, setNoiseCancel] = useState(false);
  const [noiseCancelAvailable, setNoiseCancelAvailable] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [remoteStreams, setRemoteStreams] = useState<Record<string, MediaStream>>({});
  const [audioLevels, setAudioLevels] = useState<Record<string, number>>({});
  const [localLevel, setLocalLevel] = useState(0);

  const audioCtxRef = useRef<AudioContext | null>(null);
  const rawStreamRef = useRef<MediaStream | null>(null);
  const sourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const rnnoiseNodeRef = useRef<RnnoiseWorkletNode | null>(null);
  const destinationRef = useRef<MediaStreamAudioDestinationNode | null>(null);
  const localAnalyserRef = useRef<AnalyserNode | null>(null);
  const remoteAnalysersRef = useRef<Map<string, RemoteAnalyser>>(new Map());
  const masterGainRef = useRef<GainNode | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const connectionsRef = useRef<Map<string, MediaConnection>>(new Map());
  const answeredRef = useRef<Set<string>>(new Set());
  const meterTimerRef = useRef<number | undefined>(undefined);
  /** Serializes concurrent start attempts so getUserMedia/AudioContext are created once. */
  const startingPromiseRef = useRef<Promise<boolean> | null>(null);
  /** Incremented per start attempt and on leave/hostStop to cancel a pending start. */
  const startSessionRef = useRef(0);

  // Mirror state into refs for use inside stable (long-lived) callbacks.
  const inVcRef = useRef(false);
  const mutedRef = useRef(false);
  const noiseCancelRef = useRef(false);
  inVcRef.current = inVc;
  mutedRef.current = muted;
  noiseCancelRef.current = noiseCancel;

  const { vcPeers, broadcastVcPeer, setVcActive } = roomSync;
  const vcPeersRef = useRef<Set<string>>(vcPeers);
  vcPeersRef.current = vcPeers;

  const setRemoteStream = useCallback((peerId: string, stream: MediaStream) => {
    setRemoteStreams((prev) => ({ ...prev, [peerId]: stream }));
  }, []);

  const removeRemoteStream = useCallback((peerId: string) => {
    const entry = remoteAnalysersRef.current.get(peerId);
    if (entry) {
      try {
        entry.source.disconnect();
      } catch {
        /* noop */
      }
      try {
        entry.analyser.disconnect();
      } catch {
        /* noop */
      }
      try {
        entry.gain.disconnect();
      } catch {
        /* noop */
      }
      remoteAnalysersRef.current.delete(peerId);
    }
    setRemoteStreams((prev) => {
      if (!prev[peerId]) return prev;
      const next = { ...prev };
      delete next[peerId];
      return next;
    });
  }, []);

  /** RMS level (0..1) from an analyser's time-domain data. */
  const readLevel = useCallback((analyser: AnalyserNode): number => {
    const buf = new Uint8Array(analyser.fftSize);
    analyser.getByteTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) {
      const v = (buf[i] - 128) / 128;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / buf.length);
    return Math.min(1, rms * 3);
  }, []);

  const attachRemote = useCallback((peerId: string, stream: MediaStream) => {
    const ctx = audioCtxRef.current;
    if (!ctx) {
      const audio = document.createElement('audio');
      audio.srcObject = stream;
      (audio as HTMLAudioElement & { playsInline?: boolean }).playsInline = true;
      audio.autoplay = true;
      void audio.play().catch(() => {});
      return;
    }
    if (ctx.state === 'suspended') void ctx.resume().catch(() => {});
    try {
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.3;
      const gain = ctx.createGain();
      let savedMixer: SavedMixerValues | null = null;
      try {
        const saved = localStorage.getItem('co-viewer:mixer');
        if (saved) savedMixer = JSON.parse(saved) as SavedMixerValues;
      } catch {}
      gain.gain.value = resolvePeerGain(savedMixer, peerId);
      source.connect(analyser);
      analyser.connect(gain);
      const master = masterGainRef.current;
      if (master) gain.connect(master);
      else gain.connect(ctx.destination);
      const prev = remoteAnalysersRef.current.get(peerId);
      if (prev) {
        try { prev.source.disconnect(); } catch {}
        try { prev.analyser.disconnect(); } catch {}
        try { prev.gain.disconnect(); } catch {}
      }
      remoteAnalysersRef.current.set(peerId, { source, analyser, gain });
    } catch {
      const audio = document.createElement('audio');
      audio.srcObject = stream;
      (audio as HTMLAudioElement & { playsInline?: boolean }).playsInline = true;
      audio.autoplay = true;
      void audio.play().catch(() => {});
    }
  }, []);

  const onRemoteStream = useCallback(
    (peerId: string, stream: MediaStream) => {
      setRemoteStream(peerId, stream);
      attachRemote(peerId, stream);
    },
    [setRemoteStream, attachRemote]
  );

  /** Rewire the audio graph to enable/disable the RNNoise worklet in place. */
  const applyNoiseCancel = useCallback((on: boolean) => {
    const src = sourceNodeRef.current;
    const rn = rnnoiseNodeRef.current;
    const dest = destinationRef.current;
    if (!src || !dest) return;
    try {
      src.disconnect();
    } catch {
      /* noop */
    }
    try {
      rn?.disconnect();
    } catch {
      /* noop */
    }
    if (on && rn) {
      src.connect(rn);
      rn.connect(dest);
    } else {
      src.connect(dest);
    }
    // Preserve the local metering tap regardless of the send path.
    const la = localAnalyserRef.current;
    if (la) {
      try {
        src.connect(la);
      } catch {
        /* noop */
      }
    }
  }, []);

  const startMeter = useCallback(() => {
    if (meterTimerRef.current !== undefined) return;
    meterTimerRef.current = window.setInterval(() => {
      const levels: Record<string, number> = {};
      remoteAnalysersRef.current.forEach((entry, peerId) => {
        levels[peerId] = readLevel(entry.analyser);
      });
      setAudioLevels(levels);
      if (localAnalyserRef.current) setLocalLevel(readLevel(localAnalyserRef.current));
    }, 100);
  }, [readLevel]);

  const stopMeter = useCallback(() => {
    if (meterTimerRef.current !== undefined) {
      window.clearInterval(meterTimerRef.current);
      meterTimerRef.current = undefined;
    }
    setAudioLevels({});
    setLocalLevel(0);
  }, []);

  const ensureMedia = useCallback(async (session: number): Promise<boolean> => {
    if (localStreamRef.current) return true;
    setStarting(true);
    setError(null);

    let raw: MediaStream | null = null;
    let ctx: AudioContext | null = null;
    let src: MediaStreamAudioSourceNode | null = null;
    let dest: MediaStreamAudioDestinationNode | null = null;
    let localAnalyser: AnalyserNode | null = null;
    let master: GainNode | null = null;
    let rnnoise: RnnoiseWorkletNode | null = null;

    const cancelled = () => startSessionRef.current !== session;

    const cleanup = () => {
      raw?.getTracks().forEach((t) => t.stop());
      try {
        src?.disconnect();
      } catch {
        /* noop */
      }
      try {
        rnnoise?.disconnect();
      } catch {
        /* noop */
      }
      try {
        dest?.disconnect();
      } catch {
        /* noop */
      }
      try {
        localAnalyser?.disconnect();
      } catch {
        /* noop */
      }
      try {
        master?.disconnect();
      } catch {
        /* noop */
      }
      try {
        ctx?.close().catch(() => undefined);
      } catch {
        /* noop */
      }
      if (rawStreamRef.current === raw) rawStreamRef.current = null;
      if (sourceNodeRef.current === src) sourceNodeRef.current = null;
      if (rnnoiseNodeRef.current === rnnoise) rnnoiseNodeRef.current = null;
      if (destinationRef.current === dest) destinationRef.current = null;
      if (localAnalyserRef.current === localAnalyser) localAnalyserRef.current = null;
      if (masterGainRef.current === master) masterGainRef.current = null;
      if (audioCtxRef.current === ctx) audioCtxRef.current = null;
      if (localStreamRef.current === raw || localStreamRef.current === dest?.stream) {
        localStreamRef.current = null;
      }
    };

    try {
      raw = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: false, autoGainControl: true },
        video: false,
      });
      // A stop/leave may have happened while the permission prompt was open.
      if (cancelled()) {
        cleanup();
        return false;
      }
      rawStreamRef.current = raw;

      const useRawSend = isIOSDevice();

      ctx = new AudioContext();
      audioCtxRef.current = ctx;
      await ctx.resume();
      if (cancelled()) {
        cleanup();
        return false;
      }

      master = ctx.createGain();
      try {
        const saved = localStorage.getItem('co-viewer:mixer');
        if (saved) {
          const m = JSON.parse(saved) as { vcMaster?: number };
          if (typeof m.vcMaster === 'number') master.gain.value = Math.max(0, Math.min(1, m.vcMaster / 100));
        }
      } catch {}
      master.connect(ctx.destination);
      masterGainRef.current = master;

      src = ctx.createMediaStreamSource(raw);
      sourceNodeRef.current = src;
      dest = ctx.createMediaStreamDestination();
      destinationRef.current = dest;

      localAnalyser = ctx.createAnalyser();
      localAnalyser.fftSize = 256;
      src.connect(localAnalyser);
      localAnalyserRef.current = localAnalyser;

      if (useRawSend) {
        setNoiseCancelAvailable(false);
        noiseCancelRef.current = false;
        setNoiseCancel(false);
        try {
          src.connect(dest);
        } catch {}
        localStreamRef.current = raw;
      } else {
        let hasRn = false;
        try {
          const wasm = await loadRnnoise({ url: rnnoiseWasmUrl, simdUrl: rnnoiseSimdWasmUrl });
          if (cancelled()) {
            cleanup();
            return false;
          }
          await ctx.audioWorklet.addModule(rnnoiseWorkletUrl);
          if (cancelled()) {
            cleanup();
            return false;
          }
          rnnoise = new RnnoiseWorkletNode(ctx, {
            wasmBinary: wasm,
            maxChannels: 2,
          });
          rnnoiseNodeRef.current = rnnoise;
          hasRn = true;
        } catch {
          rnnoise = null;
          rnnoiseNodeRef.current = null;
          hasRn = false;
        }
        setNoiseCancelAvailable(hasRn);

        const wantNoise = hasRn;
        noiseCancelRef.current = wantNoise;
        setNoiseCancel(wantNoise);
        applyNoiseCancel(wantNoise);

        const sendStream = dest.stream;
        const liveTracks = sendStream.getAudioTracks().filter((t) => t.readyState === 'live');
        localStreamRef.current = liveTracks.length > 0 ? sendStream : raw;
      }
      raw.getAudioTracks().forEach((t) => {
        t.enabled = !mutedRef.current;
      });
      return true;
    } catch {
      // Always release anything acquired before the failure (mic tracks,
      // AudioContext, nodes) before reporting the error.
      cleanup();
      if (cancelled()) {
        return false;
      }
      setError('マイクの取得に失敗しました。権限を確認してください。');
      return false;
    } finally {
      setStarting(false);
    }
  }, [applyNoiseCancel]);

  const answerPending = useCallback(() => {
    if (!inVcRef.current || !localStreamRef.current) return;
    if (audioCtxRef.current?.state === 'suspended') void audioCtxRef.current.resume().catch(() => {});
    connectionsRef.current.forEach((call, peerId) => {
      if (!answeredRef.current.has(peerId)) {
        try {
          call.answer(localStreamRef.current!);
          answeredRef.current.add(peerId);
        } catch {
          /* noop */
        }
      }
    });
  }, []);

  const join = useCallback(async (): Promise<boolean> => {
    if (inVcRef.current) return true;
    const pending = startingPromiseRef.current;
    if (pending) {
      // A start is already waiting on getUserMedia; share it instead of
      // acquiring a second stream / AudioContext.
      return pending;
    }

    startSessionRef.current += 1;
    const session = startSessionRef.current;
    const task = (async () => {
      const ready = await ensureMedia(session);
      if (!ready || startSessionRef.current !== session) return false;
      setInVc(true);
      broadcastVcPeer(true);
      answerPending();
      startMeter();
      return true;
    })();
    startingPromiseRef.current = task;
    try {
      return await task;
    } finally {
      if (startingPromiseRef.current === task) startingPromiseRef.current = null;
    }
  }, [ensureMedia, broadcastVcPeer, answerPending, startMeter]);

  const leave = useCallback(() => {
    // Invalidate any in-flight start so it cannot revive the VC after this stop.
    startSessionRef.current += 1;
    stopMeter();
    connectionsRef.current.forEach((call) => call.close());
    connectionsRef.current.clear();
    answeredRef.current.clear();
    setRemoteStreams({});

    rawStreamRef.current?.getTracks().forEach((t) => t.stop());
    rawStreamRef.current = null;
    try {
      sourceNodeRef.current?.disconnect();
    } catch {
      /* noop */
    }
    try {
      rnnoiseNodeRef.current?.disconnect();
    } catch {
      /* noop */
    }
    try {
      destinationRef.current?.disconnect();
    } catch {
      /* noop */
    }
    try {
      localAnalyserRef.current?.disconnect();
    } catch {
      /* noop */
    }
    rnnoiseNodeRef.current = null;
    localAnalyserRef.current = null;
    audioCtxRef.current?.close().catch(() => undefined);
    audioCtxRef.current = null;
    localStreamRef.current = null;

    setInVc(false);
    setMuted(false);
    mutedRef.current = false;
    broadcastVcPeer(false);
  }, [stopMeter, broadcastVcPeer]);

  const hostStart = useCallback(async () => {
    if (!isHost) return;
    setVcActive(true);
    const started = await join();
    if (!started) {
      // The room must not stay LIVE when the local mic/setup failed.
      setVcActive(false);
      broadcastVcPeer(false);
    }
  }, [isHost, setVcActive, broadcastVcPeer, join]);

  const hostStop = useCallback(() => {
    if (!isHost) return;
    leave();
    setVcActive(false);
  }, [isHost, leave, setVcActive]);

  const guestJoin = useCallback(() => {
    if (isHost) return;
    if (!roomSync.vcActive) return;
    void join();
  }, [isHost, roomSync.vcActive, join]);

  const toggleMute = useCallback(() => {
    const next = !mutedRef.current;
    mutedRef.current = next;
    setMuted(next);
    rawStreamRef.current?.getAudioTracks().forEach((t) => {
      t.enabled = !next;
    });
  }, []);

  const toggleNoiseCancel = useCallback(() => {
    if (!noiseCancelAvailable) return;
    const next = !noiseCancelRef.current;
    noiseCancelRef.current = next;
    setNoiseCancel(next);
    applyNoiseCancel(next);
  }, [noiseCancelAvailable, applyNoiseCancel]);

  const setPeerVolume = useCallback((peerId: string, volume: number) => {
    const e = remoteAnalysersRef.current.get(peerId);
    if (e) e.gain.gain.value = Math.max(0, Math.min(1, volume / 100));
  }, []);

  const setMasterVolume = useCallback((volume: number) => {
    const g = masterGainRef.current;
    if (g) g.gain.value = Math.max(0, Math.min(1, volume / 100));
  }, []);

  const getPeerVolume = useCallback((peerId: string) => {
    const e = remoteAnalysersRef.current.get(peerId);
    return e ? Math.round(e.gain.gain.value * 100) : 100;
  }, []);

  const getMasterVolume = useCallback(() => {
    const g = masterGainRef.current;
    return g ? Math.round(g.gain.value * 100) : 100;
  }, []);
  const handleIncomingCall = useCallback(
    (call: MediaConnection) => {
      if (audioCtxRef.current?.state === 'suspended') void audioCtxRef.current.resume().catch(() => {});
      connectionsRef.current.set(call.peer, call);
      call.on('stream', (s: MediaStream) => onRemoteStream(call.peer, s));
      call.on('close', () => {
        connectionsRef.current.delete(call.peer);
        answeredRef.current.delete(call.peer);
        removeRemoteStream(call.peer);
      });
      call.on('error', () => {
        connectionsRef.current.delete(call.peer);
        answeredRef.current.delete(call.peer);
        removeRemoteStream(call.peer);
      });
      if (
        inVcRef.current &&
        localStreamRef.current &&
        !answeredRef.current.has(call.peer)
      ) {
        try {
          if (audioCtxRef.current?.state === 'suspended') void audioCtxRef.current.resume().catch(() => {});
          call.answer(localStreamRef.current);
          answeredRef.current.add(call.peer);
        } catch {
          /* noop */
        }
      }
    },
    [onRemoteStream, removeRemoteStream]
  );

  useEffect(() => {
    peer.onCall(handleIncomingCall);
  }, [peer, handleIncomingCall]);

  useEffect(() => {
    const onVis = () => {
      if (!document.hidden && audioCtxRef.current?.state === 'suspended') void audioCtxRef.current.resume().catch(() => {});
    };
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('focus', onVis);
    window.addEventListener('pageshow', onVis);
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('focus', onVis);
      window.removeEventListener('pageshow', onVis);
    };
  }, []);

  useEffect(() => {
    if (!audioCtxRef.current) return;
    Object.entries(remoteStreams).forEach(([peerId, stream]) => {
      if (!remoteAnalysersRef.current.has(peerId)) attachRemote(peerId, stream);
    });
  }, [remoteStreams, attachRemote]);

  useEffect(() => {
    if (inVc && localStreamRef.current) answerPending();
  }, [vcPeers, inVc, answerPending]);

  // Mesh maintenance: create outgoing calls for pairs where we are the initiator,
  // and tear down connections to peers who left the VC.
  useEffect(() => {
    if (!inVc || !myId || !localStreamRef.current) return;
    if (audioCtxRef.current?.state === 'suspended') void audioCtxRef.current.resume().catch(() => {});
    const conns = connectionsRef.current;
    vcPeers.forEach((peerId) => {
      if (peerId === myId) return;
      const isInitiator = myId > peerId;
      const existing = conns.get(peerId);
      if (isInitiator && !existing) {
        const call = peer.callPeer(peerId, localStreamRef.current!);
        if (call) {
          call.on('stream', (s: MediaStream) => onRemoteStream(peerId, s));
          call.on('close', () => {
            conns.delete(peerId);
            answeredRef.current.delete(peerId);
            removeRemoteStream(peerId);
          });
          call.on('error', () => {
            conns.delete(peerId);
            answeredRef.current.delete(peerId);
            removeRemoteStream(peerId);
          });
          conns.set(peerId, call);
        }
      }
    });
    conns.forEach((call, peerId) => {
      if (!vcPeers.has(peerId)) {
        call.close();
        conns.delete(peerId);
        answeredRef.current.delete(peerId);
        removeRemoteStream(peerId);
      }
    });
  }, [inVc, myId, vcPeers, peer, onRemoteStream, removeRemoteStream]);

  // Auto-leave if the host closes the room.
  useEffect(() => {
    if (!roomSync.vcActive && inVc) {
      leave();
    }
  }, [roomSync.vcActive, inVc, leave]);

  // Cleanup on unmount.
  useEffect(
    () => () => {
      if (meterTimerRef.current !== undefined) {
        window.clearInterval(meterTimerRef.current);
      }
      connectionsRef.current.forEach((c) => c.close());
      connectionsRef.current.clear();
      rawStreamRef.current?.getTracks().forEach((t) => t.stop());
      audioCtxRef.current?.close().catch(() => undefined);
    },
    []
  );

  return {
    inVc,
    muted,
    noiseCancel,
    noiseCancelAvailable,
    starting,
    error,
    remoteStreams,
    audioLevels,
    localLevel,
    hostStart,
    hostStop,
    guestJoin,
    leave,
    toggleMute,
    toggleNoiseCancel,
    setPeerVolume,
    setMasterVolume,
    getPeerVolume,
    getMasterVolume,
  };
}
