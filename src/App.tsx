import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePeer as usePeerHook } from './hooks/usePeer';
import { useMqttTransport } from './transport/mqtt';
import { getTransportKind, type TransportKind } from './transport/types';
import { useRoomSync } from './hooks/useRoomSync';
import { useVoiceChat } from './hooks/useVoiceChat';
import { Player } from './components/Player';
import QueuePanel from './components/QueuePanel';
import ChatPanel from './components/ChatPanel';
import ParticipantList from './components/ParticipantList';
import VoiceChatPanel from './components/VoiceChatPanel';
import BrowserPanel from './components/BrowserPanel';
import DriveModePanel from './components/DriveModePanel';
import VolumeMixerPanel from './components/VolumeMixerPanel';
import { computeUnreadChatCount } from './chatUnread';
import { scheduleResumeRetries, type ResumeRetryScheduler } from './playbackResume';
import {
  cancelNicknameBroadcast,
  flushNicknameBroadcast,
  scheduleNicknameBroadcast,
} from './nicknameBroadcast';
import JoinModal from './components/JoinModal';
import InviteQRModal from './components/InviteQRModal';
import {
  parseMediaInput,
  type Role,
  type SyncMessage,
} from './types';

export { NICKNAME_BROADCAST_DELAY_MS, scheduleNicknameBroadcast } from './nicknameBroadcast';

function useRoomIdFromUrl(): string | null {
  return useState(
    () => new URLSearchParams(window.location.search).get('room')
  )[0];
}

function extractRoomId(input: string): string | null {
  const v = input.trim();
  if (!v) return null;
  const match = v.match(/[?&]room=([^&\s]+)/);
  if (match) return decodeURIComponent(match[1]);
  return v;
}

const PANEL_VIEWS = [
  { id: 'panels', label: 'PANELS' },
  { id: 'chat', label: 'CHAT' },
];

const CHAT_VIEW_INDEX = 1;

const VIEW_SWIPE_THRESHOLD = 48;

const VIEW_SWIPE_INTERACTIVE_SELECTOR =
  'button, a, input, textarea, select, [contenteditable]';

