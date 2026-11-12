import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';
import {
  SYNC_DRIFT_THRESHOLD,
  SYNC_PING_INTERVAL,
  type ChatMessage,
  type LocalPlayerEvent,
  type Participant,
  type Platform,
  type PlayerController,
  type QueueItem,
  type Role,
  type SyncMessage,
} from '../types';
import { fetchTitle } from '../titleFetcher';
import {
  DriftGuard,
  effectiveDriftThreshold,
  predictRemoteTime,
  type RemoteClock,
} from '../sync/driftGuard';

export interface UseRoomSyncOptions {
  isHost: boolean;
  myId: string | null;
  connected: boolean;
  myName: string;
  broadcast: (msg: SyncMessage) => void;
  sendTo: (peerId: string, msg: SyncMessage) => void;
}

export interface UseRoomSyncResult {
  controllerRef: MutableRefObject<PlayerController | null>;
  isRemoteSyncingRef: MutableRefObject<boolean>;
  participants: Participant[];
  myRole: Role;
  canControl: boolean;
  canQueue: boolean;
  driveMode: boolean;
  driveAudioOnly: boolean;
  currentMedia: { platform: Platform; videoId: string } | null;
  queue: QueueItem[];
  currentId: string | null;
  isPlaying: boolean;
  /**
   * True once a STATE_SNAPSHOT or SYNC_PING has been applied. Before that the
   * room state is unknown, so JOIN may still use its user gesture to start
   * playback in order to satisfy the browser autoplay policy.
   */
  hasReceivedRoomState: boolean;
  /** Play as part of a user gesture without re-broadcasting a PLAY command. */
  playForGesture: () => void;
  currentTime: number;
  /**
   * 0 = automatic drift correction is running normally. 1..n = fallback hold
   * is active (automatic corrections paused to keep the video playing on a
   * device that cannot seek quickly); a manual `resyncNow()` clears it.
   */
  syncFallbackLevel: number;
  /** True while a manual resync is waiting for a playable ping to confirm/redo. */
  syncResyncing: boolean;
  /**
   * >0 when playback is continuing with a tolerated (adaptive) lag of this many
   * seconds, e.g. 8.0 on a device that needs 8s to recover from a seek. 0 when
   * sync is within the base tolerance. Lets the UI surface the trade-off and
   * offer a manual resync.
   */
  syncToleranceLag: number;
  /** Manually align to the host's latest known position and leave fallback. */
  resyncNow: () => void;
  handleIncoming: (msg: SyncMessage, fromPeerId: string) => void;
  reportLocalEvent: (e: LocalPlayerEvent) => void;
  localSeek: (seconds: number) => void;
  localLoadMedia: (platform: Platform, videoId: string) => void;
  titles: Record<string, string>;
  goToItem: (id: string) => void;
  goNext: () => void;
  goPrevious: () => void;
  removeFromQueue: (id: string) => void;
  moveInQueue: (fromIndex: number, toIndex: number) => void;
  delegateController: (peerId: string, role: Role) => void;
  setMyNickname: (name: string) => void;
  onGuestJoined: (peerId: string, name: string) => void;
  onGuestLeft: (peerId: string) => void;
  onHostLost: () => void;
  onGuestReady: () => void;
  /**
   * Called by Player once its platform player is ready. Applies a snapshot that
   * arrived before the controller existed (e.g. immediately after JOIN).
   */
  onControllerReady: () => void;
  vcActive: boolean;
  vcPeers: Set<string>;
  setVcActive: (active: boolean) => void;
  broadcastVcPeer: (inVc: boolean) => void;
  setDriveMode: (enabled: boolean) => void;
  setDriveAudioOnly: (audioOnly: boolean) => void;
  chat: ChatMessage[];
  /** Monotonically increasing sequence of appended chat messages (trimming never decreases it). */
  chatSeq: number;
  sendChat: (text: string) => void;
}

/**
 * Aggregates all room sync state and enforces loop prevention. A single
 * `isRemoteSyncingRef` flag is raised while a remote command is applied so the
 * platform hook's change listener cannot re-broadcast the same command.
 */
function dedupeParticipants(list: Participant[]): Participant[] {
  const seen = new Set<string>();
  const out: Participant[] = [];
  for (const p of list) {
    if (seen.has(p.peerId)) continue;
    seen.add(p.peerId);
    out.push(p);
  }
  return out;
}

export function normalizeName(s: string): string {
  return s.trim().toLowerCase();
}

