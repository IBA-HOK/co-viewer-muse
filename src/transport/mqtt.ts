import { useCallback, useEffect, useRef, useState } from 'react';
import mqtt, { type MqttClient } from 'mqtt';
import type { SyncMessage } from '../types';
import type { Transport, TransportOptions } from './types';
import { getMqttBrokerUrl } from './types';

function genId(): string {
  return `co-viewer-${Math.random().toString(36).slice(2, 8)}-${Date.now()}`;
}

function syncTopic(roomId: string): string {
  return `co-viewer/${roomId}/sync`;
}

function stateTopic(roomId: string): string {
  return `co-viewer/${roomId}/state`;
}

function presenceTopic(roomId: string): string {
  return `co-viewer/${roomId}/presence`;
}

function dmTopic(roomId: string, peerId: string): string {
  return `co-viewer/${roomId}/dm/${peerId}`;
}

function resolvePublishTarget(
  msg: SyncMessage,
  roomId: string
): { topic: string; qos: 0 | 1; retain: boolean } {
  if (msg.type === 'STATE_SNAPSHOT' || msg.type === 'QUEUE_UPDATE') {
    return { topic: stateTopic(roomId), qos: 1, retain: true };
  }
  const qos: 0 | 1 = msg.type === 'SYNC_PING' ? 0 : 1;
  return { topic: syncTopic(roomId), qos, retain: false };
}

function isSyncMessage(value: unknown): value is SyncMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { type?: unknown }).type === 'string'
  );
}

interface PresenceMessage {
  peerId: string;
  name?: string;
  online: boolean;
}

function isPresenceMessage(value: unknown): value is PresenceMessage {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { peerId?: unknown; name?: unknown; online?: unknown };
  return (
    typeof candidate.peerId === 'string' &&
    (candidate.name === undefined || typeof candidate.name === 'string') &&
    typeof candidate.online === 'boolean'
  );
}

/**
 * MQTT WSS transport adapter.
 * Mirrors usePeer surface; sync travels over mqtt.js, voice stays PeerJS (no-op here).
 */
