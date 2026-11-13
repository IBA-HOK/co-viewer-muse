import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  NICKNAME_BROADCAST_DELAY_MS,
  cancelNicknameBroadcast,
  flushNicknameBroadcast,
  scheduleNicknameBroadcast,
  type NicknameBroadcastTimer,
} from './nicknameBroadcast';

describe('scheduleNicknameBroadcast', () => {
  let timerRef: NicknameBroadcastTimer;

  beforeEach(() => {
    vi.useFakeTimers();
    timerRef = { current: null };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('broadcasts only the final value once after continuous typing', () => {
    const setMyNickname = vi.fn();

    scheduleNicknameBroadcast(timerRef, 'A', setMyNickname);
    vi.advanceTimersByTime(100);
    scheduleNicknameBroadcast(timerRef, 'Al', setMyNickname);
    vi.advanceTimersByTime(100);
    scheduleNicknameBroadcast(timerRef, 'Ali', setMyNickname);

    expect(setMyNickname).not.toHaveBeenCalled();

    vi.advanceTimersByTime(NICKNAME_BROADCAST_DELAY_MS - 1);
    expect(setMyNickname).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(setMyNickname).toHaveBeenCalledTimes(1);
    expect(setMyNickname).toHaveBeenCalledWith('Ali');
    expect(timerRef.current).toBeNull();
  });

  it('flushes a pending value immediately and never calls again from the timer', () => {
    const setMyNickname = vi.fn();

    scheduleNicknameBroadcast(timerRef, 'Ali', setMyNickname);
    flushNicknameBroadcast(timerRef, 'Ali', setMyNickname);

    expect(setMyNickname).toHaveBeenCalledTimes(1);
    expect(setMyNickname).toHaveBeenCalledWith('Ali');

    vi.advanceTimersByTime(NICKNAME_BROADCAST_DELAY_MS * 2);
    expect(setMyNickname).toHaveBeenCalledTimes(1);
    expect(timerRef.current).toBeNull();
  });

  it('does not broadcast on blur when nothing is pending', () => {
    const setMyNickname = vi.fn();

    flushNicknameBroadcast(timerRef, 'Ali', setMyNickname);
    vi.advanceTimersByTime(NICKNAME_BROADCAST_DELAY_MS);

    expect(setMyNickname).not.toHaveBeenCalled();
  });

  it('does not broadcast after cancellation (unmount cleanup)', () => {
    const setMyNickname = vi.fn();

    scheduleNicknameBroadcast(timerRef, 'Ali', setMyNickname);
    cancelNicknameBroadcast(timerRef);
    vi.advanceTimersByTime(NICKNAME_BROADCAST_DELAY_MS * 2);

    expect(setMyNickname).not.toHaveBeenCalled();
    expect(timerRef.current).toBeNull();
  });
});
