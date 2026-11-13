/**
 * Transport abstraction entry point.
 *
 * - Re-exports transport-agnostic types from ./types
 * - Re-exports the PeerJS implementation as createPeerTransport without
 *   importing `peerjs` directly — isolation stays in src/hooks/usePeer.ts
 * - Provides a not-yet-implemented MQTT stub and an env guard
 *   `getTransportKind()` reading `import.meta.env.VITE_TRANSPORT`.
 *
 * No runtime change: App.tsx continues to import from hooks/usePeer.
 * Future T10 will switch App wiring to `getTransportKind()` + factories.
 */

export type {
  Transport,
  TransportOptions,
  TransportKind,
  TransportTopology,
  TransportFactory,
  CreatePeerTransport,
  CreateMqttTransport,
  TransportMediaCall,
} from './types';

// PeerJS factory — currently just a re-export of the existing hook.
// Keeps `peerjs` imports confined to src/hooks/usePeer.ts.
export { usePeer as createPeerTransport } from '../hooks/usePeer';

export { useMqttTransport, createMqttTransport } from './mqtt';

export { getTransportKind, getMqttBrokerUrl } from './types';
