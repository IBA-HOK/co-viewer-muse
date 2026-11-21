/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useRoomSync } from './useRoomSync';
import type {
  LocalMediaMeta,
  PlayerController,
  QueueItem,
} from '../types';

const LOCAL_META: LocalMediaMeta = {
  fileName: 'holiday.mp4',
  sizeBytes: 123456,
  durationSec: 90,
  mimeType: 'video/mp4',
};

const LOCAL_ID = 'local-abcdefgh';

const LOCAL_ITEM: QueueItem = {
  id: `local:${LOCAL_ID}`,
  platform: 'local',
  videoId: LOCAL_ID,
  addedBy: 'Host',
  local: LOCAL_META,
};

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

function mount(options: { isHost: boolean; controller?: PlayerController }) {
  const broadcast = vi.fn();
  const sendTo = vi.fn();
  const { result, unmount } = renderHook(() =>
    useRoomSync({
      isHost: options.isHost,
      myId: options.isHost ? 'host-1' : 'guest-1',
      connected: true,
      myName: options.isHost ? 'Host' : 'Guest',
      broadcast,
      sendTo,
    })
  );
  if (options.controller) result.current.controllerRef.current = options.controller;
  return { result, broadcast, sendTo, unmount };
}

let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchSpy = vi.fn(() => Promise.reject(new Error('offline')));
  vi.stubGlobal('fetch', fetchSpy);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('useRoomSync · local file queue', () => {
  it('adds a local QueueItem with metadata and broadcasts it in QUEUE_UPDATE', () => {
    const { result, broadcast } = mount({ isHost: true });
    act(() => {
      result.current.localLoadMedia('local', LOCAL_ID, LOCAL_META);
    });

    expect(result.current.queue).toHaveLength(1);
    expect(result.current.queue[0]).toMatchObject({
      id: LOCAL_ITEM.id,
      platform: 'local',
      videoId: LOCAL_ID,
      local: LOCAL_META,
    });
    expect(result.current.currentMedia).toMatchObject({
      platform: 'local',
      videoId: LOCAL_ID,
      local: LOCAL_META,
    });

    const queueUpdate = broadcast.mock.calls
      .map(([msg]) => msg)
      .find((msg) => msg.type === 'QUEUE_UPDATE');
    expect(queueUpdate).toBeDefined();
    expect(queueUpdate.queue[0].local).toEqual(LOCAL_META);
    // File bytes never travel in a sync message: distribution uses the
    // dedicated PeerJS file channel. The sync contract only carries metadata
    // (no File/Blob/object URL/binary payload).
    const serialized = JSON.stringify(queueUpdate);
    expect(serialized).not.toContain('blob:');
    expect(serialized).not.toContain('objectUrl');
    expect(queueUpdate.queue[0].local).not.toBeInstanceOf(Blob);
    expect(serialized).not.toContain('ArrayBuffer');
    for (const value of Object.values(queueUpdate.queue[0].local ?? {})) {
      expect(value).not.toBeInstanceOf(Blob);
      expect(value).not.toBeInstanceOf(ArrayBuffer);
    }
  });

  it('keeps YouTube/Niconico items free of a local field', () => {
    const { result, broadcast } = mount({ isHost: true });
    act(() => {
      result.current.localLoadMedia('youtube', 'abc123def45');
    });
    const item = result.current.queue[0];
    expect(item.local).toBeUndefined();
    const queueUpdate = broadcast.mock.calls
      .map(([msg]) => msg)
      .find((msg) => msg.type === 'QUEUE_UPDATE');
    expect(queueUpdate.queue[0]).not.toHaveProperty('local');
  });

  it('defers the host autoplay until the local controller is ready', () => {
    const { result } = mount({ isHost: true });
    act(() => {
      result.current.localLoadMedia('local', LOCAL_ID, LOCAL_META);
    });

    const controller = makeController();
    act(() => {
      result.current.controllerRef.current = controller;
      result.current.onControllerReady();
    });

    expect(controller.seekTo).toHaveBeenCalledWith(0);
    expect(controller.play).toHaveBeenCalledTimes(1);
  });

  it('caches the host-shared file name without calling fetchTitle', () => {
    const { result } = mount({ isHost: true });
    act(() => {
      result.current.localLoadMedia('local', LOCAL_ID, LOCAL_META);
    });

    expect(result.current.titles[LOCAL_ITEM.id]).toBe('holiday.mp4');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('loads a remote local QUEUE_UPDATE on an already-mounted guest controller', () => {
    const controller = makeController();
    const { result } = mount({ isHost: false, controller });
    act(() => {
      result.current.handleIncoming(
        {
          type: 'QUEUE_UPDATE',
          queue: [LOCAL_ITEM],
          currentId: LOCAL_ITEM.id,
          currentTime: 12,
          senderId: 'host-1',
        },
        'host-1'
      );
    });

    expect(controller.loadMedia).toHaveBeenCalledWith(LOCAL_ID);
    expect(controller.seekTo).toHaveBeenCalledWith(12);
    expect(result.current.currentMedia?.local).toEqual(LOCAL_META);
  });

  it('restores local metadata and position from STATE_SNAPSHOT', () => {
    const controller = makeController();
    const { result } = mount({ isHost: false, controller });
    act(() => {
      result.current.handleIncoming(
        {
          type: 'STATE_SNAPSHOT',
          platform: 'local',
          videoId: LOCAL_ID,
          currentTime: 33,
          isPlaying: true,
          queue: [LOCAL_ITEM],
          currentId: LOCAL_ITEM.id,
          senderId: 'host-1',
        },
        'host-1'
      );
    });

    expect(result.current.currentMedia).toMatchObject({
      platform: 'local',
      videoId: LOCAL_ID,
      local: LOCAL_META,
    });
    expect(controller.loadMedia).toHaveBeenCalledWith(LOCAL_ID);
    expect(controller.seekTo).toHaveBeenCalledWith(33);
    expect(controller.play).toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('discards a malformed local queue item from a remote message', () => {
    const controller = makeController();
    const { result } = mount({ isHost: false, controller });
    act(() => {
      result.current.handleIncoming(
        {
          type: 'QUEUE_UPDATE',
          queue: [
            {
              ...LOCAL_ITEM,
              local: { ...LOCAL_META, sizeBytes: -1 },
            },
          ],
          currentId: LOCAL_ITEM.id,
          currentTime: 0,
          senderId: 'host-1',
        } as unknown as Parameters<typeof result.current.handleIncoming>[0],
        'host-1'
      );
    });

    expect(controller.loadMedia).not.toHaveBeenCalled();
    expect(result.current.queue).toHaveLength(0);
  });
});
