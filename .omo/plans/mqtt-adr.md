# ADR: MQTT Sync Transport for co-viewer

**Status:** Proposed
**Date:** 2026-09-06
**Decision: hybrid — MQTT sync behind VITE_TRANSPORT, voice stays PeerJS**

---

## 1. Context

- Repo is **Vite + React + TS** static SPA deployed to **GitHub Pages** (`base: './'`). No server.
- Current transport is **PeerJS star topology**: `hostId == roomId` (`src/hooks/usePeer.ts:17-27`), `Peer` owns room, guests `peer.connect(hostId)`.
- Problems to solve: PeerJS cloud broker flakiness under load, NAT/firewall traversal fragility for `DataChannel`, host-leave kills room (no retained state), scale beyond single-star fan-out.
- Constraint: **HTTPS mixed-content** — GitHub Pages is HTTPS, so MQTT must be **WSS** (not `ws://` / `mqtt://`).
- Goal: evaluate MQTT as sync/data plane replacement while keeping voice on WebRTC (`MediaConnection`), behind a `VITE_TRANSPORT` feature flag. **Do not install `package.json` yet** — ADR only.

Relevant contracts:

- `src/types/index.ts:27-75` — `SyncMessage` union (`PLAY`/`PAUSE`/`SEEK`/`SYNC_PING`/`QUEUE_UPDATE`/`STATE_SNAPSHOT`/...) + `QueueItem` + `SYNC_DRIFT_THRESHOLD`/`SYNC_PING_INTERVAL`.
- `src/hooks/usePeer.ts:17-27` — `UsePeerResult` (`broadcast`, `sendTo`, `callPeer`, `onCall`, `reconnect`) — adapter must preserve this surface.

---

## 2. Brokers (Public, WSS-only)

All three expose **WSS** for browser use over HTTPS. Public brokers are **best-effort, no SLA** — acceptable for feasibility PoC, not prod without self-hosted fallback.

| Broker | WSS Endpoint | Port | Path | Notes |
|---|---|---|---|---|
| **HiveMQ** | `wss://broker.hivemq.com:8884/mqtt` | 8884 | `/mqtt` | HiveMQ Cloud public broker; stable, moderate limits |
| **EMQX** | `wss://broker.emqx.io:8084/mqtt` | 8084 | `/mqtt` | EMQX public broker; high throughput; earlier finding: `8084` is WSS |
| **Mosquitto** | `wss://test.mosquitto.org:8081` | 8081 | `/` (root, no `/mqtt`) | Eclipse test.mosquitto.org; least stable, lowest limits; verify path = `8081` wss |

> Selection: default `VITE_MQTT_URL=wss://broker.emqx.io:8084/mqtt` (EMQX), fallback to HiveMQ `8884/mqtt`. Mosquitto as last resort. All `wss://` required — plain `ws://:1883` blocked by mixed-content.

Env:

```ts
VITE_TRANSPORT=peer | mqtt   // default peer
VITE_MQTT_URL=wss://broker.emqx.io:8084/mqtt
```

---

## 3. Client Library: mqtt.js vs Paho

| Dimension | **mqtt.js 5.x** (`mqtt`) | **Eclipse Paho JS** (`paho-mqtt`) |
|---|---|---|
| Protocol | MQTT 5.0 + 3.1.1 (5.0 preferred) | MQTT 3.1.1 only (no v5) |
| Bundle size | ~30-40 kB gzipped, tree-shakable | Smaller but unmaintained feel |
| Maintained | Active (mqttjs/mqtt), TS types included | Low velocity, community fork |
| WSS | `mqtt.connect('wss://.../mqtt')` native | `Paho.Client(host, port, id)` with `useSSL:true` |
| Will / Retained | `will`, `retain` first-class options | Supported but verbose API |
| Reconnect | `reconnectPeriod`, `keepalive` built-in | Manual `onConnectionLost` + re-call |
| Wildcard sub | `client.subscribe('co-viewer/+/sync')` | Same, callback style |
| Vite compat | ESM, works with Vite (polyfill `Buffer` if needed) | Older UMD, needs shim |
| Verdict | **Recommended** | Not recommended |

Decision: **mqtt.js 5.x**. Earlier librarian finding confirmed `mqtt.js 5.x`, `will` topic, retained snapshot.

Install later (not now):

```bash
npm i mqtt
```

---

## 4. WebRTC DataChannel vs MQTT

