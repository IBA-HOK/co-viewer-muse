/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { usePeer, CONNECT_TIMEOUT_MS } from './usePeer';
import type { UsePeerOptions } from './usePeer';
import type { SyncMessage } from '../types';

type Handler = (...args: unknown[]) => void;

const peerMock = vi.hoisted(() => {
  class MockDataConnection {
    peer: string;
    open = false;
    metadata?: Record<string, unknown>;
    handlers = new Map<string, Handler[]>();
    send = vi.fn();
    close = vi.fn(() => {
      this.open = false;
      this.emit('close');
    });

    constructor(peer: string, opts?: { metadata?: Record<string, unknown> }) {
      this.peer = peer;
      this.metadata = opts?.metadata;
    }

    on(event: string, cb: Handler): this {
      const list = this.handlers.get(event) ?? [];
      list.push(cb);
      this.handlers.set(event, list);
      return this;
    }

    once(event: string, cb: Handler): this {
      const wrap: Handler = (...args) => {
        this.off(event, wrap);
        cb(...args);
      };
      return this.on(event, wrap);
    }

    off(event: string, cb: Handler): this {
      const list = this.handlers.get(event) ?? [];
      this.handlers.set(
        event,
        list.filter((h) => h !== cb)
      );
      return this;
    }

    emit(event: string, ...args: unknown[]): void {
      for (const cb of [...(this.handlers.get(event) ?? [])]) cb(...args);
    }
  }

  class MockPeer {
    static instances: MockPeer[] = [];
    handlers = new Map<string, Handler[]>();
    connections: MockDataConnection[] = [];
    reconnect = vi.fn();
    destroy = vi.fn();
    constructorArgs: unknown[];

    constructor(...args: unknown[]) {
      this.constructorArgs = args;
      MockPeer.instances.push(this);
    }

    on(event: string, cb: Handler): this {
      const list = this.handlers.get(event) ?? [];
      list.push(cb);
      this.handlers.set(event, list);
      return this;
    }

    emit(event: string, ...args: unknown[]): void {
      for (const cb of [...(this.handlers.get(event) ?? [])]) cb(...args);
    }

    connect = vi.fn((id: string, opts?: { metadata?: Record<string, unknown> }) => {
      const conn = new MockDataConnection(id, opts);
      this.connections.push(conn);
      return conn;
    });
  }

  return { MockPeer, MockDataConnection };
});

vi.mock('peerjs', () => ({ default: peerMock.MockPeer }));

function makeOptions(roomIdFromUrl: string | null): UsePeerOptions {
  return {
    roomIdFromUrl,
    displayName: roomIdFromUrl ? 'Guest' : 'Host',
    onMessage: vi.fn(),
    onGuestConnected: vi.fn(),
    onGuestDisconnected: vi.fn(),
    onHostDisconnected: vi.fn(),
    onConnected: vi.fn(),
  };
}

function openConn(conn: InstanceType<typeof peerMock.MockDataConnection>): void {
  conn.open = true;
  conn.emit('open');
}

function makeMsg(n: number): SyncMessage {
  return { type: 'PLAY', currentTime: n, senderId: 'sender-1' };
}

describe('usePeer · topology', () => {
  beforeEach(() => {
    peerMock.MockPeer.instances.length = 0;
    vi.clearAllMocks();
  });

  it('reports the star topology', () => {
    const { result } = renderHook(() => usePeer(makeOptions('room-1')));

    expect(result.current.topology).toBe('star');
  });
});

