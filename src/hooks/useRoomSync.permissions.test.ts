/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useRoomSync } from './useRoomSync';
import type { Participant, Role } from '../types';

function mountRoom(isHost: boolean) {
  const broadcast = vi.fn();
  const sendTo = vi.fn();
  const { result } = renderHook(() =>
    useRoomSync({
      isHost,
      myId: isHost ? 'host-1' : 'guest-1',
      connected: true,
      myName: isHost ? 'Host' : 'Guest',
      broadcast,
      sendTo,
    })
  );
  return { result, broadcast };
}

function setGuestRole(result: ReturnType<typeof mountRoom>['result'], role: Role) {
  const participants: Participant[] = [
    { peerId: 'guest-1', name: 'Guest', isHost: false, role },
  ];
  act(() => {
    result.current.handleIncoming(
      { type: 'PARTICIPANTS', participants, senderId: 'host-1' },
      'host-1'
    );
  });
}

describe('useRoomSync · local playback event permissions', () => {
  beforeEach(() => {
    // Title fetching must never hit the network in tests.
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline'))));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('does not broadcast PLAY/PAUSE/SEEK from a Viewer', () => {
    const { result, broadcast } = mountRoom(false);
    setGuestRole(result, 'Viewer');

    act(() => {
      result.current.reportLocalEvent({ kind: 'PLAY', currentTime: 10 });
      result.current.reportLocalEvent({ kind: 'PAUSE', currentTime: 12 });
      result.current.reportLocalEvent({ kind: 'SEEK', currentTime: 20 });
    });

    expect(broadcast).not.toHaveBeenCalled();
  });

  it('still broadcasts PLAY/PAUSE from a Controller', () => {
    const { result, broadcast } = mountRoom(false);
    setGuestRole(result, 'Controller');

    act(() => {
      result.current.reportLocalEvent({ kind: 'PLAY', currentTime: 10 });
      result.current.reportLocalEvent({ kind: 'PAUSE', currentTime: 12 });
    });

    expect(broadcast).toHaveBeenNthCalledWith(1, {
      type: 'PLAY',
      currentTime: 10,
      senderId: 'guest-1',
    });
    expect(broadcast).toHaveBeenNthCalledWith(2, {
      type: 'PAUSE',
      currentTime: 12,
      senderId: 'guest-1',
    });
  });

  it('still broadcasts PLAY/PAUSE from the Host', () => {
    const { result, broadcast } = mountRoom(true);

    act(() => {
      result.current.reportLocalEvent({ kind: 'PLAY', currentTime: 5 });
      result.current.reportLocalEvent({ kind: 'PAUSE', currentTime: 8 });
    });

    expect(broadcast).toHaveBeenNthCalledWith(1, {
      type: 'PLAY',
      currentTime: 5,
      senderId: 'host-1',
    });
    expect(broadcast).toHaveBeenNthCalledWith(2, {
      type: 'PAUSE',
      currentTime: 8,
      senderId: 'host-1',
    });
  });
});
