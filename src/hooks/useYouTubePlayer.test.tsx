/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act, waitFor } from '@testing-library/react';
import type { MutableRefObject } from 'react';
import { useYouTubePlayer, type UseYouTubePlayerResult } from './useYouTubePlayer';

const PLAYER_STATE = {
  UNSTARTED: -1,
  ENDED: 0,
  PLAYING: 1,
  PAUSED: 2,
  BUFFERING: 3,
  CUED: 5,
} as const;

interface FakeEvents {
  onReady?: () => void;
  onStateChange?: (e: { target: unknown; data: number }) => void;
  onError?: (e: { data: number }) => void;
}

class FakePlayer {
  seekTo = vi.fn();
  loadVideoById = vi.fn();
  getCurrentTime = vi.fn(() => 12.5);
  playVideo = vi.fn();
  pauseVideo = vi.fn();
  setVolume = vi.fn();
  getVolume = vi.fn(() => 100);
  destroy = vi.fn();
  readonly events: FakeEvents;

  constructor(_el: HTMLElement, options: { events?: FakeEvents }) {
    this.events = options.events ?? {};
  }

  emitReady() {
    this.events.onReady?.();
  }

  emitState(state: number) {
    this.events.onStateChange?.({ target: this, data: state });
  }

  emitError(data: number) {
    this.events.onError?.({ data });
  }
}

let player: FakePlayer | null = null;
let latest: UseYouTubePlayerResult | null = null;

function installYouTubeStub() {
  player = null;
  latest = null;
  (window as unknown as { YT?: unknown }).YT = {
    Player: function PlayerMock(
      el: HTMLElement,
      options: { events?: FakeEvents }
    ) {
      player = new FakePlayer(el, options);
      return player;
    },
    PlayerState: PLAYER_STATE,
  };
}

function Harness(props: {
  isRemoteSyncingRef: MutableRefObject<boolean>;
  onLocalEvent: (e: { kind: 'PLAY'; currentTime: number } | { kind: 'PAUSE'; currentTime: number } | { kind: 'END' }) => void;
}) {
  const yt = useYouTubePlayer({
    isRemoteSyncingRef: props.isRemoteSyncingRef,
    onLocalEvent: props.onLocalEvent,
  });
  latest = yt;
  return <div ref={yt.containerRef} />;
}

async function mountHook() {
  const isRemoteSyncingRef = { current: false } as MutableRefObject<boolean>;
  const onLocalEvent = vi.fn();
  const view = render(
    <Harness isRemoteSyncingRef={isRemoteSyncingRef} onLocalEvent={onLocalEvent} />
  );
  await waitFor(() => expect(player).not.toBeNull());
  act(() => player!.emitReady());
  await waitFor(() => expect(latest?.ready).toBe(true));
  const result = {
    get current(): UseYouTubePlayerResult {
      if (!latest) throw new Error('hook not mounted');
      return latest;
    },
  };
  return { result, onLocalEvent, isRemoteSyncingRef, unmount: view.unmount };
}

beforeEach(() => {
  installYouTubeStub();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete (window as unknown as { YT?: unknown }).YT;
  latest = null;
});

