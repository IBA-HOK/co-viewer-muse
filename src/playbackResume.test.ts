import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { scheduleResumeRetries } from './playbackResume';

function setup(overrides: Partial<Parameters<typeof scheduleResumeRetries>[0]> = {}) {
  let roomPlaying = true;
  let playerPlaying = false;
  const play = vi.fn(() => {
    playerPlaying = true;
  });
  const scheduler = scheduleResumeRetries({
    isRoomPlaying: () => roomPlaying,
    isPlayerPlaying: () => playerPlaying,
    isDocumentHidden: () => false,
    play,
    ...overrides,
  });
  return {
    scheduler,
    play,
    setRoomPlaying: (value: boolean) => {
      roomPlaying = value;
    },
    setPlayerPlaying: (value: boolean) => {
      playerPlaying = value;
    },
  };
}

describe('scheduleResumeRetries', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not play any later retry once the room stops before 900ms', () => {
    const { play, setRoomPlaying } = setup({
      // Keep the fake player from reporting success so every delay is exercised.
      isPlayerPlaying: () => false,
    });

    vi.advanceTimersByTime(400);
    expect(play).toHaveBeenCalledTimes(3);

    setRoomPlaying(false);
    const callsBeforePause = play.mock.calls.length;
    vi.advanceTimersByTime(3000);

    expect(play).toHaveBeenCalledTimes(callsBeforePause);
  });

  it('stops the remaining retries when cancel() is called', () => {
    const { scheduler, play } = setup({ isPlayerPlaying: () => false });

    vi.advanceTimersByTime(100);
    expect(play).toHaveBeenCalledTimes(1);

    scheduler.cancel();
    vi.advanceTimersByTime(3000);

    expect(play).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps retrying while the room is playing and stops once playback succeeds', () => {
    const retrying = setup({ isPlayerPlaying: () => false });
    vi.advanceTimersByTime(3000);
    expect(retrying.play).toHaveBeenCalledTimes(6);

    const succeeding = setup();
    vi.advanceTimersByTime(0);
    expect(succeeding.play).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(3000);
    expect(succeeding.play).toHaveBeenCalledTimes(1);
  });
});
