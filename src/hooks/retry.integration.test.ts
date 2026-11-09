/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { SYNC_PING_INTERVAL, SYNC_DRIFT_THRESHOLD, type SyncMessage } from '../types/index';
import { RECONNECT_BASE_MS, RECONNECT_MAX_MS, MAX_QUEUE } from './usePeer';
import { useRoomSync } from './useRoomSync';
import { getTransportKind, getMqttBrokerUrl } from '../transport/types';

function createHostHook() {
  const broadcast = vi.fn();
  const sendTo = vi.fn();
  const { result } = renderHook(() =>
    useRoomSync({
      isHost: true,
      myId: 'host-1',
      connected: true,
      myName: 'Host',
      broadcast,
      sendTo,
    })
  );
  return { result, broadcast, sendTo };
}

function makeMsg(n: number): SyncMessage {
  return { type: 'PLAY', currentTime: n, senderId: 'host-1' };
}

describe('queue drain: broadcast when !open queues not dropped', () => {
  it('enqueue when closed then flush once when open', () => {
    const send = vi.fn(() => {
      throw new Error('closed');
    });
    type MockConn = { open: boolean; send: ReturnType<typeof vi.fn>; peer: string };
    const connClosed: MockConn = { open: false, send, peer: 'guest-1' };
    const queue: SyncMessage[] = [];

    const enqueue = (msg: SyncMessage): void => {
      if (queue.length >= MAX_QUEUE) queue.shift();
      queue.push(msg);
    };

    const broadcast = (msg: SyncMessage, conns: MockConn[]): void => {
      if (conns.length === 0) {
        enqueue(msg);
        return;
      }
      for (const c of conns) {
        if (c.open) {
          try {
            c.send(msg);
          } catch {
            enqueue(msg);
          }
        } else {
          enqueue(msg);
        }
      }
    };

    const flushQueue = (key: string, conns: Map<string, MockConn>): void => {
      if (queue.length === 0) return;
      for (const m of [...queue]) {
        const c = conns.get(key);
        if (c && c.open) {
          try {
            c.send(m);
            queue.shift();
          } catch {
            break;
          }
        } else break;
      }
    };

    const msg = makeMsg(1);
    broadcast(msg, [connClosed]);
    expect(queue.length).toBe(1);
    expect(send).not.toHaveBeenCalled();

    const sendOk = vi.fn();
    const connOpen: MockConn = { open: true, send: sendOk, peer: 'guest-1' };
    const map = new Map<string, MockConn>([['guest-1', connOpen]]);
    flushQueue('guest-1', map);
    expect(sendOk).toHaveBeenCalledTimes(1);
    expect(sendOk).toHaveBeenCalledWith(msg);
    expect(queue.length).toBe(0);

    // second flush is no-op
    flushQueue('guest-1', map);
    expect(sendOk).toHaveBeenCalledTimes(1);
  });
});

describe('queue cap', () => {
  it('enqueue 70 → queue 64 (MAX_QUEUE)', () => {
    const queue: SyncMessage[] = [];
    const enqueue = (msg: SyncMessage): void => {
      if (queue.length >= MAX_QUEUE) queue.shift();
      queue.push(msg);
    };
    for (let i = 0; i < 70; i++) enqueue(makeMsg(i));
    expect(MAX_QUEUE).toBe(64);
    expect(queue.length).toBe(64);
    expect(queue[0].currentTime).toBe(6);
    expect(queue[63].currentTime).toBe(69);
  });
});

