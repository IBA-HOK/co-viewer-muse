/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import type { PlayerController, SyncMessage } from './types';
import type { UseRoomSyncResult } from './hooks/useRoomSync';

const mocks = vi.hoisted(() => ({
  broadcast: vi.fn(),
  sendTo: vi.fn(),
  transport: null as unknown as Record<string, unknown>,
  playerProps: null as unknown as { reportLocalEvent: (e: unknown) => void } | null,
  roomSync: null as unknown as UseRoomSyncResult | null,
}));

vi.mock('./hooks/usePeer', () => ({
  usePeer: () => mocks.transport,
}));

vi.mock('./transport/mqtt', () => ({
  useMqttTransport: () => mocks.transport,
}));

vi.mock('./hooks/useVoiceChat', () => ({
  useVoiceChat: () => ({
    audioLevels: {},
    localLevel: 0,
    muted: false,
    deafened: false,
    inVc: false,
    joining: false,
    start: vi.fn(),
    stop: vi.fn(),
    toggleMute: vi.fn(),
    toggleDeafen: vi.fn(),
    isMuted: false,
    isDeafened: false,
  }),
}));

vi.mock('./hooks/useRoomSync', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./hooks/useRoomSync')>();
  return {
    ...actual,
    useRoomSync: (opts: Parameters<typeof actual.useRoomSync>[0]) => {
      const result = actual.useRoomSync(opts);
      mocks.roomSync = result;
      return result;
    },
  };
});

vi.mock('./components/Player', () => ({
  Player: (props: { reportLocalEvent: (e: unknown) => void }) => {
    mocks.playerProps = props;
    return null;
  },
}));

vi.mock('./components/QueuePanel', () => ({ default: () => null }));
vi.mock('./components/ChatPanel', () => ({ default: () => null }));
vi.mock('./components/ParticipantList', () => ({ default: () => null }));
vi.mock('./components/VoiceChatPanel', () => ({ default: () => null }));
vi.mock('./components/BrowserPanel', () => ({ default: () => null }));
vi.mock('./components/DriveModePanel', () => ({ default: () => null }));
vi.mock('./components/VolumeMixerPanel', () => ({ default: () => null }));
vi.mock('./components/JoinModal', () => ({ default: () => null }));
vi.mock('./components/InviteQRModal', () => ({ default: () => null }));

import App from './App';

function syncPings(): SyncMessage[] {
  return mocks.broadcast.mock.calls
    .map((call) => call[0] as SyncMessage)
    .filter((msg) => msg.type === 'SYNC_PING');
}

describe('App · SYNC_PING while the host tab is hidden', () => {
  let hidden = false;
  let playing = true;

  const controller: PlayerController = {
    loadMedia: vi.fn(),
    play: vi.fn(() => {
      playing = true;
    }),
    pause: vi.fn(() => {
      playing = false;
    }),
    seekTo: vi.fn(),
    getCurrentTime: vi.fn(() => 5),
    getIsPlaying: vi.fn(() => playing),
  };

  beforeEach(() => {
    hidden = false;
    playing = true;
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline'))));
    vi.useFakeTimers();
    mocks.broadcast.mockReset();
    mocks.sendTo.mockReset();
    mocks.playerProps = null;
    mocks.roomSync = null;
    mocks.transport = {
      isHost: true,
      myId: 'host-1',
      roomId: 'room-1',
      connected: true,
      topology: 'star',
      broadcast: mocks.broadcast,
      sendTo: mocks.sendTo,
      reconnect: vi.fn(),
      callPeer: vi.fn(() => null),
      onCall: vi.fn(),
    };
    Object.defineProperty(document, 'hidden', {
      configurable: true,
      get: () => hidden,
    });
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => (hidden ? 'hidden' : 'visible'),
    });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete (document as unknown as { hidden?: boolean }).hidden;
    delete (document as unknown as { visibilityState?: string }).visibilityState;
  });

  it('suppresses pings while hidden and resumes after tryResume succeeds', () => {
    render(<App />);
    expect(mocks.roomSync).not.toBeNull();
    expect(mocks.playerProps).not.toBeNull();

    act(() => {
      mocks.roomSync!.controllerRef.current = controller;
      mocks.roomSync!.localLoadMedia('youtube', 'abc123def45');
    });
    mocks.broadcast.mockClear();

    // A normal, visible host pings every interval.
    act(() => {
      vi.advanceTimersByTime(3_000);
    });
    expect(syncPings()).toHaveLength(1);
    mocks.broadcast.mockClear();

    hidden = true;
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });

    // The browser pauses the player locally while hidden; the wrapped reporter
    // must suppress that PAUSE and keep the room state untouched.
    playing = false;
    act(() => {
      mocks.playerProps!.reportLocalEvent({ kind: 'PAUSE', currentTime: 5 });
    });
    expect(
      mocks.broadcast.mock.calls.some(
        ([msg]) => (msg as SyncMessage).type === 'PAUSE'
      )
    ).toBe(false);

    act(() => {
      vi.advanceTimersByTime(6_000);
    });
    expect(syncPings()).toHaveLength(0);

    // Return to the tab: tryResume restarts the local player and only then may
    // pings be published again (with the true playing state).
    hidden = false;
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
      vi.advanceTimersByTime(1_000);
    });
    expect(playing).toBe(true);
    expect(syncPings()).toHaveLength(0);

    act(() => {
      vi.advanceTimersByTime(3_000);
    });
    const resumed = syncPings();
    expect(resumed).toHaveLength(1);
    expect(resumed[0]).toMatchObject({ type: 'SYNC_PING', isPlaying: true });
  });
});
