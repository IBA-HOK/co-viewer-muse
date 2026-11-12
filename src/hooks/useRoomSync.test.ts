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
  result.current.controllerRef.current = controller;
  return { result, broadcast, sendTo };
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
    vi.mocked(controller.play).mockClear();
    vi.mocked(controller.getCurrentTime).mockReturnValue(30);

    act(() => {
      result.current.goToItem('youtube:first000001');
    });

    expect(controller.loadMedia).toHaveBeenCalledWith('first000001');
    expect(controller.seekTo).toHaveBeenCalledWith(0);
    expect(controller.play).toHaveBeenCalledTimes(1);
    expect(lastQueueUpdate(broadcast)).toMatchObject({
      type: 'QUEUE_UPDATE',
      currentId: 'youtube:first000001',
      currentTime: 0,
      restart: true,
    });
  });

  it('does not mark a switch to a different queue item as a restart', () => {
    const controller = makeController();
    const { result, broadcast } = mountHost(controller);
    seedQueue(result, ['first000001', 'second00001']);

    act(() => {
      result.current.goToItem('youtube:second00001');
    });

    expect(lastQueueUpdate(broadcast)).toMatchObject({
      type: 'QUEUE_UPDATE',
      currentId: 'youtube:second00001',
      currentTime: 0,
    });
    expect(lastQueueUpdate(broadcast)?.restart).toBeUndefined();
  });

  it('reloads and plays at zero on a guest for a restarted current item', () => {
    const controller = makeController();
    const result = mountGuest(controller);

    act(() => {
      result.current.handleIncoming(
        {
          type: 'QUEUE_UPDATE',
          queue: QUEUE,
          currentId: QUEUE[0].id,
          currentTime: 25,
          senderId: 'host-1',
        },
        'host-1'
      );
    });
    vi.mocked(controller.loadMedia).mockClear();
    vi.mocked(controller.seekTo).mockClear();
    vi.mocked(controller.play).mockClear();

    act(() => {
      result.current.handleIncoming(
        {
          type: 'QUEUE_UPDATE',
          queue: QUEUE,
          currentId: QUEUE[0].id,
          currentTime: 0,
          restart: true,
          senderId: 'host-1',
        },
        'host-1'
      );
    });

    expect(controller.loadMedia).toHaveBeenCalledTimes(1);
    expect(controller.loadMedia).toHaveBeenCalledWith('abc123def45');
    expect(controller.seekTo).toHaveBeenCalledTimes(1);
    expect(controller.seekTo).toHaveBeenCalledWith(0);
    expect(controller.play).toHaveBeenCalledTimes(1);
    expect(result.current.isPlaying).toBe(true);
  });

  it('does not reload for a non-restart update of the same current item', () => {
    const controller = makeController();
    const result = mountGuest(controller);

    act(() => {
      result.current.handleIncoming(
        {
          type: 'QUEUE_UPDATE',
          queue: QUEUE,
          currentId: QUEUE[0].id,
          currentTime: 25,
          senderId: 'host-1',
        },
        'host-1'
      );
    });
    vi.mocked(controller.loadMedia).mockClear();
    vi.mocked(controller.seekTo).mockClear();
    vi.mocked(controller.play).mockClear();

    act(() => {
      result.current.handleIncoming(
        {
          type: 'QUEUE_UPDATE',
          queue: QUEUE,
          currentId: QUEUE[0].id,
          currentTime: 25,
          senderId: 'host-1',
        },
        'host-1'
      );
    });

    expect(controller.loadMedia).not.toHaveBeenCalled();
    expect(controller.seekTo).not.toHaveBeenCalled();
    expect(controller.play).not.toHaveBeenCalled();
  });

  it('applies its own restart echo without reloading the player twice', () => {
    const controller = makeController();
    const result = mountGuest(controller);
    const updatedQueue: QueueItem[] = [
      ...QUEUE,
      { id: 'youtube:extra000001', platform: 'youtube', videoId: 'extra000001', addedBy: 'Host' },
    ];

    act(() => {
      result.current.handleIncoming(
        {
          type: 'QUEUE_UPDATE',
          queue: QUEUE,
          currentId: QUEUE[0].id,
          currentTime: 25,
          senderId: 'host-1',
        },
        'host-1'
      );
    });
    vi.mocked(controller.loadMedia).mockClear();
    vi.mocked(controller.seekTo).mockClear();
    vi.mocked(controller.play).mockClear();

    act(() => {
      result.current.handleIncoming(
        {
          type: 'QUEUE_UPDATE',
          queue: updatedQueue,
          currentId: QUEUE[0].id,
          currentTime: 0,
          restart: true,
          senderId: 'guest-1',
        },
        'guest-1'
      );
    });

    expect(result.current.queue).toHaveLength(2);
    expect(result.current.currentId).toBe(QUEUE[0].id);
    expect(controller.loadMedia).not.toHaveBeenCalled();
    expect(controller.seekTo).not.toHaveBeenCalled();
    expect(controller.play).not.toHaveBeenCalled();
  });

  it('reloads on the host when a guest Controller restarts the current item', () => {
    const controller = makeController();
    const { result, broadcast } = mountHost(controller);
    seedQueue(result, ['first000001']);
    vi.mocked(controller.loadMedia).mockClear();
    vi.mocked(controller.seekTo).mockClear();
    vi.mocked(controller.play).mockClear();

    act(() => {
      result.current.handleIncoming(
        {
          type: 'QUEUE_UPDATE',
          queue: [
            {
              id: 'youtube:first000001',
              platform: 'youtube',
              videoId: 'first000001',
              addedBy: 'Host',
            },
          ],
          currentId: 'youtube:first000001',
          currentTime: 0,
          restart: true,
          senderId: 'guest-1',
        },
        'guest-1'
      );
    });

    expect(controller.loadMedia).toHaveBeenCalledWith('first000001');
    expect(controller.seekTo).toHaveBeenCalledWith(0);
    expect(controller.play).toHaveBeenCalledTimes(1);
    expect(lastQueueUpdate(broadcast)).toMatchObject({
      type: 'QUEUE_UPDATE',
      currentId: 'youtube:first000001',
      currentTime: 0,
      restart: true,
      senderId: 'guest-1',
    });
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

describe('useRoomSync · myId changes on transport switch', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline'))));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('replaces the stale host entry when myId changes', () => {
    const { result, rerender } = renderHook(
      ({ myId }: { myId: string }) =>
        useRoomSync({
          isHost: true,
          myId,
          connected: true,
          myName: 'Host',
          broadcast: vi.fn(),
          sendTo: vi.fn(),
        }),
      { initialProps: { myId: 'peerjs-host' } }
    );

    act(() => {
      result.current.onGuestJoined('guest-1', 'Alice');
    });
    expect(
      result.current.participants.some((p) => p.peerId === 'peerjs-host')
    ).toBe(true);

    rerender({ myId: 'mqtt-host' });

    const hosts = result.current.participants.filter((p) => p.isHost);
    expect(hosts).toHaveLength(1);
    expect(hosts[0].peerId).toBe('mqtt-host');
    expect(
      result.current.participants.some((p) => p.peerId === 'peerjs-host')
    ).toBe(false);
    expect(
      result.current.participants.some(
        (p) => p.peerId === 'guest-1' && p.name === 'Alice'
      )
    ).toBe(true);
  });

  it('removes the old guest self and keeps other participants', () => {
    const { result, rerender } = renderHook(
      ({ myId }: { myId: string }) =>
        useRoomSync({
          isHost: false,
          myId,
          connected: true,
          myName: 'Guest',
          broadcast: vi.fn(),
          sendTo: vi.fn(),
        }),
      { initialProps: { myId: 'peerjs-guest' } }
    );

    act(() => {
      result.current.handleIncoming(
        {
          type: 'PARTICIPANTS',
          participants: [
            { peerId: 'peerjs-guest', name: 'Guest', isHost: false, role: 'Viewer' },
            { peerId: 'guest-alice', name: 'Alice', isHost: false, role: 'Viewer' },
            { peerId: 'host-1', name: 'Host (Host)', isHost: true, role: 'Host' },
          ],
          senderId: 'host-1',
        },
        'host-1'
      );
    });

    rerender({ myId: 'mqtt-guest' });

    const selves = result.current.participants.filter(
      (p) => p.peerId === 'peerjs-guest' || p.peerId === 'mqtt-guest'
    );
    expect(selves).toHaveLength(1);
    expect(selves[0].peerId).toBe('mqtt-guest');
    expect(
      result.current.participants.some((p) => p.peerId === 'guest-alice')
    ).toBe(true);
    // The remote host entry is not the host client itself, so it survives.
    expect(
      result.current.participants.filter((p) => p.isHost)
    ).toHaveLength(1);
  });

  it('does not change participants when myId is unchanged', () => {
    const { result, rerender } = renderHook(
      ({ myId }: { myId: string }) =>
        useRoomSync({
          isHost: true,
          myId,
          connected: true,
          myName: 'Host',
          broadcast: vi.fn(),
          sendTo: vi.fn(),
        }),
      { initialProps: { myId: 'host-1' } }
    );

    act(() => {
      result.current.onGuestJoined('guest-1', 'Alice');
    });
    const before = result.current.participants;

    rerender({ myId: 'host-1' });

    expect(result.current.participants).toBe(before);
  });
});

