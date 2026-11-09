import { describe, expect, it } from 'vitest';
import {
  DRIFT_ADAPTIVE_MAX_SEC,
  DRIFT_FALLBACK_HOLD_MS,
  DRIFT_SETTLE_MS,
  DRIFT_STABLE_ALIGN_MS,
  DRIFT_STRIKES_BEFORE_FALLBACK,
  DriftGuard,
  effectiveDriftThreshold,
  predictRemoteTime,
  type DriftEvaluationInput,
} from './driftGuard';
import { SYNC_DRIFT_THRESHOLD } from '../types';

function setup() {
  let now = 1_000_000;
  const guard = new DriftGuard({ now: () => now });
  const advance = (ms: number) => {
    now += ms;
    return now;
  };
  const evaluate = (drift: number, overrides: Partial<DriftEvaluationInput> = {}) =>
    guard.evaluate({
      drift,
      isBuffering: false,
      at: now,
      threshold: SYNC_DRIFT_THRESHOLD,
      ...overrides,
    });
  return { guard, advance, evaluate, now: () => now };
}

describe('effectiveDriftThreshold', () => {
  it('keeps the base threshold for a fast device', () => {
    expect(effectiveDriftThreshold(0)).toBe(SYNC_DRIFT_THRESHOLD);
    expect(effectiveDriftThreshold(400)).toBeCloseTo(SYNC_DRIFT_THRESHOLD + 0.4);
  });

  it('grows with the measured seek recovery time', () => {
    expect(effectiveDriftThreshold(5_000)).toBeCloseTo(6.5);
    expect(effectiveDriftThreshold(8_000)).toBeCloseTo(9.5);
  });

  it('caps the tolerance so a hopeless device reaches the fallback hold', () => {
    expect(effectiveDriftThreshold(60_000)).toBe(DRIFT_ADAPTIVE_MAX_SEC);
    expect(effectiveDriftThreshold(-5)).toBe(SYNC_DRIFT_THRESHOLD);
    expect(effectiveDriftThreshold(Number.NaN)).toBe(SYNC_DRIFT_THRESHOLD);
  });
});

describe('DriftGuard · suppression rules', () => {
  it('ignores drift inside the threshold', () => {
    const { evaluate } = setup();
    const decision = evaluate(SYNC_DRIFT_THRESHOLD);
    expect(decision).toMatchObject({ action: 'ignore', reason: 'within-threshold' });
  });

  it('never corrects a buffering player, however large the drift', () => {
    const { evaluate } = setup();
    const decision = evaluate(45, { isBuffering: true });
    expect(decision).toMatchObject({ action: 'ignore', reason: 'buffering' });
  });

  it('suppresses corrections during the settle window after a seek', () => {
    const { guard, advance, evaluate } = setup();
    guard.noteSeek();
    advance(DRIFT_SETTLE_MS - 1);
    expect(evaluate(5)).toMatchObject({ action: 'ignore', reason: 'settling' });
    advance(2);
    expect(evaluate(5)).toMatchObject({ action: 'correct', reason: 'ok' });
  });
});

