/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useRoomSync } from './useRoomSync';
import type { PlayerController } from '../types';

function makeController(): PlayerController {
  return {
    loadMedia: vi.fn(),
    play: vi.fn(),
    pause: vi.fn(),
    seekTo: vi.fn(),
    getCurrentTime: vi.fn(() => 0),
    getIsPlaying: vi.fn(() => false),
  };
}

function mountGuest(controller: PlayerController) {
  const broadcast = vi.fn();
  const { result, unmount } = renderHook(() =>
    useRoomSync({
      isHost: false,
      myId: 'guest-1',
      connected: true,
      myName: 'Guest',
      broadcast,
      sendTo: vi.fn(),
    })
  );
  result.current.controllerRef.current = controller;
  return { result, broadcast, unmount };
}

describe('useRoomSync · remote sync suppression timer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline'))));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('keeps suppressing until 400ms after the latest remote command', () => {
    const controller = makeController();
    const { result } = mountGuest(controller);

    act(() => {
      result.current.handleIncoming(
        { type: 'PLAY', currentTime: 0, senderId: 'host-1' },
        'host-1'
      );
    });
    act(() => {
      vi.advanceTimersByTime(300);
    });
    act(() => {
      result.current.handleIncoming(
        { type: 'PAUSE', currentTime: 0, senderId: 'host-1' },
        'host-1'
      );
    });

    // t=400: the first command's timer alone would have released the flag.
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(result.current.isRemoteSyncingRef.current).toBe(true);

    // t=700: 400ms after the second (latest) command.
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(result.current.isRemoteSyncingRef.current).toBe(false);
  });

  it('does not broadcast a player echo while the latest command is suppressed', () => {
    const controller = makeController();
    const { result, broadcast } = mountGuest(controller);

    act(() => {
      result.current.handleIncoming(
        {
          type: 'PARTICIPANTS',
          participants: [
            { peerId: 'guest-1', name: 'Guest', isHost: false, role: 'Controller' },
          ],
          senderId: 'host-1',
        },
        'host-1'
      );
    });
    act(() => {
      result.current.handleIncoming(
        { type: 'PLAY', currentTime: 0, senderId: 'host-1' },
        'host-1'
      );
    });
    act(() => {
      vi.advanceTimersByTime(300);
    });
    act(() => {
      result.current.handleIncoming(
        { type: 'PAUSE', currentTime: 0, senderId: 'host-1' },
        'host-1'
      );
    });

    // A delayed player callback at t=400: with a per-call timer the first
    // command would already have released the flag and this echo would be
    // broadcast. The platform hooks only forward local events while the flag
    // is false, so mirror that guard here.
    act(() => {
      vi.advanceTimersByTime(100);
    });
    act(() => {
      if (!result.current.isRemoteSyncingRef.current) {
        result.current.reportLocalEvent({ kind: 'PAUSE', currentTime: 0 });
      }
    });

    expect(result.current.isRemoteSyncingRef.current).toBe(true);
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('clears the pending timer on unmount without errors or state updates', () => {
    const controller = makeController();
    const { result, unmount } = mountGuest(controller);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    act(() => {
      result.current.handleIncoming(
        { type: 'PLAY', currentTime: 0, senderId: 'host-1' },
        'host-1'
      );
    });

    unmount();
    expect(() => vi.advanceTimersByTime(1_000)).not.toThrow();
    expect(errorSpy).not.toHaveBeenCalled();
  });
});
