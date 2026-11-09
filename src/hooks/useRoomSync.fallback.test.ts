/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useRoomSync } from './useRoomSync';
import type { PlayerController, QueueItem, SyncMessage } from '../types';

const QUEUE: QueueItem[] = [
  { id: 'youtube:abc123def45', platform: 'youtube', videoId: 'abc123def45', addedBy: 'Host' },
];

interface FakeControllerState {
  time: number;
  playing: boolean;
  buffering: boolean;
  recoveryMs: number;
}

function makeController(initialTime = 0) {
  const state: FakeControllerState = {
    time: initialTime,
    playing: true,
    buffering: false,
    recoveryMs: 0,
  };
  const controller = {
    state,
    loadMedia: vi.fn(),
    play: vi.fn(() => {
      state.playing = true;
    }),
    pause: vi.fn(() => {
      state.playing = false;
    }),
    seekTo: vi.fn((seconds: number) => {
      state.time = seconds;
    }),
    getCurrentTime: vi.fn(() => state.time),
    getIsPlaying: vi.fn(() => state.playing),
    isBuffering: vi.fn(() => state.buffering),
    getSeekRecoveryMs: vi.fn(() => state.recoveryMs),
  } satisfies PlayerController & { state: FakeControllerState };
  return controller;
}

function snapshot(currentTime = 0): SyncMessage {
  return {
    type: 'STATE_SNAPSHOT',
    platform: 'youtube',
    videoId: 'abc123def45',
    currentTime,
    isPlaying: true,
    queue: QUEUE,
    currentId: QUEUE[0].id,
    senderId: 'host-1',
  };
}

function ping(currentTime: number, isPlaying = true, sentAt?: number): SyncMessage {
  return {
    type: 'SYNC_PING',
    currentTime,
    isPlaying,
    // Host time and send timestamp advance together; a caller can pass an
    // explicit sentAt to simulate a deliberate host seek (time jump).
    // Sent timestamps share one scale with the fake clock and advance with the
    // host position; pass an explicit value with a different gap to simulate a
    // deliberate seek.
    sentAt: sentAt ?? Math.round(1_000_000 + currentTime * 1000),
    senderId: 'host-1',
  };
}

function mountGuest() {
  const broadcast = vi.fn();
  const sendTo = vi.fn();
  const { result } = renderHook(() =>
    useRoomSync({
      isHost: false,
      myId: 'guest-1',
      connected: true,
      myName: 'Guest',
      broadcast,
      sendTo,
    })
  );
  return { result, broadcast, sendTo };
}

/** Snapshot at t0: the guest receives media and applies load + seek + play. */
function joinWithSnapshot(
  result: ReturnType<typeof mountGuest>['result'],
  controller: ReturnType<typeof makeController>
) {
  act(() => {
    result.current.controllerRef.current = controller;
    result.current.handleIncoming(snapshot(0), 'host-1');
  });
  expect(controller.seekTo).toHaveBeenCalledTimes(1);
}