export function useMqttTransport(opts: TransportOptions): Transport {
  const enabled = opts.enabled ?? true;
  const roomIdFromUrlRef = useRef(opts.roomIdFromUrl);
  const cbRef = useRef(opts);
  cbRef.current = opts;

  const [myId] = useState<string>(() => genId());
  const [isHost] = useState<boolean>(() => !roomIdFromUrlRef.current);
  const [roomId] = useState<string | null>(() =>
    roomIdFromUrlRef.current ? roomIdFromUrlRef.current : myId
  );
  const [connected, setConnected] = useState(false);

  const clientRef = useRef<MqttClient | null>(null);
  const enabledRef = useRef(enabled);
  const myIdRef = useRef(myId);
  const roomIdRef = useRef<string | null>(roomId);
  const isHostRef = useRef(isHost);

  enabledRef.current = enabled;
  myIdRef.current = myId;
  roomIdRef.current = roomId;
  isHostRef.current = isHost;

  const publishJson = useCallback(
    (topic: string, msg: SyncMessage, qos: 0 | 1, retain: boolean) => {
      if (!enabledRef.current) return;
      const client = clientRef.current;
      if (!client) return;
      try {
        const payload = JSON.stringify(msg);
        client.publish(topic, payload, { qos, retain });
      } catch {
        console.warn('[mqtt] JSON stringify failed');
      }
    },
    []
  );

  const broadcast = useCallback(
    (msg: SyncMessage) => {
      if (!enabledRef.current) return;
      const rid = roomIdRef.current;
      if (!rid) return;
      const { topic, qos, retain } = resolvePublishTarget(msg, rid);
      publishJson(topic, msg, qos, retain);
    },
    [publishJson]
  );

  const sendTo = useCallback(
    (peerId: string, msg: SyncMessage) => {
      if (!enabledRef.current) return;
      const rid = roomIdRef.current;
      if (!rid) return;
      const topic = dmTopic(rid, peerId);
      try {
        const payload = JSON.stringify(msg);
        clientRef.current?.publish(topic, payload, { qos: 1, retain: false });
      } catch {
        console.warn('[mqtt] JSON stringify failed');
      }
    },
    []
  );

  const reconnect = useCallback(() => {
    if (!enabledRef.current) return;
    const client = clientRef.current;
    if (client) {
      try {
        client.reconnect();
      } catch {
        /* noop */
      }
    }
  }, []);

  const callPeer = useCallback(() => null, []) as unknown as NonNullable<Transport['callPeer']>;

  const onCall = useCallback(() => {}, []) as unknown as NonNullable<Transport['onCall']>;

  useEffect(() => {
    if (!enabled) {
      setConnected(false);
      return;
    }
    const rid = roomIdRef.current;
    if (!rid) return;
    const brokerUrl = getMqttBrokerUrl();
    const willPayload = JSON.stringify({
      peerId: myIdRef.current,
      online: false,
    });

    const client = mqtt.connect(brokerUrl, {
      clientId: myIdRef.current,
      clean: true,
      keepalive: 30,
      reconnectPeriod: 1000,
      connectTimeout: 10_000,
      protocolVersion: 5,
      will: {
        topic: presenceTopic(rid),
        payload: willPayload,
        qos: 1,
        retain: false,
      },
    });
    clientRef.current = client;

    const handleConnect = () => {
      setConnected(true);
      try {
        client.subscribe(syncTopic(rid), { qos: 1 });
        client.subscribe(stateTopic(rid), { qos: 1 });
        client.subscribe(presenceTopic(rid), { qos: 1 });
        client.subscribe(dmTopic(rid, myIdRef.current), { qos: 1 });
      } catch {
        /* noop */
      }
      cbRef.current.onConnected(isHostRef.current);
      try {
        const presencePayload = JSON.stringify({
          peerId: myIdRef.current,
          name: cbRef.current.displayName,
          online: true,
        });
        client.publish(presenceTopic(rid), presencePayload, { qos: 1, retain: false });
      } catch {
        /* noop */
      }
    };

    const handlePresence = (parsed: unknown) => {
      if (!isPresenceMessage(parsed)) return;
      if (parsed.peerId === myIdRef.current) return;

      if (isHostRef.current) {
        if (parsed.online) {
          cbRef.current.onGuestConnected(parsed.peerId, parsed.name ?? 'Guest');
        } else {
          cbRef.current.onGuestDisconnected(parsed.peerId);
        }
        return;
      }

      // Guests rely on the host's PARTICIPANTS updates for other guests; only
      // the host going offline (or its clean shutdown) matters here.
      if (!parsed.online && parsed.peerId === roomIdRef.current) {
        cbRef.current.onHostDisconnected();
      }
    };

    const handleMessage = (topic: string, payload: Uint8Array | Buffer) => {
      try {
        const raw = payload.toString();
        const parsed: unknown = JSON.parse(raw);
        if (topic === presenceTopic(rid)) {
          handlePresence(parsed);
          return;
        }
        if (!isSyncMessage(parsed)) return;
        if (parsed.senderId === myIdRef.current) return;
        cbRef.current.onMessage(parsed, parsed.senderId ?? 'unknown');
      } catch {
        console.warn('[mqtt] malformed message ignored');
      }
    };

    const handleClose = () => {
      setConnected(false);
      if (!isHostRef.current) {
        cbRef.current.onHostDisconnected();
      }
    };

    client.on('connect', handleConnect);
    client.on('message', handleMessage);
    client.on('close', handleClose);
    client.on('offline', handleClose);
    client.on('error', handleClose);

    return () => {
      try {
        client.removeListener('connect', handleConnect);
        client.removeListener('message', handleMessage);
        client.removeListener('close', handleClose);
        client.removeListener('offline', handleClose);
        client.removeListener('error', handleClose);
      } catch {
        /* noop */
      }
      try {
        const presencePayload = JSON.stringify({
          peerId: myIdRef.current,
          online: false,
        });
        client.publish(presenceTopic(rid), presencePayload, { qos: 1, retain: false });
      } catch {
        /* noop */
      }
      try {
        client.end(true);
      } catch {
        /* noop */
      }
      clientRef.current = null;
      setConnected(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  return {
    isHost,
    myId,
    roomId,
    connected,
    topology: 'bus',
    broadcast,
    sendTo,
    callPeer,
    onCall,
    reconnect,
  };
}

export const createMqttTransport = useMqttTransport;
