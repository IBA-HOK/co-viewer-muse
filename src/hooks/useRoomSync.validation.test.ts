/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useRoomSync } from './useRoomSync';
import type { Participant, QueueItem, SyncMessage } from '../types';

const QUEUE: QueueItem[] = [
  {
    id: 'youtube:abc123def45',
    platform: 'youtube',
    videoId: 'abc123def45',
    addedBy: 'Host',
  },
];

const PARTICIPANTS: Participant[] = [
  { peerId: 'host-1', name: 'Host', isHost: true, role: 'Host' },
  { peerId: 'guest-1', name: 'Guest', isHost: false, role: 'Viewer' },
];

function mountGuest() {
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
  return result;
}

describe('useRoomSync · untrusted message validation', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline'))));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('ignores a QUEUE_UPDATE without a queue and keeps the previous queue', () => {
    const result = mountGuest();

    act(() => {
      result.current.handleIncoming(
        {
          type: 'QUEUE_UPDATE',
          queue: QUEUE,
          currentId: QUEUE[0].id,
          currentTime: 12,
          senderId: 'host-1',
        },
        'host-1'
      );
    });

    expect(result.current.queue).toEqual(QUEUE);
    expect(result.current.currentId).toBe(QUEUE[0].id);

    expect(() => {
      act(() => {
        result.current.handleIncoming(
          { type: 'QUEUE_UPDATE', senderId: 'host-1' } as unknown as SyncMessage,
          'host-1'
        );
      });
    }).not.toThrow();

    expect(result.current.queue).toEqual(QUEUE);
    expect(result.current.currentId).toBe(QUEUE[0].id);
  });

  it('ignores PARTICIPANTS with a non-array payload and keeps the participant list', () => {
    const result = mountGuest();

    act(() => {
      result.current.handleIncoming(
        { type: 'PARTICIPANTS', participants: PARTICIPANTS, senderId: 'host-1' },
        'host-1'
      );
    });

    expect(result.current.participants).toEqual(PARTICIPANTS);

    expect(() => {
      act(() => {
        result.current.handleIncoming(
          { type: 'PARTICIPANTS', senderId: 'host-1' } as unknown as SyncMessage,
          'host-1'
        );
      });
    }).not.toThrow();

    expect(result.current.participants).toEqual(PARTICIPANTS);
  });

  it('ignores a CHAT_MESSAGE with non-string text and keeps the chat unchanged', () => {
    const result = mountGuest();

    act(() => {
      result.current.handleIncoming(
        {
          type: 'CHAT_MESSAGE',
          peerId: 'host-1',
          name: 'Host',
          text: 'hello',
          timestamp: 1,
          senderId: 'host-1',
        },
        'host-1'
      );
    });

    expect(result.current.chat).toHaveLength(1);
    expect(result.current.chatSeq).toBe(1);

    expect(() => {
      act(() => {
        result.current.handleIncoming(
          {
            type: 'CHAT_MESSAGE',
            peerId: 'host-2',
            name: 'Host 2',
            text: 42,
            timestamp: 2,
            senderId: 'host-2',
          } as unknown as SyncMessage,
          'host-2'
        );
      });
    }).not.toThrow();

    expect(result.current.chat).toHaveLength(1);
    expect(result.current.chat[0].text).toBe('hello');
    expect(result.current.chatSeq).toBe(1);
  });

  it('still applies valid QUEUE_UPDATE, PARTICIPANTS and CHAT_MESSAGE messages', () => {
    const result = mountGuest();

    act(() => {
      result.current.handleIncoming(
        {
          type: 'QUEUE_UPDATE',
          queue: QUEUE,
          currentId: QUEUE[0].id,
          currentTime: 12,
          senderId: 'host-1',
        },
        'host-1'
      );
      result.current.handleIncoming(
        { type: 'PARTICIPANTS', participants: PARTICIPANTS, senderId: 'host-1' },
        'host-1'
      );
      result.current.handleIncoming(
        {
          type: 'CHAT_MESSAGE',
          peerId: 'host-1',
          name: 'Host',
          text: 'hello',
          timestamp: 1,
          senderId: 'host-1',
        },
        'host-1'
      );
    });

    expect(result.current.queue).toEqual(QUEUE);
    expect(result.current.currentId).toBe(QUEUE[0].id);
    expect(result.current.participants).toEqual(PARTICIPANTS);
    expect(result.current.chat).toHaveLength(1);
    expect(result.current.chat[0].text).toBe('hello');
  });
});