describe('useRoomSync · NAME_UPDATE controller memory migration', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline'))));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function setupController(controllerName: string) {
    const controller = makeController();
    const { result, broadcast } = mountHost(controller);
    act(() => {
      result.current.onGuestJoined('guest-1', controllerName);
    });
    act(() => {
      result.current.delegateController('guest-1', 'Controller');
    });
    return { result, broadcast };
  }

  it('restores Controller after the guest renames and reconnects', () => {
    const { result } = setupController('Alice');

    act(() => {
      result.current.handleIncoming(
        { type: 'NAME_UPDATE', peerId: 'guest-1', name: 'Bob', senderId: 'guest-1' },
        'guest-1'
      );
    });
    act(() => {
      result.current.onGuestLeft('guest-1');
    });
    act(() => {
      result.current.onGuestJoined('guest-1', 'Bob');
    });

    expect(
      result.current.participants.find((p) => p.peerId === 'guest-1')?.role
    ).toBe('Controller');
  });

  it('does not let a new guest inherit the old name after a Viewer demotion', () => {
    const { result } = setupController('Alice');

    act(() => {
      result.current.handleIncoming(
        { type: 'NAME_UPDATE', peerId: 'guest-1', name: 'Bob', senderId: 'guest-1' },
        'guest-1'
      );
    });
    act(() => {
      result.current.delegateController('guest-1', 'Viewer');
    });
    act(() => {
      result.current.onGuestJoined('guest-2', 'Alice');
    });

    expect(
      result.current.participants.find((p) => p.peerId === 'guest-2')?.role
    ).toBe('Viewer');
  });

  it('updates the displayed name and broadcasts participants once', () => {
    const { result, broadcast } = setupController('Alice');
    broadcast.mockClear();

    act(() => {
      result.current.handleIncoming(
        { type: 'NAME_UPDATE', peerId: 'guest-1', name: 'Bob', senderId: 'guest-1' },
        'guest-1'
      );
    });

    expect(
      result.current.participants.find((p) => p.peerId === 'guest-1')?.name
    ).toBe('Bob');
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(broadcast).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'PARTICIPANTS' })
    );
  });
});