| Dimension | **WebRTC DataChannel (PeerJS)** | **MQTT over WSS** |
|---|---|---|
| **Latency** | ~20-80 ms P2P direct (ideal); 100-300 ms via TURN relay | ~30-120 ms via broker hop (TLS+TCP); consistent but not P2P |
| **Reliability** | Unreliable by default unless `ordered:true`/`reliable:true`; loss on flaky NAT; no persistence | QoS 0/1/2 + retained + LWT; broker stores last snapshot |
| **Broker deps** | PeerJS cloud broker (signaling only) + STUN/TURN; broker down = no new joins | MQTT broker is data plane; broker down = no sync (mitigate with multi-URL fallback) |
| **NAT / Firewall** | Requires STUN + TURN (`openrelay.metered.ca` in `usePeer.ts:179-198`); symmetric NAT / corp firewall often blocks | **Works through NAT/firewall**: single outbound WSS (443/8884/8084) over TLS; no hole-punching |
| **Host-leave** | Room dies (hostId == roomId, star); late joiners get nothing | Retained `STATE_SNAPSHOT` survives host-leave briefly; late joiner gets state immediately |
| **Ordering** | Per-channel ordered if configured | Per-topic ordered per QoS; broker guarantees order per client |
| **Throughput** | High (binary, P2P) | Small JSON msgs (<2 kB) fine; large not suited |
| **Ops** | Zero broker ops if PeerJS cloud ok; TURN quota | Need broker health check / failover list |

Takeaway: MQTT wins on **NAT traversal + late-join + ops simplicity** for small sync messages; WebRTC wins on **sub-50ms P2P latency + no broker in data path + media**.

---

## 5. Topic Design

Namespace: `co-viewer/{roomId}/...` — `roomId` is existing PeerJS `roomId` (opaque string, no slash).

| Topic | Purpose | Retained | QoS | Payload |
|---|---|---|---|---|
| `co-viewer/{roomId}/sync` | Transient sync events: `PLAY`/`PAUSE`/`SEEK`/`SYNC_PING`/VC/role/name | No | See §6 | `SyncMessage` JSON |
| `co-viewer/{roomId}/state` | **Retained snapshot**: last `STATE_SNAPSHOT` (+ `QUEUE_UPDATE`) for late joiners | **Yes** | 1 | `STATE_SNAPSHOT` JSON |
| `co-viewer/{roomId}/presence` | Per-peer presence + **LWT** will | No (will retained false) | 1 | `{ peerId, name, online: boolean }` |

Conventions:

- Single `sync` topic for all transient messages (simple ACL). Alternative `sync/{peerId}` split is overkill for <20 peers.
- `state` **retained** so new subscriber gets immediate snapshot without `REQUEST_STATE` round-trip (fallback still supports `REQUEST_STATE`).
- `presence` uses **MQTT Will**: `will: { topic: co-viewer/{roomId}/presence, payload: { peerId, online:false }, qos:1, retain:false }` — broker auto-publishes on ungraceful disconnect.

Room isolation: topic is scoped by `roomId`; public broker shared, but no cross-room leak. For prod, prefix with `co-viewer-v2/` or add ACL if self-hosted.

---

## 6. QoS Decisions

| Message type (`src/types/index.ts:27-75`) | QoS | Retained | Rationale |
|---|---|---|---|
| `PLAY` | **1** | No | Must arrive; at-least-once ok (idempotent seek+play) |
| `PAUSE` | **1** | No | Must arrive |
| `SEEK` | **1** | No | Must arrive; deduped by `currentTime` |
| `SYNC_PING` | **0** | No | Periodic (3 s), loss-tolerant; QoS0 reduces overhead |
| `QUEUE_UPDATE` | **1** | **Yes** (via `/state`) | Authoritative queue; retained snapshot covers it |
| `STATE_SNAPSHOT` | **1** | **Yes** (`/state`) | Late-join bootstrap; retained |
| `ROLE_UPDATE`/`PARTICIPANTS`/`NAME_UPDATE` | 1 | No | Must arrive; small |
| `REQUEST_STATE` | 1 | No | Request/response |
| `VC_STATE`/`VC_PEER`/`DRIVE_MODE` | 1 | No | Control plane |

- QoS 2 not used — at-least-once suffices; exactly-once unnecessary for idempotent sync.
- `SYNC_PING` is the only QoS0 to keep broker load low.

---

## 7. Hybrid Decision

**MQTT for sync + keep PeerJS `MediaConnection` for voice.**

- `DataChannel` sync → MQTT topics (`sync` + `state`).
- Voice stays `peer.call(peerId, stream)` / `peer.on('call')` (`src/hooks/usePeer.ts:24-25`). MQTT cannot carry media.
- Flag: `VITE_TRANSPORT=mqtt` switches sync plane; voice path unchanged regardless of flag.
- Peer instance still created for voice when `mqtt` mode (lightweight, no `DataConnection` used).

Benefit: NAT-proof sync with late-join; voice keeps low-latency WebRTC.

---

## 8. Adapter Interface Sketch

Preserve `UsePeerResult` surface (`src/hooks/usePeer.ts:17-27`) via `TransportAdapter`.