describe('usePeer · explicit peer id', () => {
  beforeEach(() => {
    peerMock.MockPeer.instances.length = 0;
    vi.clearAllMocks();
  });

  it('uses the explicit id for the Peer constructor and the host room id', () => {
    const opts = { ...makeOptions(null), peerId: 'co-viewer-abc-123' };
    const { result } = renderHook(() => usePeer(opts));

    const peer = peerMock.MockPeer.instances[0];
    expect(peer.constructorArgs[0]).toBe('co-viewer-abc-123');
    expect(peer.constructorArgs[1]).toMatchObject({
      config: expect.objectContaining({ iceServers: expect.any(Array) }),
    });

    act(() => peer.emit('open', 'co-viewer-abc-123'));

    expect(result.current.myId).toBe('co-viewer-abc-123');
    expect(result.current.roomId).toBe('co-viewer-abc-123');
  });

  it('keeps the explicit id for a guest while joining the URL room', () => {
    const opts = { ...makeOptions('url-room'), peerId: 'co-viewer-guest-1' };
    const { result } = renderHook(() => usePeer(opts));

    const peer = peerMock.MockPeer.instances[0];
    expect(peer.constructorArgs[0]).toBe('co-viewer-guest-1');

    act(() => peer.emit('open', 'co-viewer-guest-1'));

    expect(result.current.myId).toBe('co-viewer-guest-1');
    expect(result.current.roomId).toBe('url-room');
    expect(peer.connect).toHaveBeenCalledWith('url-room', expect.anything());
  });

  it('falls back to a server-assigned id when the explicit id is invalid', () => {
    const opts = { ...makeOptions(null), peerId: 'not a valid id!' };
    const { result } = renderHook(() => usePeer(opts));

    const peer = peerMock.MockPeer.instances[0];
    // No explicit id argument: Peer asks the server for a random id.
    expect(typeof peer.constructorArgs[0]).toBe('object');

    act(() => peer.emit('open', 'server-assigned'));

    expect(result.current.myId).toBe('server-assigned');
    expect(result.current.roomId).toBe('server-assigned');
  });

  it('omits the explicit id argument when no peerId is supplied', () => {
    renderHook(() => usePeer(makeOptions(null)));

    const peer = peerMock.MockPeer.instances[0];
    expect(typeof peer.constructorArgs[0]).toBe('object');
  });
});