describe('useRoomSync · REQUEST_STATE reconnect recovery', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline'))));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function messagesTo(sendTo: ReturnType<typeof vi.fn>, peerId: string): SyncMessage[] {
    return sendTo.mock.calls
      .filter((call) => call[0] === peerId)
      .map((call) => call[1] as SyncMessage);
  }

  it('replays the full participants list even without currentMedia', () => {
    const { result, broadcast, sendTo } = mountHost(makeController());
    act(() => {
      result.current.onGuestJoined('peer-a', 'Alice');
    });
    act(() => {
      result.current.onGuestJoined('peer-b', 'Bob');
    });
    sendTo.mockClear();
    broadcast.mockClear();

    act(() => {
      result.current.handleIncoming(
        { type: 'REQUEST_STATE', senderId: 'peer-a' },
        'peer-a'
      );
    });

    const messages = messagesTo(sendTo, 'peer-a');
    const participantsMsg = messages.find((m) => m.type === 'PARTICIPANTS');
    expect(participantsMsg?.type).toBe('PARTICIPANTS');
    if (participantsMsg?.type !== 'PARTICIPANTS') throw new Error('unreachable');
    expect(participantsMsg.participants).toHaveLength(3);
    expect(participantsMsg.participants.map((p) => p.peerId).sort()).toEqual([
      'host-1',
      'peer-a',
      'peer-b',
    ]);
    expect(messages.some((m) => m.type === 'STATE_SNAPSHOT')).toBe(false);
    expect(messages.some((m) => m.type === 'QUEUE_UPDATE')).toBe(false);
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('replays drive mode and VC state to the requesting guest', () => {
    const { result, sendTo } = mountHost(makeController());
    act(() => {
      result.current.onGuestJoined('peer-a', 'Alice');
    });
    act(() => {
      result.current.onGuestJoined('peer-b', 'Bob');
    });
    act(() => {
      result.current.handleIncoming(
        { type: 'VC_PEER', peerId: 'peer-b', inVc: true, senderId: 'peer-b' },
        'peer-b'
      );
    });
    act(() => {
      result.current.setVcActive(true);
      result.current.setDriveMode(true);
      result.current.setDriveAudioOnly(true);
    });
    sendTo.mockClear();

    act(() => {
      result.current.handleIncoming(
        { type: 'REQUEST_STATE', senderId: 'peer-a' },
        'peer-a'
      );
    });

    const messages = messagesTo(sendTo, 'peer-a');
    expect(messages).toContainEqual(
      expect.objectContaining({
        type: 'DRIVE_MODE',
        enabled: true,
        audioOnly: true,
      })
    );
    expect(messages).toContainEqual(
      expect.objectContaining({ type: 'VC_STATE', active: true })
    );
    expect(messages).toContainEqual(
      expect.objectContaining({
        type: 'VC_PEER',
        peerId: 'peer-b',
        inVc: true,
      })
    );
    expect(messages.some((m) => m.type === 'PARTICIPANTS')).toBe(true);
  });

  it('ignores REQUEST_STATE on a guest', () => {
    const sendTo = vi.fn();
    const { result } = renderHook(() =>
      useRoomSync({
        isHost: false,
        myId: 'guest-1',
        connected: true,
        myName: 'Guest',
        broadcast: vi.fn(),
        sendTo,
      })
    );
    sendTo.mockClear();

    act(() => {
      result.current.handleIncoming(
        { type: 'REQUEST_STATE', senderId: 'peer-a' },
        'peer-a'
      );
    });

    expect(sendTo).not.toHaveBeenCalled();
  });
});