describe('useYouTubePlayer · buffering-aware seeking', () => {
  it('applies a seek immediately when not buffering', async () => {
    const { result } = await mountHook();
    act(() => result.current.seekTo(42));
    expect(player!.seekTo).toHaveBeenCalledTimes(1);
    expect(player!.seekTo).toHaveBeenCalledWith(42, true);
  });

  it('coalesces seeks while buffering and applies only the newest when loading ends', async () => {
    const { result, onLocalEvent } = await mountHook();
    act(() => player!.emitState(PLAYER_STATE.BUFFERING));
    expect(result.current.isBuffering()).toBe(true);

    act(() => result.current.seekTo(20));
    act(() => result.current.seekTo(30));
    expect(player!.seekTo).not.toHaveBeenCalled();

    act(() => player!.emitState(PLAYER_STATE.PLAYING));
    expect(player!.seekTo).toHaveBeenCalledTimes(1);
    expect(player!.seekTo).toHaveBeenCalledWith(30, true);
    expect(result.current.isBuffering()).toBe(false);
    // The intermediate PLAYING belongs to the seek, not to a user action.
    expect(onLocalEvent).not.toHaveBeenCalled();
  });

  it('reports how long the last seek spent buffering', async () => {
    const { result, onLocalEvent } = await mountHook();
    act(() => player!.emitState(PLAYER_STATE.PLAYING));
    onLocalEvent.mockClear();

    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(10_000);
    act(() => result.current.seekTo(30));

    nowSpy.mockReturnValue(13_500);
    act(() => player!.emitState(PLAYER_STATE.BUFFERING));
    expect(result.current.getSeekRecoveryMs()).toBe(0);

    nowSpy.mockReturnValue(18_200);
    act(() => player!.emitState(PLAYER_STATE.PLAYING));

    expect(result.current.getSeekRecoveryMs()).toBe(8_200);
    // The PLAYING event was the seek completing; it must not be re-broadcast.
    expect(onLocalEvent).not.toHaveBeenCalled();
  });

  it('records a long buffering recovery that outlives the 20s safety timer', async () => {
    const { result } = await mountHook();
    act(() => player!.emitState(PLAYER_STATE.PLAYING));

    vi.useFakeTimers();
    act(() => result.current.seekTo(30));
    act(() => player!.emitState(PLAYER_STATE.BUFFERING));
    act(() => {
      vi.advanceTimersByTime(25_000);
    });
    act(() => player!.emitState(PLAYER_STATE.PLAYING));
    // ~25s of buffering is still a measured recovery (the tolerance itself is
    // capped by the drift policy, but it must not be lost to the safety timer).
    expect(result.current.getSeekRecoveryMs()).toBeGreaterThanOrEqual(20_000);
  });

  it('does not treat a pause as a seek recovery', async () => {
    const { result } = await mountHook();
    act(() => player!.emitState(PLAYER_STATE.PLAYING));

    vi.useFakeTimers();
    act(() => result.current.seekTo(30));
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    act(() => player!.emitState(PLAYER_STATE.PAUSED));
    expect(result.current.getSeekRecoveryMs()).toBe(0);
  });

  it('resets the measured recovery when a new video is loaded', async () => {
    const { result } = await mountHook();
    act(() => player!.emitState(PLAYER_STATE.PLAYING));

    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(10_000);
    act(() => result.current.seekTo(30));
    nowSpy.mockReturnValue(16_000);
    act(() => player!.emitState(PLAYER_STATE.BUFFERING));
    act(() => player!.emitState(PLAYER_STATE.PLAYING));
    expect(result.current.getSeekRecoveryMs()).toBe(6_000);

    act(() => result.current.loadMedia('ccccccccccc'));
    expect(result.current.getSeekRecoveryMs()).toBe(0);
  });

  it('expires the measured recovery after a couple of minutes of healthy playback', async () => {
    const { result } = await mountHook();
    act(() => player!.emitState(PLAYER_STATE.PLAYING));

    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(10_000);
    act(() => result.current.seekTo(30));
    nowSpy.mockReturnValue(16_000);
    act(() => player!.emitState(PLAYER_STATE.BUFFERING));
    act(() => player!.emitState(PLAYER_STATE.PLAYING));
    expect(result.current.getSeekRecoveryMs()).toBe(6_000);

    nowSpy.mockReturnValue(16_000 + 120_001);
    expect(result.current.getSeekRecoveryMs()).toBe(0);
  });

  it('drops a queued seek when the user pauses instead of swallowing the pause', async () => {
    const { result, onLocalEvent } = await mountHook();
    act(() => player!.emitState(PLAYER_STATE.PLAYING));
    onLocalEvent.mockClear();

    act(() => player!.emitState(PLAYER_STATE.BUFFERING));
    act(() => result.current.seekTo(30));
    expect(player!.seekTo).not.toHaveBeenCalled();

    act(() => player!.emitState(PLAYER_STATE.PAUSED));
    expect(player!.seekTo).not.toHaveBeenCalled();
    expect(onLocalEvent).toHaveBeenCalledWith({
      kind: 'PAUSE',
      currentTime: 12.5,
    });
  });

  it('still reports a genuine PLAY event (no seek in flight)', async () => {
    const { result, onLocalEvent } = await mountHook();
    act(() => player!.emitState(PLAYER_STATE.PLAYING));
    expect(onLocalEvent).toHaveBeenCalledWith({ kind: 'PLAY', currentTime: 12.5 });
    act(() => player!.emitState(PLAYER_STATE.PAUSED));
    expect(onLocalEvent).toHaveBeenCalledWith({ kind: 'PAUSE', currentTime: 12.5 });
    void result;
  });

  it('expires the seek-recovery window when no state change ever arrives', async () => {
    const { result } = await mountHook();
    act(() => player!.emitState(PLAYER_STATE.PLAYING));

    vi.useFakeTimers();
    act(() => result.current.seekTo(30));
    act(() => {
      vi.advanceTimersByTime(8_001);
    });
    // A later pause must not be mistaken for a slow seek recovery.
    act(() => player!.emitState(PLAYER_STATE.PAUSED));
    expect(result.current.getSeekRecoveryMs()).toBe(0);
  });

  it('does not restart a load for the same video called twice in quick succession', async () => {
    const { result } = await mountHook();
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_000);

    act(() => result.current.loadMedia('aaaaaaaaaaa'));
    expect(player!.loadVideoById).toHaveBeenCalledTimes(1);

    act(() => result.current.loadMedia('aaaaaaaaaaa'));
    expect(player!.loadVideoById).toHaveBeenCalledTimes(1);

    nowSpy.mockReturnValue(4_000);
    act(() => result.current.loadMedia('aaaaaaaaaaa'));
    expect(player!.loadVideoById).toHaveBeenCalledTimes(2);

    act(() => result.current.loadMedia('bbbbbbbbbbb'));
    expect(player!.loadVideoById).toHaveBeenCalledTimes(3);
  });

  it('drops a stale queued seek when the video ends', async () => {
    const { result } = await mountHook();
    act(() => player!.emitState(PLAYER_STATE.BUFFERING));
    act(() => result.current.seekTo(50));
    act(() => player!.emitState(PLAYER_STATE.ENDED));
    expect(player!.seekTo).not.toHaveBeenCalled();
    expect(result.current.isBuffering()).toBe(false);
  });

  it('forces a queued seek after the watchdog delay if buffering never ends', async () => {
    const { result } = await mountHook();
    act(() => player!.emitState(PLAYER_STATE.BUFFERING));

    vi.useFakeTimers();
    act(() => result.current.seekTo(15));
    expect(player!.seekTo).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(10_001);
    });
    expect(player!.seekTo).toHaveBeenCalledTimes(1);
    expect(player!.seekTo).toHaveBeenCalledWith(15, true);
  });
});

describe('useYouTubePlayer · playback errors', () => {
  it('clears the error and loads a different video after a playback error', async () => {
    const { result } = await mountHook();
    act(() => player!.emitError(150));
    expect(result.current.error).not.toBeNull();

    act(() => result.current.loadMedia('bbbbbbbbbbb'));

    expect(player!.loadVideoById).toHaveBeenCalledWith('bbbbbbbbbbb');
    expect(result.current.error).toBeNull();
  });

  it('does not clear the error when the same video reload is deduped', async () => {
    const { result } = await mountHook();
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    act(() => result.current.loadMedia('aaaaaaaaaaa'));
    act(() => player!.emitError(150));

    act(() => result.current.loadMedia('aaaaaaaaaaa'));

    expect(player!.loadVideoById).toHaveBeenCalledTimes(1);
    expect(result.current.error).not.toBeNull();
    nowSpy.mockRestore();
  });

  it('clears the error once playback actually starts', async () => {
    const { result } = await mountHook();
    act(() => player!.emitError(101));
    expect(result.current.error).not.toBeNull();

    act(() => player!.emitState(PLAYER_STATE.PLAYING));

    expect(result.current.error).toBeNull();
  });
});
