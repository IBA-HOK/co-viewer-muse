/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useRoomSync } from './useRoomSync';
import type { PlayerController, QueueItem, SyncMessage } from '../types';

const QUEUE: QueueItem[] = [
  { id: 'youtube:abc123def45', platform: 'youtube', videoId: 'abc123def45', addedBy: 'Host' },
];

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

function snapshot(isPlaying: boolean): SyncMessage {
  return {
    type: 'STATE_SNAPSHOT',
    platform: 'youtube',
    videoId: 'abc123def45',
    currentTime: 42,
    isPlaying,
    queue: QUEUE,
    currentId: QUEUE[0].id,
    senderId: 'host-1',
  };
}

function mountGuest(controller: PlayerController) {
  const { result } = renderHook(() =>
    useRoomSync({
      isHost: false,
      myId: 'guest-1',
      connected: true,
      myName: 'Guest',
      broadcast: vi.fn(),
      sendTo: vi.fn(),
    })
  );
  result.current.controllerRef.current = controller;
  return result;
}

describe('useRoomSync · STATE_SNAPSHOT playback state', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline'))));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('pauses after loading when the host snapshot is paused', () => {
    const controller = makeController();
    const result = mountGuest(controller);

    act(() => {
      result.current.handleIncoming(snapshot(false), 'host-1');
    });

    expect(controller.loadMedia).toHaveBeenCalledWith('abc123def45');
    expect(controller.seekTo).toHaveBeenCalledWith(42);
    expect(controller.pause).toHaveBeenCalledTimes(1);
    expect(controller.play).not.toHaveBeenCalled();
  });

  it('plays after loading when the host snapshot is playing', () => {
    const controller = makeController();
    const result = mountGuest(controller);

    act(() => {
      result.current.handleIncoming(snapshot(true), 'host-1');
    });

    expect(controller.loadMedia).toHaveBeenCalledWith('abc123def45');
    expect(controller.seekTo).toHaveBeenCalledWith(42);
    expect(controller.play).toHaveBeenCalledTimes(1);
    expect(controller.pause).not.toHaveBeenCalled();
  });
});
