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

function mountHost(controller: PlayerController) {
  const broadcast = vi.fn();
  const { result } = renderHook(() =>
    useRoomSync({
      isHost: true,
      myId: 'host-1',
      connected: true,
      myName: 'Host',
      broadcast,
      sendTo: vi.fn(),
    })
  );
  result.current.controllerRef.current = controller;
  return { result, broadcast };
}

function seedQueue(
  result: ReturnType<typeof mountHost>['result'],
  videoIds: string[]
) {
  for (const videoId of videoIds) {
    act(() => {
      result.current.localLoadMedia('youtube', videoId);
    });
  }
}

function lastQueueUpdate(broadcast: ReturnType<typeof vi.fn>): SyncMessage | undefined {
  const updates = broadcast.mock.calls
    .map((call) => call[0] as SyncMessage)
    .filter((msg) => msg.type === 'QUEUE_UPDATE');
  return updates[updates.length - 1];
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

describe('useRoomSync · queue item switch starts at zero', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline'))));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('seeks to zero and broadcasts currentTime 0 in goToItem', () => {
    const controller = makeController();
    const { result, broadcast } = mountHost(controller);
    seedQueue(result, ['first000001', 'second00001']);
    vi.mocked(controller.loadMedia).mockClear();
    vi.mocked(controller.seekTo).mockClear();
    vi.mocked(controller.play).mockClear();
    // The IFrame API can still report the previous video's playhead here.
    vi.mocked(controller.getCurrentTime).mockReturnValue(30);

    act(() => {
      result.current.goToItem('youtube:second00001');
    });

    expect(controller.loadMedia).toHaveBeenCalledWith('second00001');
    expect(controller.seekTo).toHaveBeenCalledWith(0);
    expect(controller.play).toHaveBeenCalledTimes(1);
    expect(lastQueueUpdate(broadcast)?.currentTime).toBe(0);
  });

  it('restarts from zero when the current item is reselected', () => {
    const controller = makeController();
    const { result, broadcast } = mountHost(controller);
    seedQueue(result, ['first000001']);
    vi.mocked(controller.loadMedia).mockClear();
    vi.mocked(controller.seekTo).mockClear();
    vi.mocked(controller.getCurrentTime).mockReturnValue(30);

    act(() => {
      result.current.goToItem('youtube:first000001');
    });

    expect(controller.loadMedia).toHaveBeenCalledWith('first000001');
    expect(controller.seekTo).toHaveBeenCalledWith(0);
    expect(lastQueueUpdate(broadcast)?.currentTime).toBe(0);
  });

  it('seeks to zero when removal advances to a replacement item', () => {
    const controller = makeController();
    const { result, broadcast } = mountHost(controller);
    seedQueue(result, ['first000001', 'second00001']);
    vi.mocked(controller.loadMedia).mockClear();
    vi.mocked(controller.seekTo).mockClear();
    vi.mocked(controller.play).mockClear();
    vi.mocked(controller.getCurrentTime).mockReturnValue(30);

    act(() => {
      result.current.removeFromQueue('youtube:first000001');
    });

    expect(controller.loadMedia).toHaveBeenCalledWith('second00001');
    expect(controller.seekTo).toHaveBeenCalledWith(0);
    expect(controller.play).toHaveBeenCalledTimes(1);
    expect(lastQueueUpdate(broadcast)?.currentTime).toBe(0);
  });

  it('loads and seeks to zero on the guest for a queue update', () => {
    const controller = makeController();
    const result = mountGuest(controller);

    act(() => {
      result.current.handleIncoming(
        {
          type: 'QUEUE_UPDATE',
          queue: QUEUE,
          currentId: QUEUE[0].id,
          currentTime: 0,
          senderId: 'host-1',
        },
        'host-1'
      );
    });

    expect(controller.loadMedia).toHaveBeenCalledWith('abc123def45');
    expect(controller.seekTo).toHaveBeenCalledWith(0);
    expect(controller.play).toHaveBeenCalledTimes(1);
  });
});