export default function App() {
  const roomIdFromUrl = useRoomIdFromUrl();
  const [nickname, setNickname] = useState<string>(
    () => {
      try {
        const saved = localStorage.getItem('co-viewer:nickname');
        if (saved && saved.trim()) return saved;
      } catch {
      }
      return `Guest-${Math.random().toString(36).slice(2, 6)}`;
    }
  );
  // Keep the last non-empty name so clearing the input (select-all + delete)
  // cannot commit an empty display name. Blur restores this value.
  const lastValidNicknameRef = useRef(nickname);
  useEffect(() => {
    const trimmed = nickname.trim();
    if (trimmed) lastValidNicknameRef.current = trimmed;
  }, [nickname]);
  // The transport and room state always use a confirmed name, so a transient
  // empty value while editing does not blank the participant or the host's
  // "(Host)" suffix.
  const confirmedNickname = nickname.trim() || lastValidNicknameRef.current;

  useEffect(() => {
    try {
      localStorage.setItem('co-viewer:nickname', nickname);
    } catch {
    }
  }, [nickname]);
  const [joined, setJoined] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [inviteCopied, setInviteCopied] = useState(false);
  const [qrOpen, setQrOpen] = useState(false);
  const [joinInput, setJoinInput] = useState('');
  const [joinError, setJoinError] = useState<string | null>(null);
  const [joinExpanded, setJoinExpanded] = useState(() => {
    try {
      const v = localStorage.getItem('co-viewer:join-expanded');
      return v ? v === '1' : false;
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem('co-viewer:join-expanded', joinExpanded ? '1' : '0');
    } catch {}
  }, [joinExpanded]);
  const [isSyncPulse, setPulse] = useState(false);
  const prevIsPlayingRef = useRef(false);
  const prevTimeRef = useRef(0);

  // fullscreen + drawer (player only)
  const playerWrapRef = useRef<HTMLDivElement>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const touchStartX = useRef<number | null>(null);

  // panels <-> chat view navigation (< > buttons + swipe)
  const [activeView, setActiveView] = useState(() => {
    try {
      return localStorage.getItem('co-viewer:panel-view') === 'chat' ? CHAT_VIEW_INDEX : 0;
    } catch {
      return 0;
    }
  });
  const [lastSeenChatSeq, setLastSeenChatSeq] = useState(0);
  const viewSwipeStartX = useRef<number | null>(null);
  const viewSwipeStartY = useRef<number | null>(null);

  useEffect(() => {
    try {
      localStorage.setItem('co-viewer:panel-view', activeView === CHAT_VIEW_INDEX ? 'chat' : 'panels');
    } catch {}
  }, [activeView]);

  const transportKind = getTransportKind();

  // Only the sync transport currently driving roomSync may mutate room state.
  // PeerJS stays alive for voice in MQTT mode, and MQTT may still deliver
  // retained messages, so callback routing is gated by this ref.
  const selectedSyncTransportRef = useRef<TransportKind>('peerjs');
  const mqttFallbackRef = useRef(false);

  const roomSyncRef = useRef<ReturnType<typeof useRoomSync> | null>(null);
  const handlePeerMessage = useCallback((msg: SyncMessage, fromPeerId: string) => {
    if (selectedSyncTransportRef.current !== 'peerjs') return;
    roomSyncRef.current?.handleIncoming(msg, fromPeerId);
  }, []);
  const handleMqttMessage = useCallback((msg: SyncMessage, fromPeerId: string) => {
    if (selectedSyncTransportRef.current !== 'mqtt') return;
    roomSyncRef.current?.handleIncoming(msg, fromPeerId);
  }, []);

  // Initialize MQTT before PeerJS: in MQTT mode the PeerJS id is the MQTT
  // transport id, so sync, presence and voice all share one participant id.
  const mqttTransport = useMqttTransport({
    roomIdFromUrl,
    displayName: confirmedNickname,
    enabled: transportKind === 'mqtt',
    onMessage: handleMqttMessage,
    onGuestConnected: (peerId, name) => {
      if (selectedSyncTransportRef.current !== 'mqtt') return;
      roomSyncRef.current?.onGuestJoined(peerId, name);
    },
    onGuestDisconnected: (peerId) => {
      if (selectedSyncTransportRef.current !== 'mqtt') return;
      roomSyncRef.current?.onGuestLeft(peerId);
    },
    onHostDisconnected: () => {
      if (selectedSyncTransportRef.current !== 'mqtt') return;
      roomSyncRef.current?.onHostLost();
    },
    onConnected: (host) => {
      if (host) return;
      // mqtt.connect flips its connected state in the same tick as this
      // callback, so the selection ref can still point at PeerJS for the
      // current render. An enabled, non-fallback MQTT transport is the
      // selected sync path; keep the initial REQUEST_STATE intact.
      if (selectedSyncTransportRef.current !== 'mqtt') {
        if (transportKind !== 'mqtt' || mqttFallbackRef.current) return;
      }
      roomSyncRef.current?.onGuestReady();
    },
  });

  const peerTransport = usePeerHook({
    roomIdFromUrl,
    // MQTT mode keeps PeerJS only for voice. Reusing the MQTT id makes
    // roomSync.myId/vcPeers and the PeerJS call/call-receive ids identical.
    peerId: transportKind === 'mqtt' ? mqttTransport.myId ?? undefined : undefined,
    displayName: confirmedNickname,
    onMessage: handlePeerMessage,
    onGuestConnected: (peerId, name) => {
      if (selectedSyncTransportRef.current !== 'peerjs') return;
      roomSyncRef.current?.onGuestJoined(peerId, name);
    },
    onGuestDisconnected: (peerId) => {
      if (selectedSyncTransportRef.current !== 'peerjs') return;
      roomSyncRef.current?.onGuestLeft(peerId);
    },
    onHostDisconnected: () => {
      if (selectedSyncTransportRef.current !== 'peerjs') return;
      roomSyncRef.current?.onHostLost();
    },
    onConnected: (host) => {
      if (host) return;
      if (selectedSyncTransportRef.current !== 'peerjs') return;
      roomSyncRef.current?.onGuestReady();
    },
  });

  const [mqttFallback, setMqttFallback] = useState(false);
  mqttFallbackRef.current = mqttFallback;

  useEffect(() => {
    if (transportKind !== 'mqtt' || mqttFallback) return;
    if (mqttTransport.connected) return;
    const t = window.setTimeout(() => {
      if (!mqttTransport.connected) {
        console.warn('[transport] MQTT fallback to peerjs');
        setMqttFallback(true);
      }
    }, 5000);
    return () => window.clearTimeout(t);
  }, [transportKind, mqttTransport.connected, mqttFallback]);

  const transport = useMemo(() => {
    if (transportKind === 'mqtt' && !mqttFallback && mqttTransport.connected) return mqttTransport;
    return peerTransport;
  }, [transportKind, mqttFallback, mqttTransport, peerTransport]);

  selectedSyncTransportRef.current = transport === mqttTransport ? 'mqtt' : 'peerjs';

  const roomSync = useRoomSync({
    isHost: transport.isHost,
    myId: transport.myId,
    connected: transport.connected,
    myName: confirmedNickname,
    broadcast: transport.broadcast,
    sendTo: transport.sendTo,
    // MQTT (bus) delivers guest commands directly to every subscriber, so the
    // host must not re-publish them. PeerJS (star, including the MQTT fallback)
    // still needs the host relay.
    relayGuestCommands: (transport.topology ?? 'star') === 'star',
    // While the tab is hidden (or a background PAUSE is being suppressed), the
    // player may be paused locally by the browser. Do not publish that as the
    // room state: guests must keep playing until the host's resume succeeds.
    shouldEmitSyncPing: () => !bgPauseRef.current && !isDocumentHidden(),
  });
  roomSyncRef.current = roomSync;

  const nicknameBroadcastTimerRef = useRef<number | null>(null);
  const lastNicknameRef = useRef(nickname);

  useEffect(() => {
    // An empty/whitespace-only value is not a confirmed name: keep the last
    // valid one (blur restores it) and never broadcast it.
    if (!nickname.trim()) return;
    // The initial nickname is already part of JOIN/self seeding; only changes
    // made from this point on need a debounced broadcast.
    if (lastNicknameRef.current === nickname) return;
    lastNicknameRef.current = nickname;
    scheduleNicknameBroadcast(nicknameBroadcastTimerRef, nickname, (name) => {
      roomSyncRef.current?.setMyNickname(name);
    });
    return () => cancelNicknameBroadcast(nicknameBroadcastTimerRef);
  }, [nickname]);

  const chatSeq = roomSync.chatSeq;
  const unreadCount = computeUnreadChatCount(
    chatSeq,
    lastSeenChatSeq,
    activeView === CHAT_VIEW_INDEX
  );

  useEffect(() => {
    if (activeView === CHAT_VIEW_INDEX) setLastSeenChatSeq(chatSeq);
  }, [activeView, chatSeq]);

  const [viewDir, setViewDir] = useState<1 | -1>(1);

  const goPanelView = useCallback(
    (index: number) => {
      setViewDir(index >= activeView ? 1 : -1);
      setActiveView(Math.max(0, Math.min(PANEL_VIEWS.length - 1, index)));
    },
    [activeView]
  );

  const handleSendChat = useCallback(
    (text: string) => {
      roomSync.sendChat(text);
    },
    [roomSync]
  );

  const onViewTouchStart = useCallback((e: React.TouchEvent) => {
    viewSwipeStartX.current = e.touches[0].clientX;
    viewSwipeStartY.current = e.touches[0].clientY;
  }, []);

  const onViewTouchEnd = useCallback(
    (e: React.TouchEvent) => {
      const startX = viewSwipeStartX.current;
      const startY = viewSwipeStartY.current;
      viewSwipeStartX.current = null;
      viewSwipeStartY.current = null;
      if (startX === null || startY === null) return;
      const target = e.target as HTMLElement;
      if (target.closest(VIEW_SWIPE_INTERACTIVE_SELECTOR)) return;
      const dx = e.changedTouches[0].clientX - startX;
      const dy = e.changedTouches[0].clientY - startY;
      if (Math.abs(dx) <= Math.abs(dy)) return;
      if (Math.abs(dx) < VIEW_SWIPE_THRESHOLD) return;
      if (dx < 0) goPanelView(activeView + 1);
      else goPanelView(activeView - 1);
    },
    [activeView, goPanelView]
  );

  useEffect(() => {
    const prevPlaying = prevIsPlayingRef.current;
    const prevTime = prevTimeRef.current;
    if (
      roomSync.isPlaying !== prevPlaying ||
      Math.abs(roomSync.currentTime - prevTime) > 0.5
    ) {
      setPulse(true);
      window.setTimeout(() => setPulse(false), 300);
    }
    prevIsPlayingRef.current = roomSync.isPlaying;
    prevTimeRef.current = roomSync.currentTime;
  }, [roomSync.isPlaying, roomSync.currentTime]);

  // Voice mesh stays on PeerJS even when sync transport is MQTT (hybrid).
  const voiceChat = useVoiceChat({
    peer: peerTransport,
    roomSync,
    isHost: peerTransport.isHost,
    myId: peerTransport.myId,
  });

  useEffect(() => {
    if (transport.isHost) setJoined(true);
  }, [transport.isHost]);

  useEffect(() => {
    if (joined) setActiveView(0);
  }, [joined]);

  const inviteUrl = useMemo(() => {
    if (!transport.roomId) return '';
    return `${window.location.origin}${window.location.pathname}?room=${transport.roomId}`;
  }, [transport.roomId]);

  const copyInvite = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(inviteUrl);
      setInviteCopied(true);
      window.setTimeout(() => setInviteCopied(false), 2000);
    } catch {
      setInviteCopied(false);
    }
  }, [inviteUrl]);

  const handleJoinConfirm = useCallback(() => {
    if (roomSync.hasReceivedRoomState && !roomSync.isPlaying) {
      // The room is known to be paused: do not start playback just because the
      // JOIN click unlocked autoplay.
      roomSync.controllerRef.current?.pause();
    } else {
      // Unknown state (still connecting) or a playing room: use the gesture to
      // start playback, but suppress the resulting local PLAY broadcast.
      roomSync.playForGesture();
    }
    setJoined(true);
  }, [roomSync]);

  const handleLoadMedia = useCallback(
    (url: string) => {
      const parsed = parseMediaInput(url);
      if (!parsed) {
        setLoadError('URL または動画IDを確認してください');
        return;
      }
      setLoadError(null);
      roomSync.localLoadMedia(parsed.platform, parsed.videoId);
    },
    [roomSync]
  );

  const handleDelegate = useCallback(
    (peerId: string, role: Role) => {
      roomSync.delegateController(peerId, role);
    },
    [roomSync]
  );

  const handleJoinByLink = useCallback(() => {
    const id = extractRoomId(joinInput);
    if (!id) {
      setJoinError('招待URL または ルームIDを確認してください');
      return;
    }
    window.location.href = `?room=${encodeURIComponent(id)}`;
  }, [joinInput]);

  useEffect(() => {
    const onFsChange = () => {
      const fsEl = document.fullscreenElement || (document as unknown as { webkitFullscreenElement?: Element }).webkitFullscreenElement || null;
      const nowFs = !!fsEl;
      setIsFullscreen(nowFs);
      if (!nowFs) {
        setDrawerOpen(false);
        try {
          if (screen.orientation && 'unlock' in screen.orientation) (screen.orientation as unknown as { unlock: () => void }).unlock();
        } catch {}
      } else {
        const isMobile = window.matchMedia('(max-width: 768px)').matches || 'ontouchstart' in window;
        if (isMobile && screen.orientation && 'lock' in screen.orientation) {
          (screen.orientation.lock as (o: string) => Promise<void>)('landscape').catch(() => {});
        }
      }
    };
    document.addEventListener('fullscreenchange', onFsChange);
    document.addEventListener('webkitfullscreenchange', onFsChange as EventListener);
    return () => {
      document.removeEventListener('fullscreenchange', onFsChange);
      document.removeEventListener('webkitfullscreenchange', onFsChange as EventListener);
    };
  }, []);

  const toggleFullscreen = useCallback(() => {
    const el = playerWrapRef.current;
    if (!el) return;
    const fsEl = document.fullscreenElement || (document as unknown as { webkitFullscreenElement?: Element }).webkitFullscreenElement;
    if (fsEl) {
      if (document.exitFullscreen) document.exitFullscreen();
      else if ((document as unknown as { webkitExitFullscreen?: () => void }).webkitExitFullscreen) (document as unknown as { webkitExitFullscreen: () => void }).webkitExitFullscreen();
    } else {
      const anyEl = el as unknown as { requestFullscreen?: () => Promise<void>; webkitRequestFullscreen?: () => Promise<void> };
      if (anyEl.requestFullscreen) anyEl.requestFullscreen();
      else if (anyEl.webkitRequestFullscreen) anyEl.webkitRequestFullscreen();
    }
  }, []);

  // swipe to open/close drawer in fullscreen (Queue + Browser)
  const onFsTouchStart = useCallback((e: React.TouchEvent) => {
    if (!isFullscreen) return;
    touchStartX.current = e.touches[0].clientX;
  }, [isFullscreen]);
  const onFsTouchEnd = useCallback((e: React.TouchEvent) => {
    if (!isFullscreen || touchStartX.current === null) return;
    const startX = touchStartX.current;
    touchStartX.current = null;
    const endX = e.changedTouches[0].clientX;
    const diff = endX - startX;
    // from right edge swipe left to open
    if (!drawerOpen && startX > window.innerWidth - 36 && diff < -48) setDrawerOpen(true);
    else if (drawerOpen && diff > 48) setDrawerOpen(false);
  }, [isFullscreen, drawerOpen]);

  const isDocumentHidden = useCallback(() => {
    const doc = document as unknown as { hidden?: boolean; webkitHidden?: boolean; visibilityState?: string };
    return !!(doc.hidden || doc.webkitHidden || doc.visibilityState === 'hidden');
  }, []);

  const hiddenAtRef = useRef(0);
  const bgPauseRef = useRef(false);
  const gestureResumeRef = useRef<(() => void) | null>(null);
  const gestureResumeTimerRef = useRef<number | null>(null);
  const resumeRetryRef = useRef<ResumeRetryScheduler | null>(null);

  const clearGestureResume = useCallback(() => {
    const gestureResume = gestureResumeRef.current;
    if (gestureResume) {
      gestureResumeRef.current = null;
      try {
        window.removeEventListener('pointerdown', gestureResume);
        window.removeEventListener('touchend', gestureResume);
      } catch {}
    }
    if (gestureResumeTimerRef.current !== null) {
      window.clearTimeout(gestureResumeTimerRef.current);
      gestureResumeTimerRef.current = null;
    }
  }, []);

  const cancelResumeRetries = useCallback(() => {
    resumeRetryRef.current?.cancel();
    resumeRetryRef.current = null;
  }, []);

  // Once the room is paused, no pending tab-return retry may start playback.
  useEffect(() => {
    if (roomSync.isPlaying) return;
    cancelResumeRetries();
    clearGestureResume();
    bgPauseRef.current = false;
  }, [roomSync.isPlaying, cancelResumeRetries, clearGestureResume]);

  useEffect(
    () => () => {
      cancelResumeRetries();
      clearGestureResume();
    },
    [cancelResumeRetries, clearGestureResume]
  );

  const isBackgroundPause = useCallback(() => {
    if (isDocumentHidden()) return true;
    return Date.now() - hiddenAtRef.current < 2500;
  }, [isDocumentHidden]);

  const reportLocalEventWrapped = useCallback((e: import('./types').LocalPlayerEvent) => {
    if (e.kind === 'PAUSE' && isBackgroundPause()) {
      bgPauseRef.current = true;
      return;
    }
    roomSyncRef.current?.reportLocalEvent(e);
  }, [isBackgroundPause]);

  useEffect(() => {
    const tryResume = () => {
      const ctrl = roomSyncRef.current?.controllerRef.current;
      const rs = roomSyncRef.current;
      if (!ctrl || !rs) return;
      if (isDocumentHidden()) return;

      // A new visibility-return attempt supersedes any still-pending retries.
      cancelResumeRetries();
      clearGestureResume();

      if (!rs.isPlaying) {
        bgPauseRef.current = false;
        return;
      }
      if (ctrl.getIsPlaying?.()) {
        bgPauseRef.current = false;
        return;
      }

      resumeRetryRef.current = scheduleResumeRetries({
        isRoomPlaying: () => !!roomSyncRef.current?.isPlaying,
        isPlayerPlaying: () => !!roomSyncRef.current?.controllerRef.current?.getIsPlaying?.(),
        isDocumentHidden,
        play: () => {
          roomSyncRef.current?.controllerRef.current?.play();
        },
        onFinished: () => {
          resumeRetryRef.current = null;
          bgPauseRef.current = false;
        },
      });

      const gestureResume = () => {
        const c = roomSyncRef.current?.controllerRef.current;
        const r = roomSyncRef.current;
        if (!c || !r) return;
        if (!r.isPlaying) {
          clearGestureResume();
          return;
        }
        if (!c.getIsPlaying?.()) {
          try { c.play(); } catch {}
          cancelResumeRetries();
          clearGestureResume();
        }
      };
      gestureResumeRef.current = gestureResume;
      window.addEventListener('pointerdown', gestureResume, { once: true });
      window.addEventListener('touchend', gestureResume, { once: true });
      gestureResumeTimerRef.current = window.setTimeout(() => {
        if (gestureResumeRef.current === gestureResume) {
          clearGestureResume();
        }
      }, 10000);
    };
    const setupMediaSession = () => {
      const ctrl = roomSyncRef.current?.controllerRef.current;
      const rs = roomSyncRef.current;
      if (!ctrl || !rs) return;
      const cur = rs.queue.find((q) => q.id === rs.currentId);
      const title = cur ? (rs.titles[cur.id] ?? cur.videoId) : 'Co-Viewer';
      try {
        if ('mediaSession' in navigator && typeof (window as unknown as { MediaMetadata?: unknown }).MediaMetadata !== 'undefined') {
          const md = new (window as unknown as { MediaMetadata: new (o: Record<string, string>) => unknown }).MediaMetadata({
            title,
            artist: 'Co-Viewer — P2P 同時視聴',
            album: cur ? `${cur.platform} · ${cur.videoId}` : 'P2P SYNC',
          });
          (navigator as unknown as { mediaSession: { metadata: unknown } }).mediaSession.metadata = md;
          const ms = (navigator as unknown as { mediaSession: { setActionHandler: (a: string, h: (() => void) | null) => void } }).mediaSession;
          ms.setActionHandler('play', () => {
            bgPauseRef.current = false;
            try { ctrl.play(); } catch {}
          });
          ms.setActionHandler('pause', () => {
            if (isDocumentHidden() || Date.now() - hiddenAtRef.current < 2500) return;
            try { ctrl.pause(); } catch {}
          });
          ms.setActionHandler('stop', () => {
            if (isDocumentHidden() || Date.now() - hiddenAtRef.current < 2500) return;
            try { ctrl.pause(); } catch {}
          });
          ms.setActionHandler('seekto', null);
        }
      } catch {}
    };
    const markHidden = () => {
      hiddenAtRef.current = Date.now();
      const rs = roomSyncRef.current;
      const ctrl = roomSyncRef.current?.controllerRef.current;
      if (rs?.isPlaying || ctrl?.getIsPlaying?.()) bgPauseRef.current = true;
      setupMediaSession();
    };
    const markVisible = () => {
      try {
        if ('mediaSession' in navigator) {
          const ms = (navigator as unknown as { mediaSession: { setActionHandler: (a: string, h: null) => void } }).mediaSession;
          ms.setActionHandler('play', null);
          ms.setActionHandler('pause', null);
          ms.setActionHandler('stop', null);
        }
      } catch {}
      tryResume();
    };
    const onVisibility = () => {
      if (isDocumentHidden()) markHidden();
      else {
        window.setTimeout(markVisible, 120);
        window.setTimeout(tryResume, 600);
      }
    };
    const onPageHide = () => {
      markHidden();
    };
    const onPageShow = () => {
      window.setTimeout(markVisible, 80);
      window.setTimeout(tryResume, 400);
      window.setTimeout(tryResume, 1200);
    };
    const onFocus = () => {
      window.setTimeout(tryResume, 80);
      window.setTimeout(tryResume, 600);
    };
    document.addEventListener('visibilitychange', onVisibility);
    document.addEventListener('webkitvisibilitychange' as unknown as string, onVisibility as EventListener);
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('pageshow', onPageShow);
    window.addEventListener('blur', onPageHide);
    window.addEventListener('focus', onFocus);
    document.addEventListener('freeze' as unknown as string, onPageHide as EventListener);
    document.addEventListener('resume' as unknown as string, onPageShow as EventListener);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      document.removeEventListener('webkitvisibilitychange' as unknown as string, onVisibility as EventListener);
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener('pageshow', onPageShow);
      window.removeEventListener('blur', onPageHide);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('freeze' as unknown as string, onPageHide as EventListener);
      document.removeEventListener('resume' as unknown as string, onPageShow as EventListener);
      cancelResumeRetries();
      clearGestureResume();
    };
  }, [isDocumentHidden, cancelResumeRetries, clearGestureResume]);

  return (
    <div className={activeView === CHAT_VIEW_INDEX ? 'flex h-dvh flex-col' : 'min-h-screen'}>
      {/* ── Player is the only fullscreen element ── */}
      <div
        ref={playerWrapRef}
        className={isFullscreen ? 'bg-black' : 'sticky top-0 z-40'}
        onTouchStart={onFsTouchStart}
        onTouchEnd={onFsTouchEnd}
      >
        <div className={isFullscreen ? 'flex h-full w-full items-center justify-center bg-black overflow-hidden' : 'mx-auto max-w-[1280px]'}>
          <div className={isFullscreen ? 'flex h-full w-full items-center justify-center bg-black overflow-hidden' : 'shadow-[0_8px_24px_rgba(0,0,0,0.55)]'}>
            <div className={isFullscreen ? 'flex h-full w-full items-center justify-center bg-black [&_iframe]:h-full [&_iframe]:w-full' : ''}>
            <Player
              platform={roomSync.currentMedia?.platform ?? null}
              videoId={roomSync.currentMedia?.videoId ?? null}
              canControl={roomSync.canControl}
              isHost={transport.isHost}
              controllerRef={roomSync.controllerRef}
              isRemoteSyncingRef={roomSync.isRemoteSyncingRef}
              reportLocalEvent={reportLocalEventWrapped}
              onControllerReady={roomSync.onControllerReady}
              driveMode={roomSync.driveMode}
              audioOnly={roomSync.driveAudioOnly}
              titles={roomSync.titles}
              queue={roomSync.queue}
              currentId={roomSync.currentId}
              onToggleFullscreen={toggleFullscreen}
              isFullscreen={isFullscreen}
              syncFallbackLevel={roomSync.syncFallbackLevel}
              syncResyncing={roomSync.syncResyncing}
              syncToleranceLag={roomSync.syncToleranceLag}
              onResync={roomSync.resyncNow}
            />
            </div>
          </div>
          {!isFullscreen && <div className="nothing-glyph mx-auto max-w-[1280px]" aria-hidden />}
        </div>

        {/* ── fullscreen drawer: Queue + Browser only, swipe from right ── */}
        {isFullscreen && (
          <>
            {/* edge handle */}
            <button
              type="button"
              onClick={() => setDrawerOpen((v) => !v)}
              className="absolute right-0 top-1/2 z-30 -translate-y-1/2 border-y border-l border-[var(--nothing-border)] bg-black/80 px-1.5 py-6 text-[10px] tracking-widest text-white backdrop-blur hover:bg-black/90"
              aria-label={drawerOpen ? 'メニューを閉じる' : 'メニューを開く'}
            >
              <span className="block [writing-mode:vertical-rl]">{drawerOpen ? '›' : '‹'}</span>
              <span className="mt-1 block [writing-mode:vertical-rl] text-[8px] opacity-70">MENU</span>
            </button>

            {/* backdrop */}
            {drawerOpen && (
              <button
                type="button"
                aria-label="ドロワーを閉じる"
                onClick={() => setDrawerOpen(false)}
                className="absolute inset-0 z-20 bg-black/45 backdrop-blur-[1px]"
              />
            )}

            {/* drawer panel */}
            <div
              className={`absolute right-0 top-0 z-30 flex h-full w-[86vw] max-w-[380px] flex-col gap-3 overflow-hidden border-l border-[var(--nothing-border)] bg-[var(--nothing-bg)]/95 p-3 backdrop-blur transition-transform duration-300 ease-out ${drawerOpen ? 'translate-x-0' : 'translate-x-full'}`}
              onTouchStart={onFsTouchStart}
              onTouchEnd={onFsTouchEnd}
            >
              <div className="flex items-center justify-between">
                <span className="nothing-label">FULLSCREEN · MENU</span>
                <button
                  type="button"
                  onClick={() => setDrawerOpen(false)}
                  className="nothing-mono border border-[var(--nothing-border)] bg-black px-2 py-0.5 text-[11px] tracking-widest text-[var(--nothing-text)] hover:bg-[var(--nothing-surface-raised)]"
                >
                  ✕ CLOSE
                </button>
              </div>
              <div className="nothing-glyph opacity-40" aria-hidden />
              <div className="flex-1 space-y-3 overflow-y-auto pr-1">
                <QueuePanel
                  queue={roomSync.queue}
                  currentId={roomSync.currentId}
                  canControl={roomSync.canQueue}
                  titles={roomSync.titles}
                  onPlay={roomSync.goToItem}
                  onNext={roomSync.goNext}
                  onPrev={roomSync.goPrevious}
                  onRemove={roomSync.removeFromQueue}
                  onMove={roomSync.moveInQueue}
                />
                <BrowserPanel onAddToQueue={handleLoadMedia} canQueue={roomSync.canQueue} />
                <ChatPanel
                  messages={roomSync.chat}
                  myId={transport.myId}
                  onSend={handleSendChat}
                />
              </div>
              <div className="border-t border-[var(--nothing-border)] pt-2">
                <button
                  type="button"
                  onClick={toggleFullscreen}
                  className="nothing-mono w-full border border-[var(--nothing-border)] bg-black py-1.5 text-xs tracking-widest text-[var(--nothing-text-dim)] hover:text-[var(--nothing-text)]"
                >
                  ⛶ EXIT FULLSCREEN
                </button>
              </div>
            </div>
          </>
        )}
      </div>

      <div
        className={`nothing-glyph mx-auto max-w-[1280px] ${isSyncPulse ? 'opacity-100' : 'opacity-40'}${activeView === CHAT_VIEW_INDEX ? ' hidden' : ''}`}
        aria-hidden
        style={
          isSyncPulse
            ? { boxShadow: '0 0 10px var(--nothing-red-glow), 0 0 22px var(--nothing-red-glow)' }
            : undefined
        }
      />

      <div className={activeView === CHAT_VIEW_INDEX ? 'mx-auto flex min-h-0 w-full max-w-[1280px] flex-1 flex-col' : 'mx-auto max-w-[1280px] p-3 lg:p-4 pb-10'}>
        {/* ── CO-VIEWER header panel (slimmed) — contains JOIN when needed ── */}
        <header className={`nothing-panel mb-3 flex flex-col gap-2 px-2.5 py-2 lg:px-3${activeView === CHAT_VIEW_INDEX ? ' hidden' : ''}`}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2.5">
              <div className="relative flex h-8 w-8 items-center justify-center border border-[var(--nothing-border)] bg-black overflow-hidden" aria-hidden>
                {/* dot-matrix glyph: 3x3 dots forming Nothing-like transparent motif */}
                <div className="grid grid-cols-3 gap-[2px]">
                  <span className="h-1 w-1 bg-[var(--nothing-text)]" />
                  <span className="h-1 w-1 bg-[var(--nothing-text)]" />
                  <span className="h-1 w-1 bg-[var(--nothing-text)] opacity-30" />
                  <span className="h-1 w-1 bg-[var(--nothing-text)]" />
                  <span className="h-1 w-1 bg-[var(--nothing-red)] shadow-[0_0_4px_var(--nothing-red-glow)]" />
                  <span className="h-1 w-1 bg-[var(--nothing-text)] opacity-50" />
                  <span className="h-1 w-1 bg-[var(--nothing-text)] opacity-30" />
                  <span className="h-1 w-1 bg-[var(--nothing-text)] opacity-50" />
                  <span className="h-1 w-1 bg-[var(--nothing-text)]" />
                </div>
                {/* corner registration mark */}
                <span className="absolute right-0 top-0 h-[4px] w-[4px] bg-[var(--nothing-red)]" />
                <span className="absolute bottom-0 left-0 h-px w-2 bg-[var(--nothing-border)]" />
              </div>
              <div>
                <h1 className="nothing-title text-[18px] font-normal tracking-[0.22em] text-[var(--nothing-text)] leading-none">CO-VIEWER<span className="align-super text-[10px] text-[var(--nothing-red)]">●</span></h1>
                <p className="nothing-mono mt-0.5 text-[8px] tracking-[0.18em] text-[var(--nothing-text-dim)]">NOTHING INSPIRED · P2P SYNC</p>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-1.5">
              <span className="nothing-mono inline-flex items-center gap-1.5 border border-[var(--nothing-border)] bg-[var(--nothing-surface-raised)] px-2 py-0.5 text-[10px] tracking-widest">
                <span className={`h-1 w-1 ${transport.connected ? 'bg-[var(--nothing-red)] shadow-[0_0_6px_var(--nothing-red-glow)]' : 'bg-amber-500 animate-pulse'}`} />
                <span className={transport.connected ? 'text-[var(--nothing-text)]' : 'text-amber-300'}>
                  {transport.connected ? (transport.isHost ? 'HOST' : 'GUEST') : '…'}
                </span>
              </span>

              {transport.isHost && inviteUrl && (
                <>
                  <button
                    onClick={copyInvite}
                    className="nothing-mono inline-flex items-center gap-2 border bg-[var(--nothing-red)] px-2.5 py-1 text-[10px] font-medium tracking-widest text-white transition hover:bg-[var(--nothing-red-hover)] active:scale-[0.98] border-transparent"
                  >
                    {inviteCopied ? 'COPIED' : 'INVITE'}
                  </button>
                  <button
                    type="button"
                    onClick={() => setQrOpen(true)}
                    aria-label="招待QRコードを表示"
                    className="nothing-mono inline-flex items-center justify-center border border-[var(--nothing-border)] bg-black px-2.5 py-1 text-[10px] font-medium tracking-widest text-[var(--nothing-text)] hover:bg-[var(--nothing-surface-raised)] hover:border-[var(--nothing-border-strong)] active:scale-[0.98]"
                    title="QRコードを表示"
                  >
                    <span className="inline-flex items-center gap-1">
                      <span aria-hidden className="text-[12px] leading-none">◧</span> QR
                    </span>
                  </button>
                </>
              )}
            </div>
          </div>

          {/* nickname row */}
          <div className="flex items-center gap-2 border-t border-[var(--nothing-border)] pt-2">
            <label htmlFor="nickname-input" className="nothing-label shrink-0">
              NICKNAME
            </label>
            <input
              id="nickname-input"
              value={nickname}
              maxLength={24}
              onChange={(e) => {
                setNickname(e.target.value);
              }}
              onBlur={() => {
                if (!nickname.trim()) {
                  cancelNicknameBroadcast(nicknameBroadcastTimerRef);
                  setNickname(lastValidNicknameRef.current);
                  return;
                }
                flushNicknameBroadcast(
                  nicknameBroadcastTimerRef,
                  nickname,
                  (name) => roomSyncRef.current?.setMyNickname(name)
                );
              }}
              placeholder="DISPLAY NAME"
              className="nothing-mono min-w-0 flex-1 border border-[var(--nothing-border)] bg-black px-2.5 py-1 text-sm text-[var(--nothing-text)] placeholder:text-[var(--nothing-text-faint)] outline-none focus:border-[var(--nothing-red)]"
            />
            {transport.roomId && (
              <span className="nothing-mono hidden sm:inline text-[10px] tracking-widest text-[var(--nothing-text-dim)]">
                ROOM <span className="text-[var(--nothing-text-muted)]">{transport.roomId.slice(0, 8)}</span>
              </span>
            )}
          </div>

          {/* JOIN integrated into header panel - collapsed by default */}
          {!roomIdFromUrl && (
            <div className="border-t border-[var(--nothing-border)] pt-2">
              <button
                type="button"
                onClick={() => setJoinExpanded((v) => !v)}
                className="flex w-full items-center justify-between gap-2 text-left"
              >
                <div className="flex items-center gap-2">
                  <span className="nothing-label">ROOM · JOIN</span>
                  {!joinExpanded && (
                    <span className="nothing-mono text-[10px] tracking-widest text-[var(--nothing-text-faint)]">TAP TO EXPAND</span>
                  )}
                </div>
                <span className="nothing-mono shrink-0 border border-[var(--nothing-border)] bg-black px-2 py-0.5 text-[11px] tracking-widest text-[var(--nothing-text-dim)]">
                  {joinExpanded ? '—' : '+'}
                </span>
              </button>
              <div className="nothing-glyph my-2 opacity-30" aria-hidden />
              {!joinExpanded && (
                <p className="nothing-mono text-[10px] tracking-widest text-[var(--nothing-text-faint)]">TAP TO EXPAND · JOIN BY LINK</p>
              )}
              {joinExpanded && (
                <div className="space-y-2">
                  <input
                    value={joinInput}
                    onChange={(e) => setJoinInput(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleJoinByLink()}
                    placeholder="招待URL または ルームID"
                    className="nothing-mono w-full border border-[var(--nothing-border)] bg-black px-2.5 py-1.5 text-sm text-[var(--nothing-text)] placeholder:text-[var(--nothing-text-faint)] outline-none focus:border-[var(--nothing-red)]"
                  />
                  <div className="flex flex-wrap gap-1.5">
                    <button
                      type="button"
                      onClick={handleJoinByLink}
                      className="nothing-mono shrink-0 bg-[var(--nothing-red)] px-3 py-1 text-xs font-medium tracking-widest text-white hover:bg-[var(--nothing-red-hover)] active:scale-[0.98]"
                    >
                      参加
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setJoinInput('');
                        setJoinError(null);
                      }}
                      className="nothing-mono shrink-0 border border-[var(--nothing-border)] bg-[var(--nothing-surface-raised)] px-3 py-1 text-xs tracking-widest text-[var(--nothing-text-muted)] hover:bg-[var(--nothing-surface-hover)]"
                    >
                      キャンセル
                    </button>
                  </div>
                  {joinError && <p className="nothing-mono text-xs text-[var(--nothing-red)]">{joinError}</p>}
                </div>
              )}
            </div>
          )}
        </header>

        <button
          type="button"
          onClick={() => goPanelView(activeView - 1)}
          disabled={activeView <= 0}
          aria-label="前の画面"
          className="nothing-mono fixed left-2 top-1/2 z-50 -translate-y-1/2 border border-[var(--nothing-border)] bg-black/85 px-3 py-4 text-sm tracking-widest text-[var(--nothing-text)] backdrop-blur hover:bg-black disabled:cursor-not-allowed disabled:opacity-30"
          style={{ borderRadius: 2 }}
        >
          &lt;
          {activeView === CHAT_VIEW_INDEX && unreadCount > 0 && (
            <span
              className="nothing-mono absolute -top-2.5 left-1/2 inline-flex min-w-[18px] -translate-x-1/2 items-center justify-center bg-[var(--nothing-red)] px-1 text-[10px] font-bold text-white animate-pulse"
              style={{ borderRadius: 2 }}
            >
              {unreadCount > 9 ? '9+' : unreadCount}
            </span>
          )}
        </button>
        <button
          type="button"
          onClick={() => goPanelView(activeView + 1)}
          disabled={activeView >= PANEL_VIEWS.length - 1}
          aria-label="次の画面"
          className="nothing-mono fixed right-2 top-1/2 z-50 -translate-y-1/2 border border-[var(--nothing-border)] bg-black/85 px-3 py-4 text-sm tracking-widest text-[var(--nothing-text)] backdrop-blur hover:bg-black disabled:cursor-not-allowed disabled:opacity-30"
          style={{ borderRadius: 2 }}
        >
          &gt;
          {activeView !== CHAT_VIEW_INDEX && unreadCount > 0 && (
            <span
              className="nothing-mono absolute -top-2.5 left-1/2 inline-flex min-w-[18px] -translate-x-1/2 items-center justify-center bg-[var(--nothing-red)] px-1 text-[10px] font-bold text-white animate-pulse"
              style={{ borderRadius: 2 }}
            >
              {unreadCount > 9 ? '9+' : unreadCount}
            </span>
          )}
        </button>

        <div
          key={activeView}
          className={`${viewDir === 1 ? 'view-enter-from-right' : 'view-enter-from-left'}${activeView === CHAT_VIEW_INDEX ? ' flex min-h-0 flex-1 flex-col' : ''}`}
          onTouchStart={onViewTouchStart}
          onTouchEnd={onViewTouchEnd}
        >
          {activeView === CHAT_VIEW_INDEX ? (
            <ChatPanel
              messages={roomSync.chat}
              myId={transport.myId}
              onSend={handleSendChat}
              fillViewport
            />
          ) : (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-12">
          <div className="lg:col-span-12">
            <QueuePanel
              queue={roomSync.queue}
              currentId={roomSync.currentId}
              canControl={roomSync.canQueue}
              titles={roomSync.titles}
              onPlay={roomSync.goToItem}
              onNext={roomSync.goNext}
              onPrev={roomSync.goPrevious}
              onRemove={roomSync.removeFromQueue}
              onMove={roomSync.moveInQueue}
            />
          </div>

          {loadError && (
            <div className="lg:col-span-12">
              <p className="nothing-mono border border-[var(--nothing-red)]/30 bg-[var(--nothing-red-dim)] px-3 py-2 text-xs text-[var(--nothing-red)]">
                ⚠ {loadError}
              </p>
            </div>
          )}

          {/* browser above peers/voice (full width) */}
          {!isFullscreen && (
            <div className="lg:col-span-12">
              <BrowserPanel onAddToQueue={handleLoadMedia} canQueue={roomSync.canQueue} />
            </div>
          )}

          <div className="grid grid-cols-2 gap-3 lg:col-span-12 lg:grid-cols-2">
            <ParticipantList
              participants={roomSync.participants}
              myId={transport.myId}
              isHost={transport.isHost}
              onDelegate={handleDelegate}
              vcActive={roomSync.vcActive}
              audioLevels={voiceChat.audioLevels}
              localLevel={voiceChat.localLevel}
            />
            <VoiceChatPanel
              isHost={transport.isHost}
              vcActive={roomSync.vcActive}
              participants={roomSync.participants}
              {...voiceChat}
            />
          </div>

          <div className="lg:col-span-12">
            <VolumeMixerPanel
              controllerRef={roomSync.controllerRef}
              voiceChat={voiceChat}
              participants={roomSync.participants}
              currentPlatform={roomSync.currentMedia?.platform ?? null}
              currentId={roomSync.currentId}
            />
          </div>

          {/* drive mode at bottom */}
          <div className="lg:col-span-12">
            <DriveModePanel
              isHost={transport.isHost}
              driveMode={roomSync.driveMode}
              audioOnly={roomSync.driveAudioOnly}
              onToggleDrive={roomSync.setDriveMode}
              onToggleAudioOnly={roomSync.setDriveAudioOnly}
            />
          </div>
        </div>
          )}
        </div>

        <footer className={`mt-6 items-center justify-between border-t border-[var(--nothing-border)] pt-3${activeView === CHAT_VIEW_INDEX ? ' hidden' : ' flex'}`}>
          <span className="nothing-label">© CO-VIEWER · P2P SYNC</span>
          <span className="nothing-mono text-[10px] tracking-widest text-[var(--nothing-text-dim)]">
            NOTHING INSPIRED
          </span>
        </footer>

        <JoinModal
          open={!transport.isHost && !joined}
          roomId={transport.roomId}
          onConfirm={handleJoinConfirm}
        />
        <InviteQRModal
          open={qrOpen}
          inviteUrl={inviteUrl}
          copied={inviteCopied}
          onClose={() => setQrOpen(false)}
          onCopy={copyInvite}
        />
      </div>
    </div>
  );
}
