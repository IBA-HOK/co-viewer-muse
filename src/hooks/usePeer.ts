import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Peer from 'peerjs';
import type { DataConnection, MediaConnection } from 'peerjs';
import { isValidSyncMessage, MAX_CHAT_NAME_LENGTH, type SyncMessage } from '../types';
import type {
  TransportFileChannel,
  TransportFileChannelEvent,
  TransportTopology,
} from '../transport/types';
import { FILE_CHANNEL_LABEL } from '../transfer/fileTransfer';

export interface UsePeerOptions {
  roomIdFromUrl: string | null;
  /**
   * Explicit PeerJS id. MQTT mode passes the transport's sync id so the same
   * value identifies a participant for sync, presence, voice and PeerJS.
   * Omit it for PeerJS mode (the server assigns a random id as before).
   */
  peerId?: string;
  displayName: string;
  onMessage: (msg: SyncMessage, fromPeerId: string) => void;
  onGuestConnected: (peerId: string, name: string) => void;
  onGuestDisconnected: (peerId: string) => void;
  onHostDisconnected: () => void;
  onConnected: (isHost: boolean) => void;
  onCall?: (call: MediaConnection) => void;
}

export interface UsePeerResult {
  isHost: boolean;
  myId: string | null;
  roomId: string | null;
  connected: boolean;
  /** PeerJS is a star: guests only reach the host, which relays to peers. */
  readonly topology?: TransportTopology;
  broadcast: (msg: SyncMessage) => void;
  sendTo: (peerId: string, msg: SyncMessage) => void;
  callPeer: (peerId: string, stream: MediaStream) => MediaConnection | null;
  onCall: (cb: (call: MediaConnection) => void) => void;
  /** Dedicated binary channel for file distribution (never the sync channel). */
  fileChannel: TransportFileChannel;
  reconnect: () => void;
}

/** Give up on an outgoing guest connection if the DataChannel hasn't opened. */
export const CONNECT_TIMEOUT_MS = 20000;
/** Base delay before retrying a dropped guest connection — exponential backoff. */
export const RECONNECT_BASE_MS = 1500;
export const RECONNECT_MAX_MS = 30000;

/** Bounded retry queue size per peer — prevents unbounded growth on host cutoff / IP change. */
export const MAX_QUEUE = 64;

/**
 * PeerJS's own id validation. An explicit id must satisfy this or the Peer
 * constructor aborts with `invalid-id`, so anything else falls back to the
 * server-assigned id instead of breaking the room.
 */
const PEER_ID_PATTERN = /^[A-Za-z0-9]+(?:[ _-][A-Za-z0-9]+)*$/;

export function isValidPeerId(id: string): boolean {
  return PEER_ID_PATTERN.test(id);
}

/**
 * PeerJS star topology. The host owns the room (its Peer ID == room id). Guests
 * connect to that id. Reconnect is automatic on temporary drops: guests retry the
 * DataChannel; the broker reconnect is handled via peer.reconnect().
 */