describe('useRoomSync · JOIN gesture playback', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline'))));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function mountGuestWithBroadcast(controller: PlayerController) {
    const broadcast = vi.fn();
    const { result } = renderHook(() =>
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
    return { result, broadcast };
  }

  it('plays before any room state arrives and suppresses the local sync', () => {
    const controller = makeController();
    const { result } = mountGuestWithBroadcast(controller);

    expect(result.current.hasReceivedRoomState).toBe(false);

    act(() => {
      result.current.playForGesture();
    });

    expect(controller.play).toHaveBeenCalledTimes(1);
    expect(controller.pause).not.toHaveBeenCalled();
    expect(result.current.isRemoteSyncingRef.current).toBe(true);
  });

  it('marks the room state as received on STATE_SNAPSHOT', () => {
    const controller = makeController();
    const { result } = mountGuestWithBroadcast(controller);

    act(() => {
      result.current.handleIncoming(snapshot(false), 'host-1');
    });

    expect(result.current.hasReceivedRoomState).toBe(true);
  });

  it('marks the room state as received on SYNC_PING', () => {
    const controller = makeController();
    const { result } = mountGuestWithBroadcast(controller);

    act(() => {
      result.current.handleIncoming(
        {
          type: 'SYNC_PING',
          currentTime: 10,
          isPlaying: false,
          sentAt: Date.now(),
          senderId: 'host-1',
        },
        'host-1'
      );
    });

    expect(result.current.hasReceivedRoomState).toBe(true);
  });

  it('does not start playback after a paused snapshot', () => {
    const controller = makeController();
    const { result, broadcast } = mountGuestWithBroadcast(controller);

    act(() => {
      result.current.handleIncoming(snapshot(false), 'host-1');
    });
    vi.mocked(controller.play).mockClear();
    vi.mocked(controller.pause).mockClear();
    broadcast.mockClear();

    act(() => {
      result.current.playForGesture();
    });

    expect(controller.play).not.toHaveBeenCalled();
    expect(controller.pause).toHaveBeenCalledTimes(1);
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('still starts playback after a playing snapshot', () => {
    const controller = makeController();
    const { result, broadcast } = mountGuestWithBroadcast(controller);

    act(() => {
      result.current.handleIncoming(snapshot(true), 'host-1');
    });
    vi.mocked(controller.play).mockClear();
    broadcast.mockClear();

    act(() => {
      result.current.playForGesture();
    });

    expect(controller.play).toHaveBeenCalledTimes(1);
    expect(controller.pause).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('does not broadcast PLAY for a Controller when the room is paused', () => {
    const controller = makeController();
    const { result, broadcast } = mountGuestWithBroadcast(controller);

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
      result.current.handleIncoming(snapshot(false), 'host-1');
    });
    broadcast.mockClear();

    act(() => {
      result.current.playForGesture();
    });

    expect(controller.play).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalled();
  });
});

describe('useRoomSync · chat sequence', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline'))));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('keeps incrementing chatSeq after the chat array reaches 200 messages', () => {
    const result = mountGuest(makeController());

    act(() => {
      for (let i = 1; i <= 201; i++) {
        result.current.handleIncoming(
          {
            type: 'CHAT_MESSAGE',
            peerId: 'peer-a',
            name: 'Peer A',
            text: `message ${i}`,
            timestamp: i,
            senderId: 'peer-a',
          },
          'peer-a'
        );
      }
    });

    expect(result.current.chat).toHaveLength(200);
    expect(result.current.chatSeq).toBe(201);

    act(() => {
      result.current.handleIncoming(
        {
          type: 'CHAT_MESSAGE',
          peerId: 'peer-a',
          name: 'Peer A',
          text: 'message 202',
          timestamp: 202,
          senderId: 'peer-a',
        },
        'peer-a'
      );
    });

    expect(result.current.chat).toHaveLength(200);
    expect(result.current.chatSeq).toBe(202);
  });

  it('increments chatSeq only once for a duplicate CHAT_MESSAGE id', () => {
    const result = mountGuest(makeController());
    const message = {
      type: 'CHAT_MESSAGE' as const,
      peerId: 'peer-a',
      name: 'Peer A',
      text: 'duplicate',
      timestamp: 1,
      senderId: 'peer-a',
    };

    act(() => {
      result.current.handleIncoming(message, 'peer-a');
      result.current.handleIncoming(message, 'peer-a');
    });

    expect(result.current.chat).toHaveLength(1);
    expect(result.current.chatSeq).toBe(1);
  });

  it('increments chatSeq for locally sent chat messages', () => {
    const result = mountGuest(makeController());

    act(() => {
      result.current.sendChat('hello');
    });

    expect(result.current.chat).toHaveLength(1);
    expect(result.current.chatSeq).toBe(1);
  });
});