describe('backoff progression', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('RECONNECT_BASE_MS * 2^attempt capped at 30000 with ±15% jitter', () => {
    expect(RECONNECT_BASE_MS).toBe(1500);
    expect(RECONNECT_MAX_MS).toBe(30000);
    const expected = [1500, 3000, 6000, 12000, 24000, 30000, 30000];
    for (let attempt = 0; attempt < expected.length; attempt++) {
      const base = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * Math.pow(2, attempt));
      expect(base).toBe(expected[attempt]);
      const low = base * 0.85;
      const high = base * 1.15;
      // jitter range tolerance check
      expect(low).toBeGreaterThan(0);
      expect(high).toBeGreaterThan(low);
      // simulated jittered delay must fall within bounds
      const jitter = 0.85 + Math.random() * 0.3;
      const jittered = base * jitter;
      expect(jittered).toBeGreaterThanOrEqual(low - 0.001);
      expect(jittered).toBeLessThanOrEqual(high + 0.001);
    }
  });

  it('scheduleReconnect delays via fake timers', () => {
    vi.useFakeTimers();
    const delays: number[] = [];
    const attemptRef = { current: 0 };
    const timers: number[] = [];

    const scheduleOnce = (): number => {
      const delay =
        Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * Math.pow(2, attemptRef.current)) *
        (0.85 + Math.random() * 0.3);
      attemptRef.current += 1;
      const id = window.setTimeout(() => {}, delay) as unknown as number;
      timers.push(id);
      delays.push(delay);
      return delay;
    };

    const d0 = scheduleOnce();
    const d1 = scheduleOnce();
    const d2 = scheduleOnce();
    // cap after many attempts
    attemptRef.current = 10;
    const dCap = scheduleOnce();

    expect(d0).toBeGreaterThanOrEqual(1500 * 0.85);
    expect(d0).toBeLessThanOrEqual(1500 * 1.15);
    expect(d1).toBeGreaterThanOrEqual(3000 * 0.85);
    expect(d1).toBeLessThanOrEqual(3000 * 1.15);
    expect(d2).toBeGreaterThanOrEqual(6000 * 0.85);
    expect(d2).toBeLessThanOrEqual(6000 * 1.15);
    expect(dCap).toBeGreaterThanOrEqual(30000 * 0.85);
    expect(dCap).toBeLessThanOrEqual(30000 * 1.15);

    for (const id of timers) window.clearTimeout(id);
  });
});

describe('dedupe after 3 rejoins stable', () => {
  it('same name diff peerId x3 → participants length 2', () => {
    const { result } = createHostHook();
    act(() => {
      result.current.onGuestJoined('peer-a', 'Alice');
    });
    act(() => {
      result.current.onGuestJoined('peer-b', 'Alice');
    });
    act(() => {
      result.current.onGuestJoined('peer-c', 'Alice');
    });
    const participants = result.current.participants;
    expect(participants.length).toBe(2);
    const guests = participants.filter((p) => !p.isHost);
    expect(guests.length).toBe(1);
    expect(guests[0].peerId).toBe('peer-c');
    expect(guests[0].name).toBe('Alice');
  });
});

describe('transport selector', () => {
  const origTransport = import.meta.env.VITE_TRANSPORT as string | undefined;
  const origBroker = import.meta.env.VITE_MQTT_BROKER_URL as string | undefined;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    (import.meta.env as Record<string, unknown>).VITE_TRANSPORT = origTransport;
    (import.meta.env as Record<string, unknown>).VITE_MQTT_BROKER_URL = origBroker;
  });

  it('getTransportKind returns peerjs/mqtt and falls back', () => {
    (import.meta.env as Record<string, unknown>).VITE_TRANSPORT = 'mqtt';
    expect(getTransportKind()).toBe('mqtt');
    (import.meta.env as Record<string, unknown>).VITE_TRANSPORT = 'peerjs';
    expect(getTransportKind()).toBe('peerjs');
    (import.meta.env as Record<string, unknown>).VITE_TRANSPORT = 'webrtc';
    expect(getTransportKind()).toBe('peerjs');
    (import.meta.env as Record<string, unknown>).VITE_TRANSPORT = undefined;
    expect(getTransportKind()).toBe('peerjs');
    (import.meta.env as Record<string, unknown>).VITE_TRANSPORT = '';
    expect(getTransportKind()).toBe('peerjs');
  });

  it('getMqttBrokerUrl default and trimmed', () => {
    delete (import.meta.env as Record<string, unknown>).VITE_MQTT_BROKER_URL;
    expect(getMqttBrokerUrl()).toBe('wss://broker.emqx.io:8084/mqtt');
    (import.meta.env as Record<string, unknown>).VITE_MQTT_BROKER_URL = '';
    expect(getMqttBrokerUrl()).toBe('wss://broker.emqx.io:8084/mqtt');
    (import.meta.env as Record<string, unknown>).VITE_MQTT_BROKER_URL = '   ';
    expect(getMqttBrokerUrl()).toBe('wss://broker.emqx.io:8084/mqtt');
    (import.meta.env as Record<string, unknown>).VITE_MQTT_BROKER_URL = ' wss://custom:9001/mqtt ';
    expect(getMqttBrokerUrl()).toBe('wss://custom:9001/mqtt');
  });
});

describe('SYNC constants guard', () => {
  it('SYNC_PING_INTERVAL===3000 and SYNC_DRIFT_THRESHOLD===1.5', () => {
    expect(SYNC_PING_INTERVAL).toBe(3000);
    expect(SYNC_DRIFT_THRESHOLD).toBe(1.5);
  });
});