export function usePeer(opts: UsePeerOptions): UsePeerResult {
  const [isHost, setIsHost] = useState(false);
  const [myId, setMyId] = useState<string | null>(null);
  const [roomId, setRoomId] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);

  const peerRef = useRef<Peer | null>(null);
  const hostConnRef = useRef<DataConnection | null>(null);
  const guestConnsRef = useRef<Map<string, DataConnection>>(new Map());
  /** Dedicated file DataConnections, keyed by peer — never mixed with sync conns. */
  const fileConnsRef = useRef<Map<string, DataConnection>>(new Map());
  const fileSubscribersRef = useRef<
    Set<(event: TransportFileChannelEvent) => void>
  >(new Set());
  const isHostRef = useRef(false);
  const roomIdRef = useRef<string | null>(null);
  const nameRef = useRef(opts.displayName);
  const reconnectTimerRef = useRef<number | undefined>(undefined);
  const connectTimerRef = useRef<number | undefined>(undefined);
  const hostConnectTimersRef = useRef<Map<string, number>>(new Map());
  const callHandlerRef = useRef<((call: MediaConnection) => void) | null>(null);
  const connectedRef = useRef(false);
  const guestJoinedFiredRef = useRef<Set<string>>(new Set());
  const pendingQueueRef = useRef<Map<string, SyncMessage[]>>(new Map());
  const flushAllRef = useRef<() => void>(() => {});
  const attemptRef = useRef(0);

  const cbRef = useRef(opts);
  cbRef.current = opts;
  nameRef.current = opts.displayName;
  connectedRef.current = connected;

  const roomIdFromUrlRef = useRef(opts.roomIdFromUrl);

  const getConns = useCallback((): DataConnection[] => {
    if (isHostRef.current) return Array.from(guestConnsRef.current.values());
    return hostConnRef.current ? [hostConnRef.current] : [];
  }, []);

  const enqueue = useCallback((peerIdKey: string, msg: SyncMessage) => {
    const q = pendingQueueRef.current.get(peerIdKey) ?? [];
    if (q.length >= MAX_QUEUE) {
      q.shift();
      console.warn(`[usePeer] pendingQueue overflow for ${peerIdKey}: dropping oldest (max ${MAX_QUEUE})`);
    }
    q.push(msg);
    pendingQueueRef.current.set(peerIdKey, q);
  }, []);

  const flushQueue = useCallback((key: string) => {
    const q = pendingQueueRef.current.get(key);
    if (!q || q.length === 0) return;
    // Flush in FIFO order; IP-change / host-cutoff recovery — resend queued SyncMessages once DataChannel reopens
    for (const m of [...q]) {
      const c = key === '__host__' ? hostConnRef.current : guestConnsRef.current.get(key);
      if (c && c.open) {
        try {
          c.send(m);
          q.shift();
        } catch {
          break;
        }
      } else {
        break;
      }
    }
    if (q.length === 0) pendingQueueRef.current.delete(key);
  }, []);

  const flushAll = useCallback(() => {
    if (isHostRef.current) {
      guestConnsRef.current.forEach((_c, peerId) => flushQueue(peerId));
    } else {
      flushQueue('__host__');
    }
  }, [flushQueue]);

  const broadcast = useCallback(
    (msg: SyncMessage) => {
      const conns = getConns();
      if (conns.length === 0) {
        // No peers / hostConn not ready — queue for later flush (guest uses '__host__')
        if (!isHostRef.current) enqueue('__host__', msg);
        return;
      }
      for (const c of conns) {
        const key = isHostRef.current ? c.peer : '__host__';
        if (c.open) {
          try {
            c.send(msg);
          } catch {
            enqueue(key, msg);
          }
        } else {
          enqueue(key, msg);
        }
      }
    },
    [getConns, enqueue]
  );

  flushAllRef.current = flushAll;

  const sendTo = useCallback(
    (peerId: string, msg: SyncMessage) => {
      const key = isHostRef.current ? peerId : '__host__';
      const c = isHostRef.current ? guestConnsRef.current.get(peerId) : hostConnRef.current;
      if (c && c.open) {
        try {
          c.send(msg);
        } catch {
          enqueue(key, msg);
        }
      } else {
        enqueue(key, msg);
      }
    },
    [enqueue]
  );

  const clearConnectTimer = useCallback(() => {
    if (connectTimerRef.current) {
      window.clearTimeout(connectTimerRef.current);
      connectTimerRef.current = undefined;
    }
  }, []);

  const clearHostConnectTimer = useCallback((peerId: string) => {
    const timer = hostConnectTimersRef.current.get(peerId);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      hostConnectTimersRef.current.delete(peerId);
    }
  }, []);

  /**
   * Host-side incoming DataConnection timeout: PeerJS does not guarantee
   * open/close/error when ICE fails, so abandon a connection that never opens.
   */
  const armHostConnectTimer = useCallback(
    (conn: DataConnection) => {
      clearHostConnectTimer(conn.peer);
      if (conn.open) return;
      let timer: number;
      timer = window.setTimeout(() => {
        // A newer connection for the same peer owns the timer slot now.
        if (hostConnectTimersRef.current.get(conn.peer) !== timer) return;
        hostConnectTimersRef.current.delete(conn.peer);
        if (guestConnsRef.current.get(conn.peer) !== conn || conn.open) return;
        // Remove state before close so the close handler cannot notify twice.
        guestConnsRef.current.delete(conn.peer);
        guestJoinedFiredRef.current.delete(conn.peer);
        pendingQueueRef.current.delete(conn.peer);
        cbRef.current.onGuestDisconnected(conn.peer);
        try {
          conn.close();
        } catch {
          /* noop */
        }
      }, CONNECT_TIMEOUT_MS);
      hostConnectTimersRef.current.set(conn.peer, timer);
    },
    [clearHostConnectTimer]
  );

  const emitFileEvent = useCallback((event: TransportFileChannelEvent) => {
    for (const subscriber of [...fileSubscribersRef.current]) {
      try {
        subscriber(event);
      } catch (err) {
        console.warn('[usePeer] file channel subscriber failed', err);
      }
    }
  }, []);

  /**
   * Wire a file-only DataConnection. It never touches the main connection
   * registries, so a file offer can never replace the room's sync channel.
   */
  const wireFileConn = useCallback(
    (conn: DataConnection) => {
      const isCurrentFileConn = (): boolean =>
        fileConnsRef.current.get(conn.peer) === conn;

      conn.on('data', (data) => {
        if (!isCurrentFileConn()) return;
        emitFileEvent({ kind: 'data', peerId: conn.peer, data });
      });
      conn.on('open', () => {
        if (!isCurrentFileConn()) return;
        emitFileEvent({ kind: 'open', peerId: conn.peer });
      });
      conn.on('close', () => {
        if (!isCurrentFileConn()) return;
        fileConnsRef.current.delete(conn.peer);
        emitFileEvent({ kind: 'close', peerId: conn.peer });
      });
      conn.on('error', () => {
        if (!isCurrentFileConn()) return;
        fileConnsRef.current.delete(conn.peer);
        emitFileEvent({ kind: 'close', peerId: conn.peer });
        try {
          conn.close();
        } catch {
          /* noop */
        }
      });
    },
    [emitFileEvent]
  );

  const acceptFileConn = useCallback(
    (conn: DataConnection) => {
      const previous = fileConnsRef.current.get(conn.peer);
      fileConnsRef.current.set(conn.peer, conn);
      wireFileConn(conn);
      if (previous && previous !== conn) {
        // Register the replacement first so the old close cannot delete it.
        try {
          previous.close();
        } catch {
          /* noop */
        }
      }
    },
    [wireFileConn]
  );

  const openFileChannel = useCallback(
    (peerId: string) => {
      const peer = peerRef.current;
      if (!peer) return;
      const existing = fileConnsRef.current.get(peerId);
      if (existing) return;
      const conn = peer.connect(peerId, {
        label: FILE_CHANNEL_LABEL,
        reliable: true,
      });
      fileConnsRef.current.set(peerId, conn);
      wireFileConn(conn);
    },
    [wireFileConn]
  );

  const sendFileData = useCallback((peerId: string, data: unknown): boolean => {
    const conn = fileConnsRef.current.get(peerId);
    if (!conn || !conn.open) return false;
    try {
      // PeerJS accepts JSON objects and ArrayBuffers on the same connection.
      conn.send(data);
      return true;
    } catch {
      return false;
    }
  }, []);

  const closeFileChannel = useCallback((peerId: string) => {
    const conn = fileConnsRef.current.get(peerId);
    if (!conn) return;
    // Delete before closing so the close event is ignored by the identity guard.
    fileConnsRef.current.delete(peerId);
    try {
      conn.close();
    } catch {
      /* noop */
    }
  }, []);

  const isFileChannelOpen = useCallback(
    (peerId: string) => !!fileConnsRef.current.get(peerId)?.open,
    []
  );

  const fileBufferedAmount = useCallback((peerId: string): number => {
    const conn = fileConnsRef.current.get(peerId);
    if (!conn) return 0;
    try {
      const channelAmount = conn.dataChannel?.bufferedAmount;
      if (typeof channelAmount === 'number') return channelAmount;
      const buffered = (conn as unknown as { bufferSize?: number }).bufferSize;
      return typeof buffered === 'number' ? buffered : 0;
    } catch {
      return 0;
    }
  }, []);

  const subscribeFileChannel = useCallback(
    (callback: (event: TransportFileChannelEvent) => void) => {
      fileSubscribersRef.current.add(callback);
      return () => {
        fileSubscribersRef.current.delete(callback);
      };
    },
    []
  );

  const wireConn = useCallback(
    (conn: DataConnection) => {
      // A replaced DataConnection may still fire open/close/error/data after a
      // reconnection. Only the connection currently registered for its role may
      // mutate state, otherwise a stale close would tear down a healthy session.
      const isCurrentConn = (): boolean =>
        isHostRef.current
          ? guestConnsRef.current.get(conn.peer) === conn
          : hostConnRef.current === conn;

      conn.on('data', (data) => {
        if (!isCurrentConn()) return;
        // A connected peer can send arbitrary data; never forward malformed
        // messages to the room sync layer.
        if (!isValidSyncMessage(data)) return;
        cbRef.current.onMessage(data, conn.peer);
      });
      conn.on('open', () => {
        if (!isCurrentConn()) return;
        clearConnectTimer();
        if (isHostRef.current) clearHostConnectTimer(conn.peer);
        attemptRef.current = 0;
        flushQueue(isHostRef.current ? conn.peer : '__host__');
        if (!isHostRef.current) {
          setConnected(true);
          cbRef.current.onConnected(false);
        }
      });
      conn.on('close', () => {
        if (!isCurrentConn()) return;
        clearHostConnectTimer(conn.peer);
        if (isHostRef.current) {
          guestConnsRef.current.delete(conn.peer);
          guestJoinedFiredRef.current.delete(conn.peer);
          cbRef.current.onGuestDisconnected(conn.peer);
        } else {
          clearConnectTimer();
          setConnected(false);
          cbRef.current.onHostDisconnected();
          scheduleReconnect();
        }
      });
      conn.on('error', () => {
        if (!isCurrentConn()) return;
        clearHostConnectTimer(conn.peer);
        if (isHostRef.current) {
          // PeerJS does not guarantee a close event after an error. Treat the
          // error as a departure so the guest does not linger as a ghost.
          guestConnsRef.current.delete(conn.peer);
          guestJoinedFiredRef.current.delete(conn.peer);
          pendingQueueRef.current.delete(conn.peer);
          cbRef.current.onGuestDisconnected(conn.peer);
          try {
            conn.close();
          } catch {
            /* noop */
          }
        } else {
          clearConnectTimer();
          // PeerJS does not guarantee a close event after an error. Detach the
          // failed connection before closing it so the timer callback can
          // reconnect, and so any close emitted by close()/PeerJS is ignored by
          // the identity guard (no duplicate onHostDisconnected/reconnect).
          hostConnRef.current = null;
          setConnected(false);
          cbRef.current.onHostDisconnected();
          try {
            conn.close();
          } catch {
            /* noop */
          }
          scheduleReconnect();
        }
      });
    },
    [clearConnectTimer, clearHostConnectTimer, flushQueue]
  );

  const connectToHost = useCallback(
    (id: string) => {
      const peer = peerRef.current;
      if (!peer) return;
      clearConnectTimer();
      const conn = peer.connect(id, {
        metadata: { name: nameRef.current },
      });
      const prevConn = hostConnRef.current;
      hostConnRef.current = conn;
      wireConn(conn);
      // Register the replacement before closing the old conn: its synchronous
      // close event is then ignored by the identity guard in wireConn.
      if (prevConn && prevConn !== conn) {
        try {
          prevConn.close();
        } catch {
          /* noop */
        }
      }
      // Manual connect timeout: PeerJS 1.5.x has no connect timeout option, so
      // abandon the attempt if the DataChannel hasn't opened in time.
      connectTimerRef.current = window.setTimeout(() => {
        if (!conn.open) {
          connectTimerRef.current = undefined;
          try {
            conn.close();
          } catch {
            /* noop */
          }
          if (hostConnRef.current === conn) hostConnRef.current = null;
          setConnected(false);
          cbRef.current.onHostDisconnected();
          scheduleReconnect();
        }
      }, CONNECT_TIMEOUT_MS);
    },
    [wireConn, clearConnectTimer]
  );

  const scheduleReconnect = useCallback(() => {
    if (isHostRef.current || reconnectTimerRef.current !== undefined) return;
    const delay =
      Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * Math.pow(2, attemptRef.current)) *
      (0.85 + Math.random() * 0.3);
    attemptRef.current += 1;
    reconnectTimerRef.current = window.setTimeout(() => {
      reconnectTimerRef.current = undefined;
      // Retry when the current DataConnection is not open OR the hook is no
      // longer connected. The latter covers a PeerJS error that leaves the
      // failed connection object (and its `open` flag) in place.
      if (roomIdRef.current && (!hostConnRef.current?.open || !connectedRef.current)) {
        connectToHost(roomIdRef.current);
      }
    }, delay);
  }, [connectToHost]);

  const reconnect = useCallback(() => {
    if (isHostRef.current) {
      peerRef.current?.reconnect();
    } else if (roomIdRef.current) {
      connectToHost(roomIdRef.current);
    }
  }, [connectToHost]);

  useEffect(() => {
    let cancelled = false;
    const isHostMode = !roomIdFromUrlRef.current;
    isHostRef.current = isHostMode;
    setIsHost(isHostMode);

    const peerOptions = {
      config: {
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          {
            urls: 'turn:openrelay.metered.ca:80',
            username: 'openrelayproject',
            credential: 'openrelayproject',
          },
          {
            urls: 'turn:openrelay.metered.ca:443',
            username: 'openrelayproject',
            credential: 'openrelayproject',
          },
          {
            urls: 'turn:openrelay.metered.ca:443?transport=tcp',
            username: 'openrelayproject',
            credential: 'openrelayproject',
          },
        ],
      },
    };
    const explicitPeerId = opts.peerId;
    const hasExplicitPeerId = !!explicitPeerId && isValidPeerId(explicitPeerId);
    if (explicitPeerId && !hasExplicitPeerId) {
      console.warn('[usePeer] invalid explicit peer id — using a server-assigned id');
    }
    const peer = hasExplicitPeerId
      ? new Peer(explicitPeerId, peerOptions)
      : new Peer(peerOptions);
    peerRef.current = peer;

      peer.on('open', (id) => {
        if (cancelled) return;
        attemptRef.current = 0;
        setMyId(id);
        if (isHostMode) {
          roomIdRef.current = id;
          setRoomId(id);
          setConnected(true);
          cbRef.current.onConnected(true);
          // Host peer (re)opened after IP change / broker reconnect — flush queued messages to all guests
          flushAllRef.current();
        } else {
          roomIdRef.current = roomIdFromUrlRef.current;
          setRoomId(roomIdFromUrlRef.current);
          connectToHost(roomIdFromUrlRef.current!);
        }
      });

      peer.on('connection', (conn) => {
        // A file channel is not the room connection: keep it in its own map
        // and leave the guest/host sync registration untouched.
        if (conn.label === FILE_CHANNEL_LABEL) {
          acceptFileConn(conn);
          return;
        }
        const prevConn = guestConnsRef.current.get(conn.peer);
        guestConnsRef.current.set(conn.peer, conn);
        wireConn(conn);
        // Same peer reconnected: the old connection's timeout must not fire
        // against the replacement.
        clearHostConnectTimer(conn.peer);
        // Same peer reconnected: replace the old entry first, then close the
        // old conn so its close event cannot delete the new registration.
        if (prevConn && prevConn !== conn) {
          try {
            prevConn.close();
          } catch {
            /* noop */
          }
        }
        // metadata is set by the connecting peer and may be any JSON value.
        // Only a string is a usable name; everything else (and an empty name)
        // is passed as '' so onGuestJoined applies its Guest-xxxx fallback.
        const rawName = conn.metadata?.name;
        const name =
          typeof rawName === 'string'
            ? rawName.trim().slice(0, MAX_CHAT_NAME_LENGTH)
            : '';
        const fireOnce = (): void => {
          if (guestJoinedFiredRef.current.has(conn.peer)) return;
          guestJoinedFiredRef.current.add(conn.peer);
          cbRef.current.onGuestConnected(conn.peer, name);
        };
        fireOnce();
        if (!conn.open) {
          // Arm after registration so this timer is the current one for the peer.
          armHostConnectTimer(conn);
          conn.once('open', () => {
            const cur = guestConnsRef.current.get(conn.peer);
            if (cur === conn && cur.open) {
              fireOnce();
            }
          });
        }
      });

      peer.on('disconnected', () => {
        console.debug('[usePeer] disconnected — IP change suspected — peer.reconnect() keeps ID');
        peer.reconnect();
      });

      peer.on('error', () => {
        if (!isHostRef.current) {
          setConnected(false);
          cbRef.current.onHostDisconnected();
          scheduleReconnect();
        }
      });

      peer.on('call', (call) => {
        callHandlerRef.current?.(call);
      });

      const handleOnline = (): void => {
        if (!isHostRef.current && !connectedRef.current && roomIdRef.current) {
          attemptRef.current = 0;
          if (reconnectTimerRef.current !== undefined) {
            window.clearTimeout(reconnectTimerRef.current);
            reconnectTimerRef.current = undefined;
          }
          scheduleReconnect();
        }
      };
      const handleVis = (): void => {
        if (!document.hidden && !isHostRef.current && !hostConnRef.current?.open && roomIdRef.current) {
          scheduleReconnect();
        }
      };
      window.addEventListener('online', handleOnline);
      document.addEventListener('visibilitychange', handleVis);

    return () => {
      cancelled = true;
      window.removeEventListener('online', handleOnline);
      document.removeEventListener('visibilitychange', handleVis);
      if (reconnectTimerRef.current) window.clearTimeout(reconnectTimerRef.current);
      clearConnectTimer();
      hostConnectTimersRef.current.forEach((timer) => window.clearTimeout(timer));
      hostConnectTimersRef.current.clear();
      peerRef.current?.destroy();
      peerRef.current = null;
      hostConnRef.current = null;
      guestConnsRef.current.clear();
      for (const conn of fileConnsRef.current.values()) {
        try {
          conn.close();
        } catch {
          /* noop */
        }
      }
      fileConnsRef.current.clear();
      fileSubscribersRef.current.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const callPeer = useCallback((peerId: string, stream: MediaStream) => {
    const peer = peerRef.current;
    if (!peer) return null;
    return peer.call(peerId, stream) ?? null;
  }, []);

  const onCall = useCallback((cb: (call: MediaConnection) => void) => {
    callHandlerRef.current = cb;
  }, []);

  const fileChannel = useMemo<TransportFileChannel>(
    () => ({
      open: openFileChannel,
      send: sendFileData,
      close: closeFileChannel,
      isOpen: isFileChannelOpen,
      bufferedAmount: fileBufferedAmount,
      subscribe: subscribeFileChannel,
    }),
    [
      closeFileChannel,
      fileBufferedAmount,
      isFileChannelOpen,
      openFileChannel,
      sendFileData,
      subscribeFileChannel,
    ]
  );

  return {
    isHost,
    myId,
    roomId,
    connected,
    topology: 'star',
    broadcast,
    sendTo,
    reconnect,
    callPeer,
    onCall,
    fileChannel,
  };
}

/** Alias for transport abstraction — keeps App.tsx `usePeer` import stable. */
export const createPeerTransport = usePeer;
