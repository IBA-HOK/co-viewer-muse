/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useRoomSync } from './useRoomSync';
import type { PlayerController, SyncMessage } from '../types';

function makeController(isPlaying: boolean): PlayerController {
  return {
    loadMedia: vi.fn(),
    play: vi.fn(),
    pause: vi.fn(),
    seekTo: vi.fn(),
    getCurrentTime: vi.fn(() => 12),
    getIsPlaying: vi.fn(() => isPlaying),
  };
}

function mountHost(
  controller: PlayerController,
  shouldEmitSyncPing: () => boolean
) {
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
      shouldEmitSyncPing,
    })
  );
  result.current.controllerRef.current = controller;
  return { result, broadcast };
}

function mountHostWithoutController(shouldEmitSyncPing: () => boolean) {
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
      shouldEmitSyncPing,
    })
  );
  return { result, broadcast };
}

function syncPings(broadcast: ReturnType<typeof vi.fn>): SyncMessage[] {
  return broadcast.mock.calls
    .map((call) => call[0] as SyncMessage)
    .filter((msg) => msg.type === 'SYNC_PING');
}

describe('useRoomSync · SYNC_PING emit gate', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('does not broadcast periodic SYNC_PING while shouldEmitSyncPing is false', () => {
    const controller = makeController(false);
    const { broadcast } = mountHost(controller, () => false);

    act(() => {
      vi.advanceTimersByTime(10_000);
    });

    expect(syncPings(broadcast)).toHaveLength(0);
  });

  it('broadcasts SYNC_PING with the controller isPlaying when allowed', () => {
    const controller = makeController(true);
    const { broadcast } = mountHost(controller, () => true);

    act(() => {
      vi.advanceTimersByTime(3_000);
    });

    const pings = syncPings(broadcast);
    expect(pings).toHaveLength(1);
    expect(pings[0]).toMatchObject({
      type: 'SYNC_PING',
      currentTime: 12,
      isPlaying: true,
    });
  });

  it('stops sending once the gate turns false and resumes when it turns true', () => {
    let gate = true;
    const controller = makeController(true);
    const { broadcast } = mountHost(controller, () => gate);

    act(() => {
      vi.advanceTimersByTime(3_000);
    });
    expect(syncPings(broadcast)).toHaveLength(1);

    gate = false;
    act(() => {
      vi.advanceTimersByTime(6_000);
    });
    expect(syncPings(broadcast)).toHaveLength(1);

    gate = true;
    act(() => {
      vi.advanceTimersByTime(3_000);
    });
    expect(syncPings(broadcast)).toHaveLength(2);
  });

  it('suppresses the immediate ping emitted by a host media change', () => {
    const controller = makeController(true);
    const { result, broadcast } = mountHost(controller, () => false);

    act(() => {
      result.current.localLoadMedia('youtube', 'abc123def45');
    });

    expect(syncPings(broadcast)).toHaveLength(0);
  });

  it('does not broadcast SYNC_PING on a media change before the controller is mounted', () => {
    const { result, broadcast } = mountHostWithoutController(() => true);

    act(() => {
      result.current.localLoadMedia('youtube', 'abc123def45');
    });

    expect(syncPings(broadcast)).toHaveLength(0);
    expect(
      broadcast.mock.calls.some(
        (call) => (call[0] as SyncMessage).type === 'QUEUE_UPDATE'
      )
    ).toBe(true);
  });

  it('does not broadcast periodic SYNC_PING while the controller is null', () => {
    const { broadcast } = mountHostWithoutController(() => true);

    act(() => {
      vi.advanceTimersByTime(10_000);
    });

    expect(syncPings(broadcast)).toHaveLength(0);
  });

  it('broadcasts the mounted controller state once the periodic ping fires', () => {
    const { result, broadcast } = mountHostWithoutController(() => true);

    act(() => {
      vi.advanceTimersByTime(3_000);
    });
    expect(syncPings(broadcast)).toHaveLength(0);

    result.current.controllerRef.current = makeController(true);
    act(() => {
      vi.advanceTimersByTime(3_000);
    });

    const pings = syncPings(broadcast);
    expect(pings).toHaveLength(1);
    expect(pings[0]).toMatchObject({
      type: 'SYNC_PING',
      currentTime: 12,
      isPlaying: true,
    });
  });
});
