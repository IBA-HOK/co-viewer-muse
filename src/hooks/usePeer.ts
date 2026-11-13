import { useCallback, useEffect, useRef, useState } from 'react';
import Peer from 'peerjs';
import type { DataConnection, MediaConnection } from 'peerjs';
import type { SyncMessage } from '../types';
import type { TransportTopology } from '../transport/types';

export interface UsePeerOptions {
  roomIdFromUrl: string | null;
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
        cbRef.current.onMessage(data as SyncMessage, conn.peer);
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

    const peer = new Peer({
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
    });
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
        const name = (conn.metadata?.name as string) ?? 'Guest';
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
  };
}

/** Alias for transport abstraction — keeps App.tsx `usePeer` import stable. */
export const createPeerTransport = usePeer;