describe('DriftGuard · failed-correction fallback', () => {
  it(`holds after ${DRIFT_STRIKES_BEFORE_FALLBACK} consecutive ineffective corrections`, () => {
    const { guard, advance, evaluate } = setup();

    // First correction: allowed and recorded.
    expect(evaluate(5)).toMatchObject({ action: 'correct' });
    expect(guard.noteCorrection()).toBe(false);

    // The correction did not restore alignment; a second one is still allowed.
    advance(DRIFT_SETTLE_MS + 1000);
    expect(evaluate(7)).toMatchObject({ action: 'correct' });
    expect(guard.noteCorrection()).toBe(true);

    // Fallback hold is now active (level 1 → 20s) and suppresses corrections.
    expect(guard.activeHoldLevel).toBe(1);
    advance(DRIFT_SETTLE_MS + 1000);
    expect(evaluate(9)).toMatchObject({ action: 'ignore', reason: 'fallback-hold' });

    // Once the hold expires a single new attempt is allowed.
    advance(DRIFT_FALLBACK_HOLD_MS[0]);
    expect(evaluate(9)).toMatchObject({ action: 'correct' });
  });

  it('treats an aligned ping as proof the correction worked', () => {
    const { guard, advance, evaluate } = setup();

    expect(evaluate(5)).toMatchObject({ action: 'correct' });
    guard.noteCorrection();

    // Guest caught up before another correction was needed.
    advance(DRIFT_SETTLE_MS + 500);
    expect(evaluate(0.5)).toMatchObject({ reason: 'within-threshold' });

    // A later drift is a fresh failure, not an escalation.
    advance(5_000);
    expect(evaluate(5)).toMatchObject({ action: 'correct' });
    expect(guard.noteCorrection()).toBe(false);
  });

  it('escalates hold durations when the storm resumes without alignment', () => {
    const { guard, advance, evaluate } = setup();

    const failTwice = () => {
      advance(DRIFT_SETTLE_MS + 200);
      expect(evaluate(8)).toMatchObject({ action: 'correct' });
      const held = guard.noteCorrection();
      advance(DRIFT_SETTLE_MS + 200);
      expect(evaluate(8)).toMatchObject({ action: 'correct' });
      return guard.noteCorrection() || held;
    };

    // Level 1 (20s)
    expect(failTwice()).toBe(true);
    expect(guard.activeHoldLevel).toBe(1);

    // Let the hold expire, then fail twice again → level 2 (40s).
    advance(DRIFT_FALLBACK_HOLD_MS[0] + 10);
    expect(failTwice()).toBe(true);
    expect(guard.activeHoldLevel).toBe(2);

    advance(DRIFT_FALLBACK_HOLD_MS[1] + 10);
    expect(failTwice()).toBe(true);
    expect(guard.activeHoldLevel).toBe(3);

    // Capped at the last configured level.
    advance(DRIFT_FALLBACK_HOLD_MS[2] + 10);
    expect(failTwice()).toBe(true);
    expect(guard.activeHoldLevel).toBe(3);
    expect(DRIFT_FALLBACK_HOLD_MS.length).toBe(3);
  });

  it('forgets the backoff level after a stable aligned period', () => {
    const { guard, advance, evaluate } = setup();

    // Reach level 2.
    const failTwice = () => {
      advance(DRIFT_SETTLE_MS + 200);
      evaluate(8);
      guard.noteCorrection();
      advance(DRIFT_SETTLE_MS + 200);
      evaluate(8);
      guard.noteCorrection();
    };
    failTwice();
    advance(DRIFT_FALLBACK_HOLD_MS[0] + 10);
    failTwice();
    expect(guard.activeHoldLevel).toBe(2);

    // Let the hold lapse, then stay aligned long enough to forget the level.
    advance(DRIFT_FALLBACK_HOLD_MS[1] + 10);
    for (let t = 0; t <= DRIFT_STABLE_ALIGN_MS; t += 1_000) {
      advance(1_000);
      evaluate(0.4);
    }

    // The next storm starts again at level 1.
    advance(DRIFT_SETTLE_MS + 200);
    evaluate(8);
    guard.noteCorrection();
    advance(DRIFT_SETTLE_MS + 200);
    evaluate(8);
    guard.noteCorrection();
    expect(guard.activeHoldLevel).toBe(1);
  });

  it('releases an active hold early once the guest is stably aligned', () => {
    const { guard, advance, evaluate } = setup();
    advance(DRIFT_SETTLE_MS + 200);
    evaluate(8);
    guard.noteCorrection();
    advance(DRIFT_SETTLE_MS + 200);
    evaluate(8);
    guard.noteCorrection();
    expect(guard.activeHoldLevel).toBe(1);

    // Aligned pings, but not yet for the stable period: hold stays.
    advance(1_000);
    evaluate(0.4);
    expect(guard.isHoldActive()).toBe(true);

    advance(DRIFT_STABLE_ALIGN_MS);
    evaluate(0.4);
    expect(guard.isHoldActive()).toBe(false);
    expect(guard.activeHoldLevel).toBe(0);
  });

  it('manual clearHold() releases the fallback immediately', () => {
    const { guard, advance, evaluate } = setup();
    advance(DRIFT_SETTLE_MS + 200);
    evaluate(8);
    guard.noteCorrection();
    advance(DRIFT_SETTLE_MS + 200);
    evaluate(8);
    expect(guard.noteCorrection()).toBe(true);
    expect(guard.isHoldActive()).toBe(true);

    guard.clearHold();
    expect(guard.isHoldActive()).toBe(false);
    expect(guard.activeHoldLevel).toBe(0);
    // A manual seek is recorded by the caller; correction becomes possible
    // again once the settle window has passed.
    advance(DRIFT_SETTLE_MS + 1);
    expect(evaluate(8)).toMatchObject({ action: 'correct' });
  });

  it('reset() clears the hold and the escalation state', () => {
    const { guard, advance, evaluate } = setup();
    advance(DRIFT_SETTLE_MS + 200);
    evaluate(8);
    guard.noteCorrection();
    advance(DRIFT_SETTLE_MS + 200);
    evaluate(8);
    guard.noteCorrection();
    expect(guard.isHoldActive()).toBe(true);

    guard.reset();
    expect(guard.isHoldActive()).toBe(false);
    expect(guard.activeHoldLevel).toBe(0);
    expect(evaluate(8)).toMatchObject({ action: 'correct' });
  });
});

describe('predictRemoteTime', () => {
  it('advances while the host is playing', () => {
    expect(predictRemoteTime({ time: 10, isPlaying: true, at: 5000 }, 8000)).toBe(13);
  });

  it('stays frozen while the host is paused', () => {
    expect(predictRemoteTime({ time: 10, isPlaying: false, at: 5000 }, 8000)).toBe(10);
  });

  it('handles a missing clock and clamps to zero', () => {
    expect(predictRemoteTime(null)).toBeNull();
    expect(predictRemoteTime({ time: 1, isPlaying: true, at: 5000 }, 1000)).toBe(1);
  });
});
