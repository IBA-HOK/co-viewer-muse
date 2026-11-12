/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useRoomSync } from './useRoomSync';
import type { PlayerController, QueueItem, SyncMessage } from '../types';

const ITEMS: QueueItem[] = [
  { id: 'youtube:first000001', platform: 'youtube', videoId: 'first000001', addedBy: 'Host' },
  { id: 'youtube:second00001', platform: 'youtube', videoId: 'second00001', addedBy: 'Host' },
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

function mount(controller: PlayerController, isHost: boolean) {
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
  result.current.controllerRef.current = controller;
  return { result, broadcast, sendTo };
}

function seed(result: ReturnType<typeof mount>['result']) {
  for (const item of ITEMS) {
    act(() => {
      result.current.localLoadMedia('youtube', item.videoId);
    });
  }
}

function snapshot(isPlaying: boolean): SyncMessage {
  return {
    type: 'STATE_SNAPSHOT',
    platform: 'youtube',
    videoId: ITEMS[0].videoId,
    currentTime: 0,
    isPlaying,
    queue: [ITEMS[0]],
    currentId: ITEMS[0].id,
    senderId: 'host-1',
  };
}

describe('useRoomSync · queue changes update the room playing state', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline'))));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('marks the host as playing when goToItem starts playback', () => {
    const controller = makeController();
    const { result } = mount(controller, true);
    seed(result);
    act(() => result.current.reportLocalEvent({ kind: 'PAUSE', currentTime: 0 }));
    expect(result.current.isPlaying).toBe(false);

    act(() => {
      result.current.goToItem(ITEMS[1].id);
    });

    expect(controller.play).toHaveBeenCalled();
    expect(result.current.isPlaying).toBe(true);
  });

  it('marks the host as playing when removing the current item advances', () => {
    const controller = makeController();
    const { result } = mount(controller, true);
    seed(result);
    act(() => result.current.reportLocalEvent({ kind: 'PAUSE', currentTime: 0 }));
    expect(result.current.isPlaying).toBe(false);

    act(() => {
      result.current.removeFromQueue(ITEMS[0].id);
    });

    expect(controller.play).toHaveBeenCalled();
    expect(result.current.isPlaying).toBe(true);
  });

  it('marks the host as paused when the last current item is removed', () => {
    const controller = makeController();
    const { result } = mount(controller, true);
    seed(result);
    expect(result.current.isPlaying).toBe(true);

    act(() => {
      result.current.removeFromQueue(ITEMS[0].id);
    });
    act(() => {
      result.current.removeFromQueue(ITEMS[1].id);
    });

    expect(controller.pause).toHaveBeenCalled();
    expect(result.current.isPlaying).toBe(false);
  });

  it('marks a guest as playing when QUEUE_UPDATE selects an item', () => {
    const controller = makeController();
    const { result } = mount(controller, false);

    act(() => {
      result.current.handleIncoming(snapshot(false), 'host-1');
    });
    expect(result.current.isPlaying).toBe(false);

    act(() => {
      result.current.handleIncoming(
        {
          type: 'QUEUE_UPDATE',
          queue: ITEMS,
          currentId: ITEMS[1].id,
          currentTime: 0,
          senderId: 'host-1',
        },
        'host-1'
      );
    });

    expect(controller.play).toHaveBeenCalled();
    expect(result.current.isPlaying).toBe(true);
  });

  it('marks a guest as paused when QUEUE_UPDATE clears the current item', () => {
    const controller = makeController();
    const { result } = mount(controller, false);

    act(() => {
      result.current.handleIncoming(snapshot(true), 'host-1');
    });
    expect(result.current.isPlaying).toBe(true);

    act(() => {
      result.current.handleIncoming(
        {
          type: 'QUEUE_UPDATE',
          queue: [],
          currentId: null,
          currentTime: 0,
          senderId: 'host-1',
        },
        'host-1'
      );
    });

    expect(result.current.isPlaying).toBe(false);
  });

  it('reflects the room playing state for a drive-mode guest without operating the player', () => {
    const controller = makeController();
    const { result } = mount(controller, false);

    act(() => {
      result.current.handleIncoming(
        { type: 'DRIVE_MODE', enabled: true, audioOnly: false, senderId: 'host-1' },
        'host-1'
      );
      result.current.handleIncoming(snapshot(false), 'host-1');
    });
    vi.mocked(controller.play).mockClear();
    vi.mocked(controller.pause).mockClear();

    act(() => {
      result.current.handleIncoming(
        {
          type: 'QUEUE_UPDATE',
          queue: ITEMS,
          currentId: ITEMS[1].id,
          currentTime: 0,
          senderId: 'host-1',
        },
        'host-1'
      );
    });

    expect(result.current.isPlaying).toBe(true);
    expect(controller.play).not.toHaveBeenCalled();

    act(() => {
      result.current.handleIncoming(
        {
          type: 'QUEUE_UPDATE',
          queue: [ITEMS[1]],
          currentId: ITEMS[1].id,
          currentTime: 0,
          senderId: 'host-1',
        },
        'host-1'
      );
    });
    act(() => {
      result.current.removeFromQueue(ITEMS[1].id);
    });

    expect(result.current.isPlaying).toBe(false);
    expect(controller.pause).not.toHaveBeenCalled();
  });
});
