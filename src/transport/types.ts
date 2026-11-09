import type { SyncMessage } from '../types';

/**
 * Minimal media-call handle for transport-agnostic voice.
 * Mirrors the PeerJS MediaConnection surface used by useVoiceChat
 * without importing `peerjs` directly — peerjs stays isolated to usePeer.ts.
 */
export interface TransportMediaCall {
  readonly peer: string;
  answer(stream?: MediaStream): void;
  close(): void;
  on(event: string, callback: (...args: unknown[]) => void): void;
  off?(event: string, callback: (...args: unknown[]) => void): void;
}

export type TransportKind = 'peerjs' | 'mqtt';

/**
 * TransportOptions mirrors UsePeerOptions (src/hooks/usePeer.ts:6-15)
 * but remains transport-agnostic. No peerjs types leak here.
 */
export interface TransportOptions {
  roomIdFromUrl: string | null;
  displayName: string;
  onMessage: (msg: SyncMessage, fromPeerId: string) => void;
  onGuestConnected: (peerId: string, name: string) => void;
  onGuestDisconnected: (peerId: string) => void;
  onHostDisconnected: () => void;
  onConnected: (isHost: boolean) => void;
  onCall?: (call: TransportMediaCall) => void;
}

/**
 * Transport mirrors UsePeerResult (src/hooks/usePeer.ts:17-27) and
 * PlayerController pattern (src/types/index.ts:99-111): a uniform
 * control surface consumed via DI (App.tsx:82-107). Only broadcast/sendTo
 * are required by useRoomSync — voice (`callPeer`/`onCall`) and
 * lifecycle (`dispose`/`pendingQueue`) are optional for future transports.
 */
export interface Transport {
  readonly isHost: boolean;
  readonly myId: string | null;
  readonly roomId: string | null;
  readonly connected: boolean;
  broadcast(msg: SyncMessage): void;
  sendTo(peerId: string, msg: SyncMessage): void;
  callPeer?(peerId: string, stream: MediaStream): TransportMediaCall | null;
  onCall?(cb: (call: TransportMediaCall) => void): void;
  reconnect(): void;
  dispose?: () => void;
  pendingQueue?: readonly SyncMessage[];
}

/** Factory signatures for transport selection via VITE_TRANSPORT. */
export type TransportFactory = (options: TransportOptions) => Transport;
export type CreatePeerTransport = TransportFactory;
export type CreateMqttTransport = TransportFactory;

/**
 * Env guard for transport selection.
 * Reads `import.meta.env.VITE_TRANSPORT` and falls back to 'peerjs'.
 * Only 'peerjs' and 'mqtt' are accepted; any other value returns 'peerjs'.
 */
export function getTransportKind(): TransportKind {
  const raw = import.meta.env.VITE_TRANSPORT;
  if (raw === 'mqtt' || raw === 'peerjs') return raw;
  return 'peerjs';
}

/**
 * MQTT broker URL helper.
 * Reads `import.meta.env.VITE_MQTT_BROKER_URL` and falls back to public EMQX broker.
 */
export function getMqttBrokerUrl(): string {
  const raw = import.meta.env.VITE_MQTT_BROKER_URL as unknown as string | undefined;
  if (typeof raw !== 'string') return 'wss://broker.emqx.io:8084/mqtt';
  const trimmed = raw.trim();
  if (!trimmed || trimmed === 'undefined' || trimmed === 'null') return 'wss://broker.emqx.io:8084/mqtt';
  return trimmed;
}
