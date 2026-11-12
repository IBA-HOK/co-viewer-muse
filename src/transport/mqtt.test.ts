import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

// Mock mqtt.js — must be hoisted before imports
vi.mock('mqtt', () => ({
  default: {
    connect: vi.fn(() => ({
      on: vi.fn(),
      subscribe: vi.fn(),
      publish: vi.fn(),
      end: vi.fn(),
      removeListener: vi.fn(),
      reconnect: vi.fn(),
    })),
  },
}));

import mqtt from 'mqtt';
import { useMqttTransport } from './mqtt';
import type { SyncMessage } from '../types';

function getMockClient() {
  const connectMock = vi.mocked(mqtt.connect);
  const lastCall = connectMock.mock.results[connectMock.mock.results.length - 1];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return lastCall?.value as any;
}

function getOnHandler(client: { on: ReturnType<typeof vi.fn> }, event: string) {
  const calls = (client.on as ReturnType<typeof vi.fn>).mock.calls as [string, (...args: unknown[]) => void][];
  const entry = calls.find(([e]) => e === event);
  return entry?.[1] ?? null;
}

describe('useMqttTransport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('broadcast QUEUE_UPDATE with qos1 retain true to state topic', () => {
    const onMessage = vi.fn();
    const onConnected = vi.fn();
    const { result } = renderHook(() =>
      useMqttTransport({
        roomIdFromUrl: null,
        displayName: 'Host',
        onMessage,
        onGuestConnected: vi.fn(),
        onGuestDisconnected: vi.fn(),
        onHostDisconnected: vi.fn(),
        onConnected,
      })
    );

    const roomId = result.current.roomId as string;
    expect(roomId).toBeTruthy();

    const client = getMockClient();
    expect(client).toBeDefined();

    const msg: SyncMessage = {
      type: 'QUEUE_UPDATE',
      queue: [],
      currentId: null,
      currentTime: 0,
      senderId: result.current.myId as string,
    };

    act(() => {
      result.current.broadcast(msg);
    });

    expect(client.publish).toHaveBeenCalledTimes(1);
    const [topic, payload, opts] = client.publish.mock.calls[0] as [string, string, { qos: number; retain: boolean }];
    expect(topic).toBe(`co-viewer/${roomId}/state`);
    expect(opts.qos).toBe(1);
    expect(opts.retain).toBe(true);
    expect(JSON.parse(payload as string).type).toBe('QUEUE_UPDATE');
  });

  it('broadcast SYNC_PING with qos0 retain false to sync topic', () => {
    const { result } = renderHook(() =>
      useMqttTransport({
        roomIdFromUrl: 'guest-room-123',
        displayName: 'Guest',
        onMessage: vi.fn(),
        onGuestConnected: vi.fn(),
        onGuestDisconnected: vi.fn(),
        onHostDisconnected: vi.fn(),
        onConnected: vi.fn(),
      })
    );

    const roomId = result.current.roomId as string;
    expect(roomId).toBe('guest-room-123');

    const client = getMockClient();
    const msg: SyncMessage = {
      type: 'SYNC_PING',
      currentTime: 10,
      isPlaying: true,
      senderId: result.current.myId as string,
    };

    act(() => {
      result.current.broadcast(msg);
    });

    expect(client.publish).toHaveBeenCalledTimes(1);
    const [topic, , opts] = client.publish.mock.calls[0] as [string, string, { qos: number; retain: boolean }];
    expect(topic).toBe(`co-viewer/${roomId}/sync`);
    expect(opts.qos).toBe(0);
    expect(opts.retain).toBe(false);
  });

  it('sendTo publishes to dm topic with qos1 retain false', () => {
    const { result } = renderHook(() =>
      useMqttTransport({
        roomIdFromUrl: null,
        displayName: 'Host',
        onMessage: vi.fn(),
        onGuestConnected: vi.fn(),
        onGuestDisconnected: vi.fn(),
        onHostDisconnected: vi.fn(),
        onConnected: vi.fn(),
      })
    );

    const roomId = result.current.roomId as string;
    const client = getMockClient();
    const msg: SyncMessage = {
      type: 'PLAY',
      currentTime: 5,
      senderId: result.current.myId as string,
    };

    act(() => {
      result.current.sendTo('peer-xyz', msg);
    });

    expect(client.publish).toHaveBeenCalledTimes(1);
    const [topic, , opts] = client.publish.mock.calls[0] as [string, string, { qos: number; retain: boolean }];
    expect(topic).toBe(`co-viewer/${roomId}/dm/peer-xyz`);
    expect(opts.qos).toBe(1);
    expect(opts.retain).toBe(false);
  });

  it('malformed JSON message does not throw and does not call onMessage', () => {
    const onMessage = vi.fn();
    renderHook(() =>
      useMqttTransport({
        roomIdFromUrl: null,
        displayName: 'Host',
        onMessage,
        onGuestConnected: vi.fn(),
        onGuestDisconnected: vi.fn(),
        onHostDisconnected: vi.fn(),
        onConnected: vi.fn(),
      })
    );

    const client = getMockClient();
    const handler = getOnHandler(client, 'message');
    expect(handler).not.toBeNull();

    expect(() => {
      // malformed JSON
      handler?.('co-viewer/room/sync', Buffer.from('not-json{{{'));
      // valid JSON but missing .type
      handler?.('co-viewer/room/sync', Buffer.from(JSON.stringify({ foo: 'bar' })));
      // valid SyncMessage but will be ignored if senderId equals myId is checked — we use different sender
      // ensure it still works for good message
    }).not.toThrow();

    expect(onMessage).not.toHaveBeenCalled();
  });

  it('valid JSON with type forwards to onMessage', () => {
    const onMessage = vi.fn();
    const { result } = renderHook(() =>
      useMqttTransport({
        roomIdFromUrl: null,
        displayName: 'Host',
        onMessage,
        onGuestConnected: vi.fn(),
        onGuestDisconnected: vi.fn(),
        onHostDisconnected: vi.fn(),
        onConnected: vi.fn(),
      })
    );

    const client = getMockClient();
    const handler = getOnHandler(client, 'message');
    expect(handler).not.toBeNull();

    const valid: SyncMessage = {
      type: 'PAUSE',
      currentTime: 12,
      senderId: 'other-peer',
    };

    act(() => {
      handler?.('co-viewer/room/sync', Buffer.from(JSON.stringify(valid)));
    });

    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage).toHaveBeenCalledWith(valid, 'other-peer');
    void result;
  });

  it('ignores own senderId echo', () => {
    const onMessage = vi.fn();
    const { result } = renderHook(() =>
      useMqttTransport({
        roomIdFromUrl: null,
        displayName: 'Host',
        onMessage,
        onGuestConnected: vi.fn(),
        onGuestDisconnected: vi.fn(),
        onHostDisconnected: vi.fn(),
        onConnected: vi.fn(),
      })
    );

    const myId = result.current.myId as string;
    const client = getMockClient();
    const handler = getOnHandler(client, 'message');
    const echo: SyncMessage = { type: 'PLAY', currentTime: 0, senderId: myId };
    handler?.('co-viewer/room/sync', Buffer.from(JSON.stringify(echo)));
    expect(onMessage).not.toHaveBeenCalled();
  });

  it('host handles online presence once with the peer name and ignores itself', () => {
    const onGuestConnected = vi.fn();
    const { result } = renderHook(() =>
      useMqttTransport({
        roomIdFromUrl: null,
        displayName: 'Host',
        onMessage: vi.fn(),
        onGuestConnected,
        onGuestDisconnected: vi.fn(),
        onHostDisconnected: vi.fn(),
        onConnected: vi.fn(),
      })
    );

    const client = getMockClient();
    const handler = getOnHandler(client, 'message');
    const presenceTopic = `co-viewer/${result.current.roomId}/presence`;

    act(() => {
      handler?.(
        presenceTopic,
        Buffer.from(JSON.stringify({ peerId: 'guest-1', name: 'Alice', online: true }))
      );
      handler?.(
        presenceTopic,
        Buffer.from(
          JSON.stringify({ peerId: result.current.myId, name: 'Host', online: true })
        )
      );
    });

    expect(onGuestConnected).toHaveBeenCalledTimes(1);
    expect(onGuestConnected).toHaveBeenCalledWith('guest-1', 'Alice');
  });

  it('host falls back to Guest when online presence has no name', () => {
    const onGuestConnected = vi.fn();
    const { result } = renderHook(() =>
      useMqttTransport({
        roomIdFromUrl: null,
        displayName: 'Host',
        onMessage: vi.fn(),
        onGuestConnected,
        onGuestDisconnected: vi.fn(),
        onHostDisconnected: vi.fn(),
        onConnected: vi.fn(),
      })
    );

    const client = getMockClient();
    const handler = getOnHandler(client, 'message');
    const presenceTopic = `co-viewer/${result.current.roomId}/presence`;

    act(() => {
      handler?.(presenceTopic, Buffer.from(JSON.stringify({ peerId: 'guest-1', online: true })));
    });

    expect(onGuestConnected).toHaveBeenCalledWith('guest-1', 'Guest');
  });

  it('host disconnects guests on offline presence, but guests ignore other guests', () => {
    const hostOnGuestDisconnected = vi.fn();
    const host = renderHook(() =>
      useMqttTransport({
        roomIdFromUrl: null,
        displayName: 'Host',
        onMessage: vi.fn(),
        onGuestConnected: vi.fn(),
        onGuestDisconnected: hostOnGuestDisconnected,
        onHostDisconnected: vi.fn(),
        onConnected: vi.fn(),
      })
    );

    const hostClient = getMockClient();
    const hostHandler = getOnHandler(hostClient, 'message');
    const hostRoomId = host.result.current.roomId as string;

    act(() => {
      hostHandler?.(
        `co-viewer/${hostRoomId}/presence`,
        Buffer.from(JSON.stringify({ peerId: 'guest-1', online: false }))
      );
    });

    expect(hostOnGuestDisconnected).toHaveBeenCalledTimes(1);
    expect(hostOnGuestDisconnected).toHaveBeenCalledWith('guest-1');

    host.unmount();

    const guestOnGuestDisconnected = vi.fn();
    const guestOnHostDisconnected = vi.fn();
    renderHook(() =>
      useMqttTransport({
        roomIdFromUrl: 'host-room',
        displayName: 'Guest',
        onMessage: vi.fn(),
        onGuestConnected: vi.fn(),
        onGuestDisconnected: guestOnGuestDisconnected,
        onHostDisconnected: guestOnHostDisconnected,
        onConnected: vi.fn(),
      })
    );

    const guestClient = getMockClient();
    const guestHandler = getOnHandler(guestClient, 'message');

    act(() => {
      guestHandler?.(
        'co-viewer/host-room/presence',
        Buffer.from(JSON.stringify({ peerId: 'other-guest', online: false }))
      );
    });

    expect(guestOnGuestDisconnected).not.toHaveBeenCalled();
    expect(guestOnHostDisconnected).not.toHaveBeenCalled();
  });

  it('guest calls onHostDisconnected for the host offline presence and MQTT close', () => {
    const onHostDisconnected = vi.fn();
    renderHook(() =>
      useMqttTransport({
        roomIdFromUrl: 'host-room',
        displayName: 'Guest',
        onMessage: vi.fn(),
        onGuestConnected: vi.fn(),
        onGuestDisconnected: vi.fn(),
        onHostDisconnected,
        onConnected: vi.fn(),
      })
    );

    const client = getMockClient();
    const handler = getOnHandler(client, 'message');

    act(() => {
      handler?.(
        'co-viewer/host-room/presence',
        Buffer.from(JSON.stringify({ peerId: 'host-room', online: false }))
      );
    });

    expect(onHostDisconnected).toHaveBeenCalledTimes(1);

    const closeHandler = getOnHandler(client, 'close');
    expect(closeHandler).not.toBeNull();
    act(() => {
      closeHandler?.();
    });

    expect(onHostDisconnected).toHaveBeenCalledTimes(2);
  });

  it('host does not call onHostDisconnected when MQTT closes', () => {
    const onHostDisconnected = vi.fn();
    renderHook(() =>
      useMqttTransport({
        roomIdFromUrl: null,
        displayName: 'Host',
        onMessage: vi.fn(),
        onGuestConnected: vi.fn(),
        onGuestDisconnected: vi.fn(),
        onHostDisconnected,
        onConnected: vi.fn(),
      })
    );

    const client = getMockClient();
    const closeHandler = getOnHandler(client, 'close');
    expect(closeHandler).not.toBeNull();

    act(() => {
      closeHandler?.();
    });

    expect(onHostDisconnected).not.toHaveBeenCalled();
  });

  it('publishes offline presence before ending the client on unmount', () => {
    const { result, unmount } = renderHook(() =>
      useMqttTransport({
        roomIdFromUrl: 'host-room',
        displayName: 'Guest',
        onMessage: vi.fn(),
        onGuestConnected: vi.fn(),
        onGuestDisconnected: vi.fn(),
        onHostDisconnected: vi.fn(),
        onConnected: vi.fn(),
      })
    );

    const myId = result.current.myId as string;
    const client = getMockClient();

    unmount();

    const presenceCall = client.publish.mock.calls.find(
      ([topic]: [string]) => topic === 'co-viewer/host-room/presence'
    );
    expect(presenceCall).toBeDefined();

    const [, payload, opts] = presenceCall as [string, string, { qos: number; retain: boolean }];
    expect(JSON.parse(payload)).toEqual({ peerId: myId, online: false });
    expect(opts).toMatchObject({ qos: 1, retain: false });
    expect(client.end).toHaveBeenCalled();
    expect(client.publish.mock.invocationCallOrder[0]).toBeLessThan(
      client.end.mock.invocationCallOrder[0]
    );
  });
});
