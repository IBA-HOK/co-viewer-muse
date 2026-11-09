/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useRoomSync } from './useRoomSync';
import type { SyncMessage } from '../types';

function mountHost() {
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

describe('useRoomSync · guest left', () => {
  beforeEach(() => {
    // Title fetching must never hit the network in tests.
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline'))));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('removes the guest locally and broadcasts the same list plus VC_PEER(false)', () => {
    const { result, broadcast } = mountHost();

    act(() => {
      result.current.onGuestJoined('peer-a', 'Alice');
    });
    act(() => {
      result.current.onGuestJoined('peer-b', 'Bob');
    });
    act(() => {
      result.current.handleIncoming(
        { type: 'VC_PEER', peerId: 'peer-a', inVc: true, senderId: 'peer-a' },
        'peer-a'
      );
    });

    broadcast.mockClear();
    act(() => {
      result.current.onGuestLeft('peer-a');
    });

    const peers = result.current.participants;
    expect(peers.some((p) => p.peerId === 'peer-a')).toBe(false);
    expect(peers.some((p) => p.peerId === 'peer-b')).toBe(true);
    expect(result.current.vcPeers.has('peer-a')).toBe(false);

    const participantMessages = broadcast.mock.calls
      .map((c) => c[0] as SyncMessage)
      .filter((m) => m.type === 'PARTICIPANTS');
    expect(participantMessages).toHaveLength(1);
    const latest = participantMessages[participantMessages.length - 1];
    expect(latest.type).toBe('PARTICIPANTS');
    if (latest.type !== 'PARTICIPANTS') throw new Error('unreachable');
    expect(latest.participants).toEqual(peers);

    expect(broadcast).toHaveBeenCalledWith({
      type: 'VC_PEER',
      peerId: 'peer-a',
      inVc: false,
      senderId: 'host-1',
    });
  });

  it('does not throw for an unknown peer id', () => {
    const { result } = mountHost();

    act(() => {
      result.current.onGuestJoined('peer-b', 'Bob');
    });
    const before = result.current.participants;

    expect(() => {
      act(() => {
        result.current.onGuestLeft('peer-unknown');
      });
    }).not.toThrow();
    expect(result.current.participants).toEqual(before);
  });
});