describe('usePeer · stale DataConnection identity guards', () => {
  beforeEach(() => {
    peerMock.MockPeer.instances.length = 0;
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('guest ignores close/error from conn1 after reconnecting to conn2', () => {
    const opts = makeOptions('room-1');
    const { result } = renderHook(() => usePeer(opts));

    const peer = peerMock.MockPeer.instances[0];
    expect(peer).toBeDefined();

    act(() => peer.emit('open', 'guest-self'));
    const conn1 = peer.connections[0];
    expect(conn1).toBeDefined();
    act(() => openConn(conn1));

    expect(result.current.connected).toBe(true);

    act(() => result.current.reconnect());
    const conn2 = peer.connections[1];
    expect(conn2).toBeDefined();
    expect(conn2).not.toBe(conn1);

    act(() => openConn(conn2));
    expect(result.current.connected).toBe(true);

    // Late events from the replaced connection must not tear down conn2.
    act(() => {
      conn1.emit('close');
      conn1.emit('error');
    });

    expect(result.current.connected).toBe(true);
    expect(opts.onHostDisconnected).not.toHaveBeenCalled();
    expect(opts.onConnected).toHaveBeenCalledTimes(2);
  });

  it('guest ignores a delayed open from conn1 (no extra onConnected / flush)', () => {
    const opts = makeOptions('room-1');
    const { result } = renderHook(() => usePeer(opts));

    const peer = peerMock.MockPeer.instances[0];
    act(() => peer.emit('open', 'guest-self'));
    const conn1 = peer.connections[0];

    // conn1 is not open yet: the message is queued for the host connection.
    act(() => result.current.broadcast(makeMsg(1)));

    act(() => result.current.reconnect());
    const conn2 = peer.connections[1];
    act(() => openConn(conn2));

    expect(conn2.send).toHaveBeenCalledTimes(1);
    expect(opts.onConnected).toHaveBeenCalledTimes(1);

    // conn1's delayed open must be ignored entirely.
    act(() => openConn(conn1));

    expect(conn2.send).toHaveBeenCalledTimes(1);
    expect(opts.onConnected).toHaveBeenCalledTimes(1);
  });

  it('host ignores close from conn1 after replacing it with conn2 for the same peer', () => {
    const opts = makeOptions(null);
    const { result } = renderHook(() => usePeer(opts));

    const peer = peerMock.MockPeer.instances[0];
    act(() => peer.emit('open', 'host-1'));

    const conn1 = new peerMock.MockDataConnection('guest-1', {
      metadata: { name: 'Alice' },
    });
    act(() => peer.emit('connection', conn1));
    act(() => openConn(conn1));
    expect(opts.onGuestConnected).toHaveBeenCalledTimes(1);

    const conn2 = new peerMock.MockDataConnection('guest-1', {
      metadata: { name: 'Alice' },
    });
    act(() => peer.emit('connection', conn2));
    expect(conn1.close).toHaveBeenCalled();
    act(() => openConn(conn2));

    act(() => conn1.emit('close'));

    expect(opts.onGuestDisconnected).not.toHaveBeenCalled();

    const msg = makeMsg(2);
    act(() => result.current.broadcast(msg));

    expect(conn2.send).toHaveBeenCalledWith(msg);
    expect(conn1.send).not.toHaveBeenCalled();
  });

  it('host treats a current guest conn error as a departure and ignores the later close', () => {
    const opts = makeOptions(null);
    renderHook(() => usePeer(opts));

    const peer = peerMock.MockPeer.instances[0];
    act(() => peer.emit('open', 'host-1'));

    const conn1 = new peerMock.MockDataConnection('guest-1', {
      metadata: { name: 'Alice' },
    });
    act(() => peer.emit('connection', conn1));
    act(() => openConn(conn1));
    expect(opts.onGuestConnected).toHaveBeenCalledTimes(1);

    act(() => conn1.emit('error', new Error('datachannel error')));

    expect(opts.onGuestDisconnected).toHaveBeenCalledTimes(1);
    expect(opts.onGuestDisconnected).toHaveBeenCalledWith('guest-1');
    expect(conn1.close).toHaveBeenCalledTimes(1);

    // The close emitted by conn1.close() (or a later one) must not notify twice.
    act(() => conn1.emit('close'));
    expect(opts.onGuestDisconnected).toHaveBeenCalledTimes(1);
  });

  it('host notifies onGuestConnected again when the same peer reconnects after an error', () => {
    const opts = makeOptions(null);
    const { result } = renderHook(() => usePeer(opts));

    const peer = peerMock.MockPeer.instances[0];
    act(() => peer.emit('open', 'host-1'));

    const conn1 = new peerMock.MockDataConnection('guest-1', {
      metadata: { name: 'Alice' },
    });
    act(() => peer.emit('connection', conn1));
    act(() => openConn(conn1));
    act(() => conn1.emit('error', new Error('datachannel error')));

    const conn2 = new peerMock.MockDataConnection('guest-1', {
      metadata: { name: 'Alice' },
    });
    act(() => peer.emit('connection', conn2));

    expect(opts.onGuestConnected).toHaveBeenCalledTimes(2);
    act(() => openConn(conn2));

    const msg = makeMsg(3);
    act(() => result.current.broadcast(msg));

    expect(conn2.send).toHaveBeenCalledWith(msg);
    expect(conn1.send).not.toHaveBeenCalled();
  });

  it('host ignores an error from a replaced guest conn', () => {
    const opts = makeOptions(null);
    const { result } = renderHook(() => usePeer(opts));

    const peer = peerMock.MockPeer.instances[0];
    act(() => peer.emit('open', 'host-1'));

    const conn1 = new peerMock.MockDataConnection('guest-1', {
      metadata: { name: 'Alice' },
    });
    act(() => peer.emit('connection', conn1));
    act(() => openConn(conn1));

    const conn2 = new peerMock.MockDataConnection('guest-1', {
      metadata: { name: 'Alice' },
    });
    act(() => peer.emit('connection', conn2));
    act(() => openConn(conn2));

    act(() => conn1.emit('error', new Error('stale error')));

    expect(opts.onGuestDisconnected).not.toHaveBeenCalled();

    const msg = makeMsg(4);
    act(() => result.current.broadcast(msg));

    expect(conn2.send).toHaveBeenCalledWith(msg);
  });

  it('host discards the pending queue for a guest whose conn errors', () => {
    const opts = makeOptions(null);
    const { result } = renderHook(() => usePeer(opts));

    const peer = peerMock.MockPeer.instances[0];
    act(() => peer.emit('open', 'host-1'));

    const conn1 = new peerMock.MockDataConnection('guest-1', {
      metadata: { name: 'Alice' },
    });
    act(() => peer.emit('connection', conn1));

    // conn1 is not open yet, so the message is queued for guest-1.
    act(() => result.current.sendTo('guest-1', makeMsg(5)));
    expect(conn1.send).not.toHaveBeenCalled();

    act(() => conn1.emit('error', new Error('datachannel error')));

    const conn2 = new peerMock.MockDataConnection('guest-1', {
      metadata: { name: 'Alice' },
    });
    act(() => peer.emit('connection', conn2));
    act(() => openConn(conn2));

    expect(conn2.send).not.toHaveBeenCalled();
  });
});

describe('usePeer · host incoming connection timeout', () => {
  beforeEach(() => {
    peerMock.MockPeer.instances.length = 0;
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('notifies onGuestConnected immediately without disconnecting before the timeout', () => {
    const opts = makeOptions(null);
    renderHook(() => usePeer(opts));

    const peer = peerMock.MockPeer.instances[0];
    act(() => peer.emit('open', 'host-1'));

    const conn = new peerMock.MockDataConnection('guest-1', {
      metadata: { name: 'Alice' },
    });
    act(() => peer.emit('connection', conn));

    expect(opts.onGuestConnected).toHaveBeenCalledTimes(1);

    act(() => vi.advanceTimersByTime(CONNECT_TIMEOUT_MS - 1));
    expect(opts.onGuestDisconnected).not.toHaveBeenCalled();
  });

  it('clears the timer when the incoming conn opens in time', () => {
    const opts = makeOptions(null);
    renderHook(() => usePeer(opts));

    const peer = peerMock.MockPeer.instances[0];
    act(() => peer.emit('open', 'host-1'));

    const conn = new peerMock.MockDataConnection('guest-1', {
      metadata: { name: 'Alice' },
    });
    act(() => peer.emit('connection', conn));

    act(() => vi.advanceTimersByTime(CONNECT_TIMEOUT_MS / 2));
    act(() => openConn(conn));
    act(() => vi.advanceTimersByTime(CONNECT_TIMEOUT_MS));

    expect(opts.onGuestDisconnected).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('disconnects once after the timeout, drops the pending queue, and ignores late open/close', () => {
    const opts = makeOptions(null);
    const { result } = renderHook(() => usePeer(opts));

    const peer = peerMock.MockPeer.instances[0];
    act(() => peer.emit('open', 'host-1'));

    const conn = new peerMock.MockDataConnection('guest-1', {
      metadata: { name: 'Alice' },
    });
    act(() => peer.emit('connection', conn));

    act(() => result.current.sendTo('guest-1', makeMsg(1)));
    expect(conn.send).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(CONNECT_TIMEOUT_MS));

    expect(opts.onGuestDisconnected).toHaveBeenCalledTimes(1);
    expect(opts.onGuestDisconnected).toHaveBeenCalledWith('guest-1');
    expect(conn.close).toHaveBeenCalledTimes(1);

    const msg = makeMsg(2);
    // The queued message was dropped rather than being flushed on a new conn.
    const conn2 = new peerMock.MockDataConnection('guest-1', {
      metadata: { name: 'Alice' },
    });
    act(() => peer.emit('connection', conn2));
    act(() => openConn(conn2));
    expect(conn2.send).not.toHaveBeenCalled();

    // Messages sent afterwards must not reach the dead conn.
    act(() => result.current.broadcast(msg));
    act(() => result.current.sendTo('guest-1', msg));
    expect(conn.send).not.toHaveBeenCalled();

    // Late events from the abandoned conn must not notify again.
    act(() => {
      openConn(conn);
      conn.emit('close');
    });
    expect(opts.onGuestDisconnected).toHaveBeenCalledTimes(1);
  });

  it('does not let the replaced conn timer disconnect the new connection', () => {
    const opts = makeOptions(null);
    renderHook(() => usePeer(opts));

    const peer = peerMock.MockPeer.instances[0];
    act(() => peer.emit('open', 'host-1'));

    const conn1 = new peerMock.MockDataConnection('guest-1', {
      metadata: { name: 'Alice' },
    });
    act(() => peer.emit('connection', conn1));
    act(() => vi.advanceTimersByTime(CONNECT_TIMEOUT_MS / 2));

    const conn2 = new peerMock.MockDataConnection('guest-1', {
      metadata: { name: 'Alice' },
    });
    act(() => peer.emit('connection', conn2));
    expect(conn1.close).toHaveBeenCalled();

    // Past conn1's deadline, but before conn2's own timeout: still connected.
    act(() => vi.advanceTimersByTime(CONNECT_TIMEOUT_MS / 2));
    expect(opts.onGuestDisconnected).not.toHaveBeenCalled();

    // conn2 never opens: its timer exits the guest once.
    act(() => vi.advanceTimersByTime(CONNECT_TIMEOUT_MS / 2));
    expect(opts.onGuestDisconnected).toHaveBeenCalledTimes(1);
    expect(opts.onGuestDisconnected).toHaveBeenCalledWith('guest-1');
    expect(conn2.close).toHaveBeenCalledTimes(1);
  });
});