describe('useRoomSync · STATE_SNAPSHOT before the controller is ready', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline'))));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function mountGuestWithoutController() {
    return renderHook(() =>
      useRoomSync({
        isHost: false,
        myId: 'guest-1',
        connected: true,
        myName: 'Guest',
        broadcast: vi.fn(),
        sendTo: vi.fn(),
      })
    ).result;
  }

  it('seeks and plays once when a playing snapshot is applied on ready', () => {
    const result = mountGuestWithoutController();

    act(() => {
      result.current.handleIncoming(snapshot(true), 'host-1');
    });

    const controller = makeController();
    act(() => {
      result.current.controllerRef.current = controller;
      result.current.onControllerReady();
      result.current.onControllerReady();
    });

    expect(controller.seekTo).toHaveBeenCalledTimes(1);
    expect(controller.seekTo).toHaveBeenCalledWith(42);
    expect(controller.play).toHaveBeenCalledTimes(1);
    expect(controller.pause).not.toHaveBeenCalled();
  });

  it('seeks and pauses once when a paused snapshot is applied on ready', () => {
    const result = mountGuestWithoutController();

    act(() => {
      result.current.handleIncoming(snapshot(false), 'host-1');
    });

    const controller = makeController();
    act(() => {
      result.current.controllerRef.current = controller;
      result.current.onControllerReady();
    });

    expect(controller.seekTo).toHaveBeenCalledTimes(1);
    expect(controller.seekTo).toHaveBeenCalledWith(42);
    expect(controller.pause).toHaveBeenCalledTimes(1);
    expect(controller.play).not.toHaveBeenCalled();
  });

  it('does not apply the previous video position after QUEUE_UPDATE selects another item', () => {
    const result = mountGuestWithoutController();
    const nextQueue: QueueItem[] = [
      { id: 'youtube:next1234567', platform: 'youtube', videoId: 'next1234567', addedBy: 'Host' },
    ];

    act(() => {
      result.current.handleIncoming(snapshot(true), 'host-1');
    });
    act(() => {
      result.current.handleIncoming(
        {
          type: 'QUEUE_UPDATE',
          queue: nextQueue,
          currentId: nextQueue[0].id,
          currentTime: 0,
          senderId: 'host-1',
        },
        'host-1'
      );
    });

    const controller = makeController();
    act(() => {
      result.current.controllerRef.current = controller;
      result.current.onControllerReady();
    });

    expect(controller.seekTo).toHaveBeenCalledTimes(1);
    expect(controller.seekTo).toHaveBeenCalledWith(0);
    expect(controller.play).toHaveBeenCalledTimes(1);
    expect(controller.seekTo).not.toHaveBeenCalledWith(42);
  });

  it('discards a pending snapshot when QUEUE_UPDATE clears the current item', () => {
    const result = mountGuestWithoutController();

    act(() => {
      result.current.handleIncoming(snapshot(true), 'host-1');
    });
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

    const controller = makeController();
    act(() => {
      result.current.controllerRef.current = controller;
      result.current.onControllerReady();
    });

    expect(controller.seekTo).not.toHaveBeenCalled();
    expect(controller.play).not.toHaveBeenCalled();
    expect(controller.pause).not.toHaveBeenCalled();
  });
});
