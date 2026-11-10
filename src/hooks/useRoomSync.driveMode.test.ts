/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useRoomSync } from './useRoomSync';
import type { SyncMessage } from '../types';

function mountHost() {
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
  return { result, broadcast, sendTo };
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
  return { result, broadcast };
}

function roleOf(
  participants: ReturnType<typeof mountHost>['result']['current']['participants'],
  peerId: string
) {
  return participants.find((p) => p.peerId === peerId)?.role;
}

function lastParticipantsMessage(broadcast: ReturnType<typeof vi.fn>) {
  const messages = broadcast.mock.calls
    .map((c) => c[0] as SyncMessage)
    .filter((m) => m.type === 'PARTICIPANTS');
  return messages[messages.length - 1];
}

describe('useRoomSync · drive mode role restore', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline'))));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('restores the pre-drive roles and broadcasts the restored PARTICIPANTS', () => {
    const { result, broadcast } = mountHost();

    act(() => {
      result.current.onGuestJoined('peer-a', 'Alice');
    });
    act(() => {
      result.current.onGuestJoined('peer-b', 'Bob');
    });
    act(() => {
      result.current.delegateController('peer-a', 'Controller');
    });
    act(() => {
      result.current.delegateController('peer-b', 'Viewer');
    });

    act(() => {
      result.current.setDriveMode(true);
    });
    expect(roleOf(result.current.participants, 'peer-a')).toBe('Controller');
    expect(roleOf(result.current.participants, 'peer-b')).toBe('Controller');

    broadcast.mockClear();
    act(() => {
      result.current.setDriveMode(false);
    });

    expect(roleOf(result.current.participants, 'peer-a')).toBe('Controller');
    expect(roleOf(result.current.participants, 'peer-b')).toBe('Viewer');

    const message = lastParticipantsMessage(broadcast);
    expect(message?.type).toBe('PARTICIPANTS');
    if (message?.type !== 'PARTICIPANTS') throw new Error('unreachable');
    expect(message.participants).toEqual(result.current.participants);
  });

  it('defaults a guest who joined during drive mode to Viewer after OFF', () => {
    const { result } = mountHost();

    act(() => {
      result.current.setDriveMode(true);
    });
    act(() => {
      result.current.onGuestJoined('peer-c', 'Charlie');
    });
    expect(roleOf(result.current.participants, 'peer-c')).toBe('Controller');

    act(() => {
      result.current.setDriveMode(false);
    });

    expect(roleOf(result.current.participants, 'peer-c')).toBe('Viewer');
  });

  it('keeps a manual role change made during drive mode after OFF', () => {
    const { result } = mountHost();

    act(() => {
      result.current.onGuestJoined('peer-a', 'Alice');
    });
    act(() => {
      result.current.setDriveMode(true);
    });
    act(() => {
      result.current.delegateController('peer-a', 'Viewer');
    });

    act(() => {
      result.current.setDriveMode(false);
    });

    expect(roleOf(result.current.participants, 'peer-a')).toBe('Viewer');
  });

  it('returns a drive-mode guest to Viewer so canControl and PLAY broadcast stop', () => {
    const { result, broadcast } = mountGuest();

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
      result.current.handleIncoming(
        { type: 'DRIVE_MODE', enabled: true, audioOnly: false, senderId: 'host-1' },
        'host-1'
      );
    });
    expect(result.current.canControl).toBe(true);

    // Host OFF broadcasts the restored PARTICIPANTS and then DRIVE_MODE(false).
    act(() => {
      result.current.handleIncoming(
        {
          type: 'PARTICIPANTS',
          participants: [
            { peerId: 'guest-1', name: 'Guest', isHost: false, role: 'Viewer' },
          ],
          senderId: 'host-1',
        },
        'host-1'
      );
      result.current.handleIncoming(
        { type: 'DRIVE_MODE', enabled: false, audioOnly: false, senderId: 'host-1' },
        'host-1'
      );
    });

    expect(result.current.canControl).toBe(false);

    broadcast.mockClear();
    act(() => {
      result.current.reportLocalEvent({ kind: 'PLAY', currentTime: 10 });
    });
    expect(broadcast).not.toHaveBeenCalled();
  });
});