```ts
// src/transports/TransportAdapter.ts
import type { SyncMessage } from '../types';
import type { MediaConnection } from 'peerjs';

export interface TransportAdapter {
  isHost: boolean;
  myId: string | null;
  roomId: string | null;
  connected: boolean;
  broadcast(msg: SyncMessage): void;
  sendTo(peerId: string, msg: SyncMessage): void; // MQTT: publish to sync (no per-peer), or no-op if broadcast-only
  callPeer(peerId: string, stream: MediaStream): MediaConnection | null;
  onCall(cb: (call: MediaConnection) => void): void;
  reconnect(): void;
  dispose(): void;
}

// Factory
export function createTransport(opts: UsePeerOptions): TransportAdapter {
  return import.meta.env.VITE_TRANSPORT === 'mqtt'
    ? createMqttTransport(opts)
    : createPeerTransport(opts); // existing usePeer logic
}
```

MQTT implementation sketch:

```ts
import mqtt from 'mqtt';

const client = mqtt.connect('wss://broker.emqx.io:8084/mqtt', {
  clientId: `cv_${roomId}_${peerId}_${Date.now()}`,
  keepalive: 30,
  reconnectPeriod: 1000,
  connectTimeout: 10_000,
  protocolVersion: 5,
  clean: true,
  will: {
    topic: `co-viewer/${roomId}/presence`,
    payload: Buffer.from(JSON.stringify({ peerId: myId, name: displayName, online: false })),
    qos: 1 as const,
    retain: false,
  },
});

client.on('connect', () => {
  client.subscribe(`co-viewer/${roomId}/sync`, { qos: 1 });
  client.subscribe(`co-viewer/${roomId}/state`, { qos: 1 });
  client.subscribe(`co-viewer/${roomId}/presence`, { qos: 1 });
  // publish presence online + publish retained state if host
});

function broadcast(msg: SyncMessage) {
  const topic = msg.type === 'STATE_SNAPSHOT' || msg.type === 'QUEUE_UPDATE'
    ? `co-viewer/${roomId}/state`
    : `co-viewer/${roomId}/sync`;
  const opts = topic.endsWith('/state') ? { qos: 1 as const, retain: true } : { qos: (msg.type === 'SYNC_PING' ? 0 : 1) as 0 | 1 };
  client.publish(topic, JSON.stringify(msg), opts);
}
client.on('message', (topic, payload) => {
  const msg = JSON.parse(payload.toString()) as SyncMessage;
  if (msg.senderId === myId) return; // ignore echo
  onMessage(msg, msg.senderId);
});
```

Notes: `sendTo` maps to `publish(sync)` with filter by `targetPeerId` inside `ROLE_UPDATE`; true DM not needed for co-viewer star. Voice `callPeer`/`onCall` delegates to a minimal `Peer` instance (no data conn).

---

## 9. Effort / Rollback

| Phase | Effort |
|---|---|
| ADR + flag scaffolding | 0.5 d |
| `TransportAdapter` + `createMqttTransport` + `createPeerTransport` extraction | 1-2 d |
| QoS/retain/presence/will + late-join + reconnect + multi-broker fallback | 1 d |
| E2E: 2-tab sync (PLAY/PAUSE/SEEK/SYNC_PING drift, QUEUE, late-join retained) | 1 d |
| Total | **3-4.5 d** |

Rollback:

- `VITE_TRANSPORT=peer` (default) — no behavior change; MQTT code tree-shaken if unused.
- Revert: delete `src/transports/` + env, restore `usePeer` direct import. No `package.json` change to revert if `mqtt` not yet installed; after install, `npm rm mqtt` + remove env.
- Public broker outage: fallback list `[EMQX 8084, HiveMQ 8884, Mosquitto 8081]` with `reconnectPeriod: 1000` + UI toast "sync degraded".

---

## 10. References

- `src/types/index.ts:27-75` — `SyncMessage` union, `QueueItem`, `SYNC_DRIFT_THRESHOLD`, `SYNC_PING_INTERVAL`.
- `src/hooks/usePeer.ts:17-27` — `UsePeerResult` (`broadcast`/`sendTo`/`callPeer`/`onCall`/`reconnect`) and star `hostId==roomId`.
- mqtt.js 5.x docs: `mqtt.connect(url, { keepalive, reconnectPeriod, will })`, WSS path `/mqtt`.
- Public brokers: HiveMQ `wss://broker.hivemq.com:8884/mqtt`, EMQX `wss://broker.emqx.io:8084/mqtt`, Mosquitto `wss://test.mosquitto.org:8081` (WSS, HTTPS-only).
- Prior librarian findings: EMQX 8084 WSS, HiveMQ 8884 WSS, mqtt.js 5.x, will topic, retained snapshot.

---

## 11. Open Questions

- Self-hosted broker (Fly.io / EMQX Cloud) for prod SLA vs public best-effort.
- `roomId` entropy vs topic enumeration on public broker (not sensitive, but consider hash prefix).
- `sendTo` semantics under MQTT — keep broadcast-only vs add `co-viewer/{roomId}/dm/{peerId}` if needed.