export function useRoomSync(opts: UseRoomSyncOptions): UseRoomSyncResult {
  const { isHost, myId, connected, myName, broadcast, sendTo } = opts;

  const controllerRef = useRef<PlayerController | null>(null);
  /**
   * STATE_SNAPSHOT that could not be applied because the player controller was
   * not mounted yet. It is consumed exactly once by `onControllerReady`.
   */
  const pendingSnapshotRef = useRef<{
    videoId: string;
    currentTime: number;
    isPlaying: boolean;
  } | null>(null);
  const isRemoteSyncingRef = useRef(false);
  const myNameRef = useRef(myName);
  myNameRef.current = myName;

  // Low-performance guest fallback (see src/sync/driftGuard.ts).
  const driftGuardRef = useRef<DriftGuard | null>(null);
  if (!driftGuardRef.current) driftGuardRef.current = new DriftGuard();
  /** Last authoritative host timestamp, used to predict the host position. */
  const remoteClockRef = useRef<RemoteClock | null>(null);
  /**
   * Previous host ping (time + host send timestamp). A discontinuity between
   * pings means the host deliberately moved the playback position (or stalled),
   * which must be followed even while the low-performance fallback is holding
   * automatic corrections.
   */
  const lastHostPingRef = useRef<{
    time: number;
    isPlaying: boolean;
    sentAt: number | null;
    receivedAt: number;
  } | null>(null);
  /** A detected host seek that could not be followed yet (e.g. still buffering). */
  const pendingHostSeekRef = useRef(false);
  /**
   * After a manual resync, check the next playable ping against the base
   * tolerance once: the seek itself may have buffered for a while, leaving the
   * guest behind again. If that one correction fails, the normal fallback
   * takes over instead of silently accepting the residual lag.
   */
  const resyncBoostRef = useRef(false);
  const [syncFallbackLevel, setSyncFallbackLevel] = useState(0);
  const [syncResyncing, setSyncResyncing] = useState(false);
  const [syncToleranceLag, setSyncToleranceLag] = useState(0);
  const syncFallbackTimerRef = useRef<number | null>(null);
  const resyncTimerRef = useRef<number | null>(null);

  const [participants, setParticipants] = useState<Participant[]>([]);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [hasReceivedRoomState, setHasReceivedRoomState] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [titles, setTitles] = useState<Record<string, string>>({});
  const [vcActive, setVcActiveState] = useState(false);
  const [vcPeers, setVcPeers] = useState<Set<string>>(new Set());
  const [driveMode, setDriveModeState] = useState(false);
  const [driveAudioOnly, setDriveAudioOnlyState] = useState(false);
  const [chatState, setChatState] = useState<{ messages: ChatMessage[]; total: number }>({
    messages: [],
    total: 0,
  });
  const chat = chatState.messages;
  const chatSeq = chatState.total;

  const titleFailedRef = useRef<Set<string>>(new Set());
  const titleRetryRef = useRef<Map<string, number>>(new Map());
  /** Queue item ids that currently have a title request in flight. */
  const titleInFlightRef = useRef<Set<string>>(new Set());
  /** Per-item request token, so a stale result (removed/re-added item) is ignored. */
  const titleRequestTokenRef = useRef<Map<string, number>>(new Map());
  /** Pending retry timers, keyed by queue item id. */
  const titleRetryTimersRef = useRef<Map<string, number>>(new Map());
  /** False only after unmount; a ref update must not cancel in-flight results. */
  const titleMountedRef = useRef(true);
  const [titleRetryTick, setTitleRetryTick] = useState(0);
  const controllerMemoryRef = useRef<Set<string>>(new Set());
  /**
   * Roles of non-host participants before drive mode promoted them to
   * Controller. Restored when drive mode ends; peers that joined during drive
   * mode have no entry and fall back to Viewer.
   */
  const driveModeRoleBackupRef = useRef<Map<string, Role>>(new Map());

  const participantsRef = useRef<Participant[]>([]);
  const queueRef = useRef<QueueItem[]>([]);
  const currentIdRef = useRef<string | null>(null);
  const currentMediaRef = useRef<{ platform: Platform; videoId: string } | null>(
    null
  );
  const isPlayingRef = useRef(false);
  const hasReceivedRoomStateRef = useRef(false);
  const currentTimeRef = useRef(0);
  const endAdvanceRef = useRef<string | null>(null);
  const goNextRef = useRef<() => void>(() => {});
  const driveModeRef = useRef(false);
  const driveAudioOnlyRef = useRef(false);
  const chatRef = useRef<ChatMessage[]>([]);

  // The currently-playing video is derived from the queue + pointer.
  const currentMedia = useMemo<{ platform: Platform; videoId: string } | null>(
    () => {
      if (!currentId) return null;
      const it = queue.find((q) => q.id === currentId);
      return it ? { platform: it.platform, videoId: it.videoId } : null;
    },
    [queue, currentId]
  );

  // Keep refs in sync for use inside stable callbacks.
  useEffect(() => {
    participantsRef.current = participants;
  }, [participants]);
  useEffect(() => {
    queueRef.current = queue;
  }, [queue]);
  useEffect(() => {
    currentIdRef.current = currentId;
    endAdvanceRef.current = null;
  }, [currentId]);
  useEffect(() => {
    currentMediaRef.current = currentMedia;
  }, [currentMedia]);
  useEffect(() => {
    isPlayingRef.current = isPlaying;
  }, [isPlaying]);
  useEffect(() => {
    currentTimeRef.current = currentTime;
  }, [currentTime]);
  useEffect(() => {
    driveModeRef.current = driveMode;
  }, [driveMode]);
  useEffect(() => {
    driveAudioOnlyRef.current = driveAudioOnly;
  }, [driveAudioOnly]);
  useEffect(() => {
    chatRef.current = chat;
  }, [chat]);

  // Seed self into the participant list once our id is known.
  useEffect(() => {
    if (!myId) return;
    setParticipants((prev) => {
      const deduped = dedupeParticipants(prev);
      if (deduped.some((p) => p.peerId === myId)) {
        return deduped.map((p) =>
          p.peerId === myId
            ? { ...p, name: isHost ? `${myName} (Host)` : myName, isHost, role: isHost ? ('Host' as Role) : p.role }
            : p
        );
      }
      const self: Participant = { peerId: myId, name: isHost ? `${myName} (Host)` : myName, isHost, role: isHost ? 'Host' : 'Viewer' };
      return dedupeParticipants([self, ...deduped.filter((p) => p.peerId !== myId)]);
    });
  }, [myId, isHost, myName]);

  useEffect(() => {
    titleMountedRef.current = true;
    return () => {
      titleMountedRef.current = false;
      for (const timer of titleRetryTimersRef.current.values()) {
        window.clearTimeout(timer);
      }
      titleRetryTimersRef.current.clear();
    };
  }, []);

  useEffect(() => {
    const queueIds = new Set(queue.map((q) => q.id));
    // Forget bookkeeping for items that are no longer in the queue. Bumping
    // the request token invalidates any result that is still on its way.
    for (const id of Array.from(titleInFlightRef.current)) {
      if (queueIds.has(id)) continue;
      titleInFlightRef.current.delete(id);
      titleRequestTokenRef.current.set(
        id,
        (titleRequestTokenRef.current.get(id) ?? 0) + 1
      );
    }
    for (const id of Array.from(titleRetryRef.current.keys())) {
      if (!queueIds.has(id)) titleRetryRef.current.delete(id);
    }
    for (const id of Array.from(titleFailedRef.current)) {
      if (!queueIds.has(id)) titleFailedRef.current.delete(id);
    }
    for (const [id, timer] of Array.from(titleRetryTimersRef.current.entries())) {
      if (queueIds.has(id)) continue;
      window.clearTimeout(timer);
      titleRetryTimersRef.current.delete(id);
    }

    const missing = queue.filter(
      (q) =>
        !titles[q.id] &&
        !titleFailedRef.current.has(q.id) &&
        !titleInFlightRef.current.has(q.id) &&
        !titleRetryTimersRef.current.has(q.id)
    );
    if (missing.length === 0) return;
    missing.forEach((item) => {
      const retry = titleRetryRef.current.get(item.id) ?? 0;
      if (retry >= 3) {
        titleFailedRef.current.add(item.id);
        return;
      }
      titleInFlightRef.current.add(item.id);
      const token = (titleRequestTokenRef.current.get(item.id) ?? 0) + 1;
      titleRequestTokenRef.current.set(item.id, token);
      void (async () => {
        let title: string | null = null;
        try {
          title = await fetchTitle(item.platform, item.videoId);
        } catch {
          title = null;
        }
        // Results are only discarded on unmount (or when the item was removed
        // and a newer request for the same id has taken over).
        if (!titleMountedRef.current) return;
        if (titleRequestTokenRef.current.get(item.id) !== token) return;
        titleInFlightRef.current.delete(item.id);
        if (title) {
          titleRetryRef.current.delete(item.id);
          titleFailedRef.current.delete(item.id);
          const pending = titleRetryTimersRef.current.get(item.id);
          if (pending != null) {
            window.clearTimeout(pending);
            titleRetryTimersRef.current.delete(item.id);
          }
          setTitles((prev) =>
            prev[item.id] === title ? prev : { ...prev, [item.id]: title }
          );
          return;
        }
        const next = retry + 1;
        titleRetryRef.current.set(item.id, next);
        if (next >= 3) {
          titleFailedRef.current.add(item.id);
          return;
        }
        const pending = titleRetryTimersRef.current.get(item.id);
        if (pending != null) window.clearTimeout(pending);
        const timer = window.setTimeout(() => {
          titleRetryTimersRef.current.delete(item.id);
          if (!titleMountedRef.current) return;
          // Re-run the effect without resetting the retry count.
          setTitleRetryTick((n) => n + 1);
        }, 3000 * next);
        titleRetryTimersRef.current.set(item.id, timer);
      })();
    });
  }, [queue, titles, titleRetryTick]);

  /**
   * Update the playing state and its ref together. Queue switching/removal can
   * be followed immediately by a JOIN gesture or tab-resume decision, which
   * read the ref before the next render commits.
   */
  const setPlayingState = useCallback((next: boolean) => {
    isPlayingRef.current = next;
    setIsPlaying(next);
  }, []);

  /** Apply a remote command while suppressing the local change listener. */
  const applyRemote = useCallback((fn: () => void) => {
    isRemoteSyncingRef.current = true;
    try {
      fn();
    } finally {
      window.setTimeout(() => {
        isRemoteSyncingRef.current = false;
      }, 400);
    }
  }, []);

  const markRoomStateReceived = useCallback(() => {
    if (hasReceivedRoomStateRef.current) return;
    hasReceivedRoomStateRef.current = true;
    setHasReceivedRoomState(true);
  }, []);

  /**
   * Start playback from the JOIN click (a user gesture) without treating it as
   * a local playback command that must be broadcast. If the room state is
   * already known to be paused, keep it paused instead of starting playback.
   */
  const playForGesture = useCallback(() => {
    if (hasReceivedRoomStateRef.current && !isPlayingRef.current) {
      applyRemote(() => controllerRef.current?.pause());
      return;
    }
    applyRemote(() => controllerRef.current?.play());
  }, [applyRemote]);

  /**
   * Feed a host ping into the discontinuity detector. Returns true when the
   * host's reported position jumped *forward* beyond the expected continuation
   * of the previous ping — a deliberate seek that must be followed even while
   * the fallback is holding automatic corrections. A host stall/rebuffer makes
   * the position fall behind its continuation and is deliberately ignored.
   */
  const recordHostPing = useCallback(
    (
      msg: { currentTime: number; isPlaying: boolean; sentAt?: number },
      receivedAt: number
    ): boolean => {
      const prev = lastHostPingRef.current;
      const hasSentAt = typeof msg.sentAt === 'number' && Number.isFinite(msg.sentAt);
      lastHostPingRef.current = {
        time: msg.currentTime,
        isPlaying: msg.isPlaying,
        sentAt: hasSentAt ? (msg.sentAt as number) : null,
        receivedAt,
      };
      if (!prev) return false;
      if (prev.isPlaying !== msg.isPlaying) return false;
      const precise = hasSentAt && prev.sentAt != null;
      const elapsedSec = prev.isPlaying
        ? Math.max(
            0,
            precise
              ? ((msg.sentAt as number) - (prev.sentAt as number)) / 1000
              : (receivedAt - prev.receivedAt) / 1000
          )
        : 0;
      const delta = msg.currentTime - (prev.time + elapsedSec);
      // Only a *forward* discontinuity is a reliable seek signal. A host
      // rebuffer/stall also makes the playhead fall behind its expected
      // continuation, but that must not break the guest's fallback and pull it
      // out of the hold (a backward host seek is still handled by the normal
      // drift correction when no hold is active).
      // With send timestamps the continuation is exact; without them, network
      // jitter has to be absorbed by a much looser bound.
      const tolerance = precise ? 1.2 : 3;
      return delta > tolerance;
    },
    []
  );

  const clearResyncPending = useCallback(() => {
    setSyncResyncing(false);
    if (resyncTimerRef.current != null) {
      window.clearTimeout(resyncTimerRef.current);
      resyncTimerRef.current = null;
    }
  }, []);

  const markResyncPending = useCallback(() => {
    setSyncResyncing(true);
    if (resyncTimerRef.current != null) window.clearTimeout(resyncTimerRef.current);
    // Do not leave a "resyncing" notice up forever if no usable ping arrives.
    resyncTimerRef.current = window.setTimeout(() => {
      resyncTimerRef.current = null;
      resyncBoostRef.current = false;
      setSyncResyncing(false);
    }, 20000);
  }, []);

  /**
   * Mirror the drift guard's hold state into React state (badge in the UI) and
   * re-arm a timer so the badge disappears even if no further ping arrives.
   */
  const publishFallbackLevel = useCallback((at: number) => {
    const guard = driftGuardRef.current!;
    const active = guard.isHoldActive(at);
    setSyncFallbackLevel(active ? guard.activeHoldLevel : 0);
    if (syncFallbackTimerRef.current != null) {
      window.clearTimeout(syncFallbackTimerRef.current);
      syncFallbackTimerRef.current = null;
    }
    if (active) {
      syncFallbackTimerRef.current = window.setTimeout(() => {
        syncFallbackTimerRef.current = null;
        if (!driftGuardRef.current!.isHoldActive(Date.now())) {
          setSyncFallbackLevel(0);
        }
      }, Math.max(0, guard.holdEndsAt - at) + 50);
    }
  }, []);

  /** New media / new room state: forget the previous fallback history. */
  const resetDriftGuard = useCallback(
    (markSeek: boolean) => {
      const at = Date.now();
      const guard = driftGuardRef.current!;
      guard.reset();
      if (markSeek) guard.noteSeek(at);
      lastHostPingRef.current = null;
      pendingHostSeekRef.current = false;
      resyncBoostRef.current = false;
      clearResyncPending();
      setSyncToleranceLag(0);
      publishFallbackLevel(at);
    },
    [clearResyncPending, publishFallbackLevel]
  );

  useEffect(
    () => () => {
      if (resyncTimerRef.current != null) {
        window.clearTimeout(resyncTimerRef.current);
        resyncTimerRef.current = null;
      }
    },
    []
  );

  useEffect(
    () => () => {
      if (syncFallbackTimerRef.current != null) {
        window.clearTimeout(syncFallbackTimerRef.current);
        syncFallbackTimerRef.current = null;
      }
    },
    []
  );

  const canControlNow = useCallback(() => {
    if (isHost) return true;
    if (driveModeRef.current) return true;
    return (
      participantsRef.current.find((p) => p.peerId === myId)?.role ===
      'Controller'
    );
  }, [isHost, myId]);

  const canControlPlaybackNow = useCallback(() => {
    if (isHost) return true;
    if (driveModeRef.current) return true;
    return (
      participantsRef.current.find((p) => p.peerId === myId)?.role ===
      'Controller'
    );
  }, [isHost, myId]);

  /** Host time-authority ping: broadcasts current playback state to align peers. */
  const emitSyncPing = useCallback(() => {
    broadcast({
      type: 'SYNC_PING',
      currentTime: controllerRef.current?.getCurrentTime() ?? 0,
      isPlaying: controllerRef.current?.getIsPlaying() ?? false,
      sentAt: Date.now(),
      senderId: myId ?? '',
    });
  }, [broadcast, myId]);

  const handleIncoming = useCallback(
    (msg: SyncMessage, fromPeerId: string) => {
      const senderId = myId ?? '';
      switch (msg.type) {
        case 'PLAY': {
          setIsPlaying(true);
          if (!isHost && msg.senderId !== myId) {
            remoteClockRef.current = {
              time: msg.currentTime,
              isPlaying: true,
              at: Date.now(),
            };
          }
          // Re-baseline the discontinuity detector, but keep any already
          // detected host seek: it must still be followed after the resume.
          lastHostPingRef.current = null;
          applyRemote(() => controllerRef.current?.play());
          break;
        }
        case 'PAUSE': {
          setIsPlaying(false);
          if (!isHost && msg.senderId !== myId) {
            remoteClockRef.current = {
              time: msg.currentTime,
              isPlaying: false,
              at: Date.now(),
            };
          }
          // Nothing to chase while paused; release the current hold so the
          // badge does not linger, but keep the escalation history so a device
          // that keeps failing still backs off after the pause.
          const pauseAt = Date.now();
          driftGuardRef.current!.releaseHold();
          lastHostPingRef.current = null;
          resyncBoostRef.current = false;
          clearResyncPending();
          setSyncToleranceLag(0);
          publishFallbackLevel(pauseAt);
          applyRemote(() => controllerRef.current?.pause());
          break;
        }
        case 'SEEK': {
          if (driveModeRef.current && !isHost) break;
          const seekAt = Date.now();
          if (!isHost && msg.senderId !== myId) {
            remoteClockRef.current = {
              time: msg.currentTime,
              isPlaying: remoteClockRef.current?.isPlaying ?? true,
              at: seekAt,
            };
          }
          // An explicit seek is a fresh position: leave fallback and give the
          // player a settle window before any automatic correction is allowed.
          driftGuardRef.current!.clearHold();
          driftGuardRef.current!.noteSeek(seekAt);
          lastHostPingRef.current = null;
          pendingHostSeekRef.current = false;
          resyncBoostRef.current = false;
          clearResyncPending();
          setSyncToleranceLag(0);
          publishFallbackLevel(seekAt);
          setCurrentTime(msg.currentTime);
          applyRemote(() => controllerRef.current?.seekTo(msg.currentTime));
          break;
        }
        case 'SYNC_PING': {
          markRoomStateReceived();
          isPlayingRef.current = msg.isPlaying;
          if (driveModeRef.current && !isHost) break;
          const pingAt = Date.now();
          if (!isHost && msg.senderId !== myId) {
            // A host position jump (user seek) must be followed even while the
            // low-performance fallback is holding automatic corrections. Do not
            // confuse it with the lag this device accumulates while buffering.
            if (recordHostPing(msg, pingAt)) pendingHostSeekRef.current = true;
            remoteClockRef.current = {
              time: msg.currentTime,
              isPlaying: msg.isPlaying,
              at: pingAt,
            };
          }
          if (!currentMediaRef.current) break;
          const controller = controllerRef.current;
          if (!controller) break;
          const local = controller.getCurrentTime();
          const drift = Math.abs(local - msg.currentTime);
          const hostSeekPending = pendingHostSeekRef.current;
          const resyncBoost = resyncBoostRef.current;
          if (hostSeekPending) {
            // The host deliberately moved: the fallback's "do not chase" rule
            // no longer applies, and the normal (not adaptive) tolerance is
            // used so the change is actually followed.
            driftGuardRef.current!.clearHold();
          }
          // A device that needs e.g. 6s to recover from a seek can never hold
          // the default 1.5s bound; tolerate the lag its own buffering causes
          // (capped by DRIFT_ADAPTIVE_MAX_SEC) instead of re-seeking forever.
          // A host seek or an explicit user resync is checked against the base
          // tolerance instead, so it is not silently absorbed.
          const threshold =
            hostSeekPending || resyncBoost || !msg.isPlaying
              ? SYNC_DRIFT_THRESHOLD
              : effectiveDriftThreshold(controller.getSeekRecoveryMs?.() ?? 0);
          const buffering = controller.isBuffering?.() ?? false;
          const decision = driftGuardRef.current!.evaluate({
            drift,
            isBuffering: buffering,
            threshold,
            at: pingAt,
          });
          if (decision.action === 'correct') {
            // A correction is starting; the tolerated-lag notice is transient.
            setSyncToleranceLag(0);
            setCurrentTime(msg.currentTime);
            setIsPlaying(msg.isPlaying);
            applyRemote(() => {
              controller.seekTo(msg.currentTime);
              if (msg.isPlaying) controller.play();
              else controller.pause();
            });
            if (hostSeekPending) {
              // Following a host seek is not a failed automatic correction:
              // start a settle window, do not add a fallback strike.
              driftGuardRef.current!.noteSeek(pingAt);
              pendingHostSeekRef.current = false;
            } else {
              driftGuardRef.current!.noteCorrection(pingAt);
            }
            if (resyncBoost) {
              resyncBoostRef.current = false;
              clearResyncPending();
            }
            publishFallbackLevel(pingAt);
          } else {
            if (hostSeekPending && decision.reason === 'within-threshold') {
              pendingHostSeekRef.current = false;
            }
            if (resyncBoost && decision.reason === 'within-threshold') {
              resyncBoostRef.current = false;
              clearResyncPending();
            }
            if (decision.reason === 'within-threshold' && !buffering) {
              // Distinguish "aligned" from "playing at a tolerated lag": the
              // latter must be visible (and resyncable) instead of silently
              // accepted.
              const lag = drift > SYNC_DRIFT_THRESHOLD + 0.5 ? Math.round(drift * 10) / 10 : 0;
              setSyncToleranceLag(lag);
            } else if (decision.reason === 'fallback-hold') {
              setSyncToleranceLag(0);
            }
            setIsPlaying(msg.isPlaying);
            publishFallbackLevel(pingAt);
          }
          break;
        }
        case 'PARTICIPANTS': {
          setParticipants(dedupeParticipants(msg.participants));
          break;
        }
        case 'REQUEST_STATE': {
          if (!isHost) break;
          if (currentMediaRef.current) {
            sendTo(msg.senderId, {
              type: 'STATE_SNAPSHOT',
              platform: currentMediaRef.current.platform,
              videoId: currentMediaRef.current.videoId,
              currentTime: controllerRef.current?.getCurrentTime() ?? 0,
              isPlaying: controllerRef.current?.getIsPlaying() ?? false,
              queue: queueRef.current,
              currentId: currentIdRef.current,
              senderId,
            });
          }
          break;
        }
        case 'QUEUE_UPDATE': {
          setQueue(msg.queue);
          const changed = msg.currentId !== currentIdRef.current;
          setCurrentId(msg.currentId);
          if (changed) {
            const it = msg.queue.find((q) => q.id === msg.currentId);
            if (it) {
              // The new item is playing for the room. Drive-mode guests do not
              // operate their player, but their state must still reflect it.
              setPlayingState(true);
              if (!(driveModeRef.current && !isHost)) {
                if (!isHost) {
                  remoteClockRef.current = {
                    time: msg.currentTime,
                    isPlaying: remoteClockRef.current?.isPlaying ?? true,
                    at: Date.now(),
                  };
                }
                // New media: forget the old item's fallback history and keep
                // automatic corrections away while it loads.
                resetDriftGuard(true);
                applyRemote(() => {
                  controllerRef.current?.loadMedia(it.videoId);
                  controllerRef.current?.seekTo(msg.currentTime);
                  controllerRef.current?.play();
                });
              }
            } else {
              setPlayingState(false);
            }
          }
          break;
        }
        case 'STATE_SNAPSHOT': {
          markRoomStateReceived();
          setQueue(msg.queue);
          setCurrentId(msg.currentId);
          setCurrentTime(msg.currentTime);
          setIsPlaying(msg.isPlaying);
          isPlayingRef.current = msg.isPlaying;
          if (driveModeRef.current && !isHost) break;
          if (!isHost) {
            remoteClockRef.current = {
              time: msg.currentTime,
              isPlaying: msg.isPlaying,
              at: Date.now(),
            };
          }
          resetDriftGuard(true);
          const controller = controllerRef.current;
          if (!controller) {
            // Player mounts only after `currentMedia` is set, so the first
            // snapshot after JOIN arrives before a controller exists. Keep the
            // position/state and replay it once the player is ready; otherwise
            // the guest would start at 0 until the next SYNC_PING.
            pendingSnapshotRef.current = {
              videoId: msg.videoId,
              currentTime: msg.currentTime,
              isPlaying: msg.isPlaying,
            };
            break;
          }
          pendingSnapshotRef.current = null;
          applyRemote(() => {
            controller.loadMedia(msg.videoId);
            controller.seekTo(msg.currentTime);
            // Some platforms (YouTube loadVideoById, Niconico loadComplete)
            // start playback as part of loading. When the host is paused, stop
            // it explicitly so joining/reconnecting guests stay paused.
            if (msg.isPlaying) controller.play();
            else controller.pause();
          });
          break;
        }
        case 'DRIVE_MODE': {
          setDriveModeState(msg.enabled);
          setDriveAudioOnlyState(msg.audioOnly);
          // The video player is hidden/torn down for drive-mode guests, so a
          // pending fallback state must not survive the mode switch.
          if (!isHost) resetDriftGuard(false);
          break;
        }
        case 'ROLE_UPDATE':
          break;
        case 'NAME_UPDATE': {
          if (!isHost) break;
          const updated = dedupeParticipants(
            participantsRef.current.map((p) =>
              p.peerId === msg.peerId ? { ...p, name: msg.name } : p
            )
          );
          setParticipants(updated);
          broadcast({ type: 'PARTICIPANTS', participants: updated, senderId });
          break;
        }
        case 'VC_STATE': {
          setVcActiveState(msg.active);
          break;
        }
        case 'VC_PEER': {
          setVcPeers((prev) => {
            const next = new Set(prev);
            if (msg.inVc) next.add(msg.peerId);
            else next.delete(msg.peerId);
            return next;
          });
          break;
        }
        case 'CHAT_MESSAGE': {
          // senderId === peerId on this variant: skip echoes of own messages.
          if (msg.senderId === myId) break;
          const id = `${msg.peerId}-${msg.timestamp}`;
          setChatState((prev) => {
            if (prev.messages.some((m) => m.id === id)) return prev;
            const next = [
              ...prev.messages,
              { id, peerId: msg.peerId, name: msg.name, text: msg.text, timestamp: msg.timestamp },
            ];
            return {
              messages: next.length > 200 ? next.slice(next.length - 200) : next,
              total: prev.total + 1,
            };
          });
          break;
        }
      }

      // Star topology: host rebroadcasts a guest's playback command to other guests.
      if (
        isHost &&
        fromPeerId !== myId &&
        (msg.type === 'QUEUE_UPDATE' ||
          msg.type === 'PLAY' ||
          msg.type === 'PAUSE' ||
          msg.type === 'SEEK')
      ) {
        broadcast(msg);
      }
      if (isHost && fromPeerId !== myId && (msg.type === 'VC_PEER' || msg.type === 'VC_STATE')) {
        broadcast(msg);
      }
      if (isHost && fromPeerId !== myId && msg.type === 'CHAT_MESSAGE') {
        broadcast(msg);
      }
    },
    [applyRemote, broadcast, clearResyncPending, isHost, markRoomStateReceived, myId, publishFallbackLevel, recordHostPing, resetDriftGuard, sendTo, setPlayingState]
  );

  const reportLocalEvent = useCallback(
    (e: LocalPlayerEvent) => {
      // Viewers must not broadcast playback changes. `END` still runs below so
      // the local UI stays consistent; `goNext` keeps its own permission guard.
      if (
        (e.kind === 'PLAY' || e.kind === 'PAUSE' || e.kind === 'SEEK') &&
        !canControlPlaybackNow()
      ) {
        return;
      }
      if (driveModeRef.current && !isHost && e.kind !== 'PLAY' && e.kind !== 'PAUSE') return;
      const senderId = myId ?? '';
      if (e.kind === 'PLAY') {
        setIsPlaying(true);
        broadcast({ type: 'PLAY', currentTime: e.currentTime, senderId });
      } else if (e.kind === 'PAUSE') {
        setIsPlaying(false);
        // A local pause leaves nothing to chase; do not keep the fallback
        // notice up while the room is paused.
        const pauseAt = Date.now();
        driftGuardRef.current!.clearHold();
        resyncBoostRef.current = false;
        clearResyncPending();
        setSyncToleranceLag(0);
        publishFallbackLevel(pauseAt);
        broadcast({ type: 'PAUSE', currentTime: e.currentTime, senderId });
      } else if (e.kind === 'END') {
        setIsPlaying(false);
        const cur = currentIdRef.current;
        if (cur && endAdvanceRef.current !== cur) {
          endAdvanceRef.current = cur;
          goNextRef.current();
        }
      }
    },
    [broadcast, canControlPlaybackNow, isHost, myId, publishFallbackLevel]
  );

  const localSeek = useCallback(
    (seconds: number) => {
      if (!canControlPlaybackNow()) return;
      const at = Date.now();
      // An explicit seek is a fresh position: leave fallback and give the
      // player a settle window before automatic corrections resume.
      driftGuardRef.current!.clearHold();
      driftGuardRef.current!.noteSeek(at);
      publishFallbackLevel(at);
      setCurrentTime(seconds);
      applyRemote(() => controllerRef.current?.seekTo(seconds));
      broadcast({ type: 'SEEK', currentTime: seconds, senderId: myId ?? '' });
    },
    [applyRemote, broadcast, canControlPlaybackNow, myId, publishFallbackLevel]
  );

  const localLoadMedia = useCallback(
    (platform: Platform, videoId: string) => {
      if (!canControlNow()) return;
      const id = `${platform}:${videoId}`;
      const exists = queueRef.current.some((q) => q.id === id);
      const nextQueue = exists
        ? queueRef.current
        : [...queueRef.current, { id, platform, videoId, addedBy: myNameRef.current }];
      const wasEmpty = currentIdRef.current === null;
      const wasAtTailAndStopped =
        !wasEmpty &&
        !exists &&
        (() => {
          const cur = currentIdRef.current;
          if (!cur) return false;
          const idx = queueRef.current.findIndex((q) => q.id === cur);
          return idx === queueRef.current.length - 1 && !isPlayingRef.current;
        })();
      setQueue(nextQueue);
      if (wasEmpty || wasAtTailAndStopped) {
        setCurrentId(id);
        if (!driveModeRef.current || isHost) {
          resetDriftGuard(true);
          applyRemote(() => {
            controllerRef.current?.loadMedia(videoId);
            controllerRef.current?.seekTo(0);
            controllerRef.current?.play();
          });
          setIsPlaying(true);
        }
        broadcast({
          type: 'QUEUE_UPDATE',
          queue: nextQueue,
          currentId: id,
          currentTime: 0,
          senderId: myId ?? '',
        });
        if (isHost) emitSyncPing();
        return;
      }
      broadcast({
        type: 'QUEUE_UPDATE',
        queue: nextQueue,
        currentId: currentIdRef.current,
        currentTime: controllerRef.current?.getCurrentTime() ?? 0,
        senderId: myId ?? '',
      });
      if (isHost) emitSyncPing();
    },
    [applyRemote, broadcast, canControlNow, emitSyncPing, isHost, myId, resetDriftGuard]
  );

  const goToItem = useCallback(
    (id: string) => {
      if (!canControlNow()) return;
      const it = queueRef.current.find((q) => q.id === id);
      if (!it) return;
      setCurrentId(id);
      resetDriftGuard(true);
      if (!driveModeRef.current || isHost) {
        applyRemote(() => {
          controllerRef.current?.loadMedia(it.videoId);
          // `getCurrentTime()` may still report the previous video right after
          // loadMedia(), so restart explicitly instead of broadcasting it.
          controllerRef.current?.seekTo(0);
          controllerRef.current?.play();
        });
        setCurrentTime(0);
      }
      // The room is playing the new item. Reflect that even for drive-mode
      // guests, which leave the actual player operation to the host.
      setPlayingState(true);
      broadcast({
        type: 'QUEUE_UPDATE',
        queue: queueRef.current,
        currentId: id,
        currentTime: 0,
        senderId: myId ?? '',
      });
      if (isHost) emitSyncPing();
    },
    [applyRemote, broadcast, canControlNow, emitSyncPing, isHost, myId, resetDriftGuard, setPlayingState]
  );

  const goNext = useCallback(() => {
    if (!canControlNow()) return;
    const cur = currentIdRef.current;
    if (!cur) return;
    const idx = queueRef.current.findIndex((q) => q.id === cur);
    if (idx < 0 || idx >= queueRef.current.length - 1) return;
    goToItem(queueRef.current[idx + 1].id);
  }, [canControlNow, goToItem]);
  goNextRef.current = goNext;

  const goPrevious = useCallback(() => {
    if (!canControlNow()) return;
    const cur = currentIdRef.current;
    if (!cur) return;
    const idx = queueRef.current.findIndex((q) => q.id === cur);
    if (idx <= 0) return;
    goToItem(queueRef.current[idx - 1].id);
  }, [canControlNow, goToItem]);

  const removeFromQueue = useCallback(
    (id: string) => {
      if (!canControlNow()) return;
      const idx = queueRef.current.findIndex((q) => q.id === id);
      if (idx < 0) return;
      const nextQueue = queueRef.current.filter((q) => q.id !== id);
      let nextCurrentId = currentIdRef.current;
      let nextCurrentTime = controllerRef.current?.getCurrentTime() ?? 0;
      if (currentIdRef.current === id) {
        const replacement = nextQueue[idx - 1] ?? nextQueue[idx] ?? null;
        nextCurrentId = replacement ? replacement.id : null;
        resetDriftGuard(!!replacement);
        if (replacement) {
          // The replacement is playing for the room, including when this client
          // is a drive-mode guest that does not operate its own player.
          setPlayingState(true);
          if (!driveModeRef.current || isHost) {
            applyRemote(() => {
              controllerRef.current?.loadMedia(replacement.videoId);
              // The old playhead can still be reported right after loadMedia();
              // the replacement must start from the beginning.
              controllerRef.current?.seekTo(0);
              controllerRef.current?.play();
            });
            setCurrentTime(0);
            nextCurrentTime = 0;
          }
        } else {
          setPlayingState(false);
          if (!driveModeRef.current || isHost) {
            applyRemote(() => controllerRef.current?.pause());
          }
        }
      }
      setQueue(nextQueue);
      setCurrentId(nextCurrentId);
      broadcast({
        type: 'QUEUE_UPDATE',
        queue: nextQueue,
        currentId: nextCurrentId,
        currentTime: nextCurrentTime,
        senderId: myId ?? '',
      });
      if (isHost) emitSyncPing();
    },
    [applyRemote, broadcast, canControlNow, emitSyncPing, isHost, myId, resetDriftGuard, setPlayingState]
  );

  const moveInQueue = useCallback(
    (fromIndex: number, toIndex: number) => {
      if (!canControlNow()) return;
      const q = queueRef.current;
      const n = q.length;
      if (n < 2) return;
      const from = Math.max(0, Math.min(n - 1, fromIndex));
      const to = Math.max(0, Math.min(n - 1, toIndex));
      if (from === to) return;
      const next = [...q];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      setQueue(next);
      broadcast({
        type: 'QUEUE_UPDATE',
        queue: next,
        currentId: currentIdRef.current,
        currentTime: controllerRef.current?.getCurrentTime() ?? 0,
        senderId: myId ?? '',
      });
    },
    [broadcast, canControlNow, myId]
  );

  const delegateController = useCallback(
    (peerId: string, role: Role) => {
      if (!isHost) return;
      // Keep the drive-mode snapshot in step with manual role changes so OFF
      // restores the host's latest choice instead of the pre-drive role.
      if (
        driveModeRef.current ||
        driveModeRoleBackupRef.current.has(peerId)
      ) {
        driveModeRoleBackupRef.current.set(peerId, role);
      }
      const target = participantsRef.current.find((p) => p.peerId === peerId);
      const norm = target ? normalizeName(target.name) : '';
      if (norm) {
        if (role === 'Controller') controllerMemoryRef.current.add(norm);
        else controllerMemoryRef.current.delete(norm);
      }
      const updated = dedupeParticipants(
        participantsRef.current.map((p) =>
          p.peerId === peerId ? { ...p, role } : p
        )
      );
      setParticipants(updated);
      broadcast({ type: 'PARTICIPANTS', participants: updated, senderId: myId ?? '' });
    },
    [broadcast, isHost, myId]
  );

  const onGuestJoined = useCallback(
    (peerId: string, name: string) => {
      if (!isHost) return;
      const norm = normalizeName(name);
      const existingSame = participantsRef.current.find((p) => p.peerId === peerId);
      if (existingSame && normalizeName(existingSame.name) === norm) {
        return;
      }
      const evictPeerId = participantsRef.current.find(
        (p) => !p.isHost && normalizeName(p.name) === norm && p.peerId !== peerId
      )?.peerId;
      const rememberedRole = controllerMemoryRef.current.has(norm) ? ('Controller' as Role) : ('Viewer' as Role);
      const role: Role = driveModeRef.current ? 'Controller' : rememberedRole;
      if (role === 'Controller') controllerMemoryRef.current.add(norm);
      const filtered = evictPeerId
        ? participantsRef.current.filter((p) => p.peerId !== peerId && p.peerId !== evictPeerId)
        : participantsRef.current.filter((p) => p.peerId !== peerId);
      const updated = dedupeParticipants([
        ...filtered,
        { peerId, name, isHost: false, role },
      ]);
      setParticipants(updated);
      broadcast({ type: 'PARTICIPANTS', participants: updated, senderId: myId ?? '' });
      sendTo(peerId, {
        type: 'DRIVE_MODE',
        enabled: driveModeRef.current,
        audioOnly: driveAudioOnlyRef.current,
        senderId: myId ?? '',
      });
      if (currentMediaRef.current) {
        sendTo(peerId, {
          type: 'STATE_SNAPSHOT',
          platform: currentMediaRef.current.platform,
          videoId: currentMediaRef.current.videoId,
          currentTime: controllerRef.current?.getCurrentTime() ?? 0,
          isPlaying: controllerRef.current?.getIsPlaying() ?? false,
          queue: queueRef.current,
          currentId: currentIdRef.current,
          senderId: myId ?? '',
        });
      } else if (queueRef.current.length > 0) {
        sendTo(peerId, {
          type: 'QUEUE_UPDATE',
          queue: queueRef.current,
          currentId: currentIdRef.current,
          currentTime: 0,
          senderId: myId ?? '',
        });
      }
    },
    [broadcast, isHost, myId, sendTo]
  );

  const onGuestLeft = useCallback(
    (peerId: string) => {
      // Build the next list from the ref so the state update and the broadcast
      // carry exactly the same participants (the leaver must disappear from
      // every remaining guest's list immediately).
      const updated = dedupeParticipants(
        participantsRef.current.filter((p) => p.peerId !== peerId)
      );
      setParticipants(updated);
      driveModeRoleBackupRef.current.delete(peerId);
      broadcast({
        type: 'PARTICIPANTS',
        participants: updated,
        senderId: myId ?? '',
      });
      // Stop treating the departed guest as still in the voice call.
      setVcPeers((prev) => {
        if (!prev.has(peerId)) return prev;
        const next = new Set(prev);
        next.delete(peerId);
        return next;
      });
      broadcast({
        type: 'VC_PEER',
        peerId,
        inVc: false,
        senderId: myId ?? '',
      });
      // Intentionally leave controllerMemoryRef untouched: it restores the
      // guest's role if they reconnect with the same name.
    },
    [broadcast, myId]
  );

  const onHostLost = useCallback(() => {
    setVcActiveState(false);
    setVcPeers(new Set());
    setParticipants((prev) => dedupeParticipants(prev.filter((p) => p.peerId === myId)));
    // No host means no time authority and no more SYNC_PING corrections.
    remoteClockRef.current = null;
    resetDriftGuard(false);
  }, [myId, resetDriftGuard]);

  const onGuestReady = useCallback(() => {
    broadcast({ type: 'REQUEST_STATE', senderId: myId ?? '' });
  }, [broadcast, myId]);

  /**
   * The player controller has just become available. Apply a snapshot that
   * arrived while it was still null (initial JOIN). The pending snapshot is
   * cleared before applying, so repeated ready notifications are no-ops.
   */
  const onControllerReady = useCallback(() => {
    const pending = pendingSnapshotRef.current;
    const controller = controllerRef.current;
    if (!pending || !controller) return;
    pendingSnapshotRef.current = null;
    applyRemote(() => {
      controller.seekTo(pending.currentTime);
      if (pending.isPlaying) controller.play();
      else controller.pause();
    });
  }, [applyRemote]);

  const setVcActive = useCallback(
    (active: boolean) => {
      setVcActiveState(active);
      broadcast({ type: 'VC_STATE', active, senderId: myId ?? '' });
    },
    [broadcast, myId]
  );

  const broadcastVcPeer = useCallback(
    (inVc: boolean) => {
      const id = myId ?? '';
      setVcPeers((prev) => {
        const next = new Set(prev);
        if (inVc) next.add(id);
        else next.delete(id);
        return next;
      });
      broadcast({ type: 'VC_PEER', peerId: id, inVc, senderId: id });
    },
    [broadcast, myId]
  );

  const sendChat = useCallback(
    (text: string) => {
      const trimmed = text.trim().slice(0, 500);
      if (!trimmed) return;
      const timestamp = Date.now();
      const id = `${myId}-${timestamp}-${Math.random().toString(36).slice(2, 8)}`;
      broadcast({
        type: 'CHAT_MESSAGE',
        peerId: myId ?? '',
        name: myNameRef.current,
        text: trimmed,
        timestamp,
        senderId: myId ?? '',
      });
      setChatState((prev) => {
        const next = [
          ...prev.messages,
          { id, peerId: myId ?? '', name: myNameRef.current, text: trimmed, timestamp },
        ];
        return {
          messages: next.length > 200 ? next.slice(next.length - 200) : next,
          total: prev.total + 1,
        };
      });
    },
    [broadcast, myId]
  );

  const setMyNickname = useCallback(
    (name: string) => {
      const selfName = isHost ? `${name} (Host)` : name;
      const updated = dedupeParticipants(
        participantsRef.current.map((p) =>
          p.peerId === myId ? { ...p, name: selfName } : p
        )
      );
      setParticipants(updated);
      if (isHost) {
        broadcast({ type: 'PARTICIPANTS', participants: updated, senderId: myId ?? '' });
      } else {
        broadcast({ type: 'NAME_UPDATE', peerId: myId ?? '', name, senderId: myId ?? '' });
      }
    },
    [broadcast, isHost, myId]
  );

  const setDriveMode = useCallback(
    (enabled: boolean) => {
      if (!isHost) return;
      setDriveModeState(enabled);
      if (enabled) {
        // Remember the standard-mode roles on the OFF -> ON transition.
        // Re-enabling while already driving must not snapshot the promoted
        // Controller roles (or a peer who joined during drive mode).
        if (!driveModeRef.current) {
          participantsRef.current.forEach((p) => {
            if (p.isHost) return;
            driveModeRoleBackupRef.current.set(p.peerId, p.role);
          });
        }
        const updated = dedupeParticipants(
          participantsRef.current.map((p) =>
            p.isHost ? p : { ...p, role: 'Controller' as Role }
          )
        );
        updated.forEach((p) => {
          if (!p.isHost) controllerMemoryRef.current.add(normalizeName(p.name));
        });
        setParticipants(updated);
        broadcast({ type: 'PARTICIPANTS', participants: updated, senderId: myId ?? '' });
      } else {
        const updated = dedupeParticipants(
          participantsRef.current.map((p) => {
            if (p.isHost) return p;
            const role = driveModeRoleBackupRef.current.get(p.peerId) ?? 'Viewer';
            return { ...p, role };
          })
        );
        // controllerMemoryRef must mirror the restored roles; otherwise a
        // reconnecting Viewer would inherit the drive-mode Controller memory.
        updated.forEach((p) => {
          if (p.isHost) return;
          const norm = normalizeName(p.name);
          if (p.role === 'Controller') controllerMemoryRef.current.add(norm);
          else controllerMemoryRef.current.delete(norm);
        });
        driveModeRoleBackupRef.current.clear();
        setParticipants(updated);
        broadcast({ type: 'PARTICIPANTS', participants: updated, senderId: myId ?? '' });
      }
      broadcast({
        type: 'DRIVE_MODE',
        enabled,
        audioOnly: driveAudioOnlyRef.current,
        senderId: myId ?? '',
      });
    },
    [broadcast, isHost, myId]
  );

  const setDriveAudioOnly = useCallback(
    (audioOnly: boolean) => {
      if (!isHost) return;
      setDriveAudioOnlyState(audioOnly);
      broadcast({
        type: 'DRIVE_MODE',
        enabled: driveModeRef.current,
        audioOnly,
        senderId: myId ?? '',
      });
    },
    [broadcast, isHost, myId]
  );

  /**
   * Manual fallback escape hatch (shown in the player overlay while a hold is
   * active): align to the host's latest predicted position once and re-enable
   * automatic correction. Works while buffering — the player queues the seek
   * instead of restarting its load.
   */
  const resyncNow = useCallback(() => {
    const at = Date.now();
    const guard = driftGuardRef.current!;
    const controller = controllerRef.current;
    const clock = remoteClockRef.current;
    guard.clearHold();
    publishFallbackLevel(at);
    if (!controller) return;
    const target = predictRemoteTime(clock, at);
    if (target == null) {
      // No authoritative host timestamp yet: ask for a fresh snapshot instead
      // of guessing a position.
      broadcast({ type: 'REQUEST_STATE', senderId: myId ?? '' });
      return;
    }
    guard.noteSeek(at);
    // One follow-up correction is allowed against the base tolerance, because
    // the resync seek itself can buffer and leave the guest behind again.
    resyncBoostRef.current = true;
    markResyncPending();
    setCurrentTime(target);
    applyRemote(() => {
      controller.seekTo(target);
      if (clock?.isPlaying) controller.play();
      else controller.pause();
    });
  }, [applyRemote, broadcast, markResyncPending, myId, publishFallbackLevel]);

  // Host is the time authority: periodically broadcast SYNC_PING to all guests.
  // In drive mode guests don't render video, so skip pings to save bandwidth.
  useEffect(() => {
    if (!isHost || !connected || driveMode) return;
    const id = window.setInterval(() => {
      broadcast({
        type: 'SYNC_PING',
        currentTime: controllerRef.current?.getCurrentTime() ?? 0,
        isPlaying: controllerRef.current?.getIsPlaying() ?? false,
        sentAt: Date.now(),
        senderId: myId ?? '',
      });
    }, SYNC_PING_INTERVAL);
    return () => window.clearInterval(id);
  }, [isHost, connected, driveMode, broadcast, myId]);

  // Preload next queue item's thumbnail for drive-mode buffering.
  useEffect(() => {
    if (!driveMode || !isHost || !currentId) return;
    const idx = queue.findIndex((q) => q.id === currentId);
    const next = queue[idx + 1];
    if (!next) return;
    const thumb =
      next.platform === 'youtube'
        ? `https://i.ytimg.com/vi/${next.videoId}/hqdefault.jpg`
        : `https://tn.smilevideo.jp/smile?i=${next.videoId}`;
    const img = new Image();
    img.src = thumb;
  }, [driveMode, isHost, queue, currentId]);

  const myEntry = participants.find((p) => p.peerId === myId);
  const myRole: Role = myEntry?.role ?? (isHost ? 'Host' : 'Viewer');
  const canControl = driveMode ? true : isHost || myRole === 'Controller';
  const canQueue = driveMode ? true : canControl;

  return {
    controllerRef,
    isRemoteSyncingRef,
    participants,
    myRole,
    canControl,
    canQueue,
    driveMode,
    driveAudioOnly,
    currentMedia,
    queue,
    currentId,
    isPlaying,
    hasReceivedRoomState,
    playForGesture,
    currentTime,
    syncFallbackLevel,
    syncResyncing,
    syncToleranceLag,
    resyncNow,
    handleIncoming,
    reportLocalEvent,
    localSeek,
    localLoadMedia,
    titles,
    goToItem,
    goNext,
    goPrevious,
    removeFromQueue,
    moveInQueue,
    delegateController,
    setMyNickname,
    onGuestJoined,
    onGuestLeft,
    onHostLost,
    onGuestReady,
    onControllerReady,
    vcActive,
    vcPeers,
    setVcActive,
    broadcastVcPeer,
    setDriveMode,
    setDriveAudioOnly,
    chat,
    chatSeq,
    sendChat,
  };
}