describe('useRoomSync · low-performance guest fallback', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    // Title fetching must never hit the network in tests.
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline'))));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('never re-seeks a guest that is still buffering (the loop root cause)', () => {
    const { result } = mountGuest();
    const controller = makeController(0);
    joinWithSnapshot(result, controller);
    controller.state.buffering = true;

    for (const hostTime of [3, 6, 9, 12, 15]) {
      act(() => {
        vi.advanceTimersByTime(3_000);
        result.current.handleIncoming(ping(hostTime), 'host-1');
      });
      expect(controller.seekTo).toHaveBeenCalledTimes(1);
    }

    // Once loading finishes, the guest is far behind → one correction is
    // allowed. This is the point where the old code entered the loop.
    controller.state.buffering = false;
    act(() => {
      result.current.handleIncoming(ping(16), 'host-1');
    });
    expect(controller.seekTo).toHaveBeenCalledTimes(2);
    expect(controller.seekTo).toHaveBeenLastCalledWith(16);
  });

  it('widens the tolerance for a device whose seek needed 8s to recover', () => {
    const { result } = mountGuest();
    const controller = makeController(0);
    joinWithSnapshot(result, controller);

    // A seek on this device buffers for 8 seconds; pings during that time are
    // ignored (buffering), then the post-seek lag is tolerated.
    controller.state.buffering = true;
    controller.state.recoveryMs = 8_000;
    for (const hostTime of [3, 6, 9, 12]) {
      act(() => {
        vi.advanceTimersByTime(3_000);
        result.current.handleIncoming(ping(hostTime), 'host-1');
      });
    }
    expect(controller.seekTo).toHaveBeenCalledTimes(1);

    // Loading ended just now: the guest sits at the seek target (0) while the
    // host reached 12 → beyond tolerance, one correction to the host time.
    controller.state.buffering = false;
    act(() => {
      result.current.handleIncoming(ping(12), 'host-1');
    });
    expect(controller.seekTo).toHaveBeenCalledTimes(2);
    expect(controller.seekTo).toHaveBeenLastCalledWith(12);

    // The correction buffered for 8s again; afterwards the guest is 8s behind
    // the host, which is inside the adaptive tolerance → playback continues
    // without further seeks.
    controller.state.buffering = true;
    for (const hostTime of [15, 18, 21]) {
      act(() => {
        vi.advanceTimersByTime(3_000);
        result.current.handleIncoming(ping(hostTime), 'host-1');
      });
    }
    controller.state.buffering = false;
    controller.state.time = 12;

    for (const hostTime of [24, 27, 30, 33]) {
      controller.state.time += 3;
      act(() => {
        vi.advanceTimersByTime(3_000);
        result.current.handleIncoming(ping(hostTime), 'host-1');
      });
    }
    expect(controller.seekTo).toHaveBeenCalledTimes(2);
    expect(result.current.syncFallbackLevel).toBe(0);
    // The tolerated lag is surfaced (with a resync action) rather than hidden.
    expect(result.current.syncToleranceLag).toBeGreaterThanOrEqual(8);
  });

  it('enters a fallback hold after repeated ineffective corrections, then resyncs on demand', () => {
    const { result } = mountGuest();
    const controller = makeController(0);
    joinWithSnapshot(result, controller);

    // Correction #1: guest is 10s behind.
    act(() => {
      vi.advanceTimersByTime(7_000);
      result.current.handleIncoming(ping(10), 'host-1');
    });
    expect(controller.seekTo).toHaveBeenCalledTimes(2);
    expect(result.current.syncFallbackLevel).toBe(0);

    // It did not help (the guest is 7s behind again) → correction #2 strikes
    // out and the fallback hold engages instead of seeking forever.
    controller.state.time = 10;
    act(() => {
      vi.advanceTimersByTime(7_000);
      result.current.handleIncoming(ping(17), 'host-1');
    });
    expect(controller.seekTo).toHaveBeenCalledTimes(3);
    expect(result.current.syncFallbackLevel).toBe(1);

    const seeksBefore = controller.seekTo.mock.calls.length;
    act(() => {
      vi.advanceTimersByTime(7_000);
      result.current.handleIncoming(ping(24), 'host-1');
    });
    expect(controller.seekTo).toHaveBeenCalledTimes(seeksBefore);

    // Manual resync: seek to the host's predicted current position, leave the
    // fallback, and let automatic correction start over.
    act(() => {
      result.current.resyncNow();
    });
    expect(controller.seekTo).toHaveBeenCalledTimes(seeksBefore + 1);
    expect(controller.seekTo).toHaveBeenLastCalledWith(24);
    expect(result.current.syncFallbackLevel).toBe(0);
  });

  it('releases the fallback early once the guest stays aligned', () => {
    const { result } = mountGuest();
    const controller = makeController(0);
    joinWithSnapshot(result, controller);

    act(() => {
      vi.advanceTimersByTime(7_000);
      result.current.handleIncoming(ping(10), 'host-1');
    });
    controller.state.time = 10;
    act(() => {
      vi.advanceTimersByTime(7_000);
      result.current.handleIncoming(ping(17), 'host-1');
    });
    expect(result.current.syncFallbackLevel).toBe(1);

    // The guest catches up and every ping is within tolerance for >10s.
    for (const hostTime of [18, 21, 24, 27, 30]) {
      controller.state.time = hostTime - 0.4;
      act(() => {
        vi.advanceTimersByTime(3_000);
        result.current.handleIncoming(ping(hostTime), 'host-1');
      });
    }
    expect(result.current.syncFallbackLevel).toBe(0);
  });

  it('resets the fallback when the media changes', () => {
    const { result } = mountGuest();
    const controller = makeController(0);
    joinWithSnapshot(result, controller);

    act(() => {
      vi.advanceTimersByTime(7_000);
      result.current.handleIncoming(ping(10), 'host-1');
    });
    controller.state.time = 10;
    act(() => {
      vi.advanceTimersByTime(7_000);
      result.current.handleIncoming(ping(17), 'host-1');
    });
    expect(result.current.syncFallbackLevel).toBe(1);

    const nextItem = {
      id: 'youtube:xyz98765432',
      platform: 'youtube' as const,
      videoId: 'xyz98765432',
      addedBy: 'Host',
    };
    const nextSnapshot: SyncMessage = {
      type: 'STATE_SNAPSHOT',
      platform: 'youtube',
      videoId: nextItem.videoId,
      currentTime: 0,
      isPlaying: true,
      queue: [...QUEUE, nextItem],
      currentId: nextItem.id,
      senderId: 'host-1',
    };
    act(() => {
      result.current.handleIncoming(nextSnapshot, 'host-1');
    });
    expect(result.current.syncFallbackLevel).toBe(0);

    // The new media load has a settle window of its own: a ping right after
    // the load must not immediately seek.
    const seeksAfterLoad = controller.seekTo.mock.calls.length;
    act(() => {
      vi.advanceTimersByTime(1_000);
      result.current.handleIncoming(ping(1), 'host-1');
    });
    expect(controller.seekTo).toHaveBeenCalledTimes(seeksAfterLoad);
  });

  it('follows a deliberate host seek even while the fallback hold is active', () => {
    const { result } = mountGuest();
    const controller = makeController(0);
    joinWithSnapshot(result, controller);

    act(() => {
      vi.advanceTimersByTime(7_000);
      result.current.handleIncoming(ping(10), 'host-1');
    });
    controller.state.time = 10;
    act(() => {
      vi.advanceTimersByTime(7_000);
      result.current.handleIncoming(ping(17), 'host-1');
    });
    expect(result.current.syncFallbackLevel).toBe(1);

    // The host drags the seek bar to 1:00 while the guest is still in fallback.
    // The jump must not be mistaken for buffering lag and ignored.
    act(() => {
      vi.advanceTimersByTime(7_000);
      result.current.handleIncoming(ping(60, true, 1_021_000), 'host-1');
    });
    expect(result.current.syncFallbackLevel).toBe(0);
    expect(controller.seekTo).toHaveBeenLastCalledWith(60);
  });

  it('defers a detected host seek while buffering, then follows it', () => {
    const { result } = mountGuest();
    const controller = makeController(0);
    joinWithSnapshot(result, controller);

    // Establish a ping baseline (the guest was still settling/loading).
    act(() => {
      vi.advanceTimersByTime(3_000);
      result.current.handleIncoming(ping(3), 'host-1');
    });
    expect(controller.seekTo).toHaveBeenCalledTimes(1);

    controller.state.buffering = true;
    act(() => {
      vi.advanceTimersByTime(4_000);
      result.current.handleIncoming(ping(60, true, 1_007_000), 'host-1');
    });
    // Still loading → no seek yet, but the request is remembered.
    expect(controller.seekTo).toHaveBeenCalledTimes(1);

    controller.state.buffering = false;
    act(() => {
      vi.advanceTimersByTime(3_000);
      result.current.handleIncoming(ping(63, true, 1_010_000), 'host-1');
    });
    expect(controller.seekTo).toHaveBeenLastCalledWith(63);
  });

  it('does not mistake a host rebuffer/stall for a deliberate seek', () => {
    const { result } = mountGuest();
    const controller = makeController(0);
    joinWithSnapshot(result, controller);

    act(() => {
      vi.advanceTimersByTime(7_000);
      result.current.handleIncoming(ping(10), 'host-1');
    });
    controller.state.time = 10;
    act(() => {
      vi.advanceTimersByTime(7_000);
      result.current.handleIncoming(ping(17), 'host-1');
    });
    expect(result.current.syncFallbackLevel).toBe(1);
    const seeksBeforeStall = controller.seekTo.mock.calls.length;

    // The host's playhead froze (it is rebuffering) while isPlaying stayed true.
    // The guest is now 4s behind the frozen host: a stall must not clear the
    // fallback and force another correction.
    controller.state.time = 13;
    act(() => {
      vi.advanceTimersByTime(3_000);
      result.current.handleIncoming(ping(17, true, 1_020_000), 'host-1');
    });
    expect(result.current.syncFallbackLevel).toBe(1);
    expect(controller.seekTo).toHaveBeenCalledTimes(seeksBeforeStall);
  });

  it('retries a base-tolerance correction after a manual resync left residual lag', () => {
    const { result } = mountGuest();
    const controller = makeController(0);
    joinWithSnapshot(result, controller);

    // This device needs 8s per seek, so its normal tolerance is ~9.5s.
    controller.state.recoveryMs = 8_000;
    act(() => {
      vi.advanceTimersByTime(7_000);
      result.current.handleIncoming(ping(7), 'host-1');
    });
    // 7s of lag is inside the adaptive tolerance → no correction yet.
    expect(controller.seekTo).toHaveBeenCalledTimes(1);

    act(() => {
      result.current.resyncNow();
    });
    const seeksAfterResync = controller.seekTo.mock.calls.length;
    expect(controller.seekTo).toHaveBeenLastCalledWith(7);
    expect(result.current.syncResyncing).toBe(true);

    // The resync seek then buffered for 8s, leaving the guest 8s behind again.
    // The next playable ping must still correct once (base tolerance) instead
    // of silently accepting the residual lag.
    act(() => {
      vi.advanceTimersByTime(8_000);
      result.current.handleIncoming(ping(15), 'host-1');
    });
    expect(controller.seekTo.mock.calls.length).toBe(seeksAfterResync + 1);
    expect(controller.seekTo).toHaveBeenLastCalledWith(15);
    expect(result.current.syncResyncing).toBe(false);

    // Afterwards the adaptive tolerance is back in charge (no seek storm).
    controller.state.time = 15;
    act(() => {
      vi.advanceTimersByTime(7_000);
      result.current.handleIncoming(ping(22), 'host-1');
    });
    expect(controller.seekTo.mock.calls.length).toBe(seeksAfterResync + 1);
  });

  it('clears the fallback badge when the hold expires', () => {
    const { result } = mountGuest();
    const controller = makeController(0);
    joinWithSnapshot(result, controller);

    act(() => {
      vi.advanceTimersByTime(7_000);
      result.current.handleIncoming(ping(10), 'host-1');
    });
    controller.state.time = 10;
    act(() => {
      vi.advanceTimersByTime(7_000);
      result.current.handleIncoming(ping(17), 'host-1');
    });
    expect(result.current.syncFallbackLevel).toBe(1);

    act(() => {
      vi.advanceTimersByTime(20_100);
    });
    expect(result.current.syncFallbackLevel).toBe(0);
  });

  it('does not correct during the settle window after a remote SEEK', () => {
    const { result } = mountGuest();
    const controller = makeController(0);
    joinWithSnapshot(result, controller);

    act(() => {
      vi.advanceTimersByTime(1_000);
      result.current.handleIncoming(
        { type: 'SEEK', currentTime: 100, senderId: 'host-1' },
        'host-1'
      );
    });
    const seeksAfterSeek = controller.seekTo.mock.calls.length;

    act(() => {
      vi.advanceTimersByTime(2_000);
      result.current.handleIncoming(ping(103), 'host-1');
    });
    expect(controller.seekTo).toHaveBeenCalledTimes(seeksAfterSeek);
  });

  it('treats an aligned ping as success and does not escalate the hold', () => {
    const { result } = mountGuest();
    const controller = makeController(0);
    joinWithSnapshot(result, controller);

    // One failed correction, then the guest catches up on its own.
    act(() => {
      vi.advanceTimersByTime(7_000);
      result.current.handleIncoming(ping(10), 'host-1');
    });
    controller.state.time = 11.5;
    act(() => {
      vi.advanceTimersByTime(3_000);
      result.current.handleIncoming(ping(12.5), 'host-1');
    });
    expect(result.current.syncFallbackLevel).toBe(0);

    // A later drift starts a fresh correction instead of escalating from 1.
    act(() => {
      vi.advanceTimersByTime(7_000);
      result.current.handleIncoming(ping(20), 'host-1');
    });
    expect(controller.seekTo).toHaveBeenCalledTimes(3);
    expect(result.current.syncFallbackLevel).toBe(0);
  });
});
