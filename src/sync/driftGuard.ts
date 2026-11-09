import { SYNC_DRIFT_THRESHOLD } from '../types';

/**
 * Drift-correction policy for low-performance guests.
 *
 * Why this exists
 * ---------------
 * The host is the time authority: it broadcasts a `SYNC_PING` every
 * `SYNC_PING_INTERVAL` ms and every guest seeks whenever it is more than
 * `SYNC_DRIFT_THRESHOLD` behind. On a fast device that converges in one step.
 * On a low-performance device (old phone, throttled CPU, slow network) a seek
 * costs several seconds of buffering *after* the seek was issued. The host
 * keeps playing during that buffer, so when playback resumes the guest is
 * already behind again, the next ping orders another seek, and buffering
 * restarts from scratch:
 *
 *     seek → buffer… → ping sees drift → seek → buffer… → ping sees drift → …
 *
 * The video then never gets a chance to play for more than a moment.
 *
 * The guard breaks the loop with three rules:
 *
 *  1. A player that is `BUFFERING` is not "out of sync" — it is loading. Never
 *     correct while buffering.
 *  2. Ignore corrections for a settle window after *any* seek. YouTube reports
 *     the previous position for a short while after `seekTo`, so a ping in
 *     that window would look like a huge drift and trigger a redundant seek.
 *  3. Track whether a correction actually restored alignment. Two consecutive
 *     corrections that did not → enter a fallback hold for a while, during
 *     which automatic corrections are disabled so the video keeps playing
 *     (with drift) instead of stuttering forever. Repeated holds back off
 *     (20s → 40s → 60s) and the hold is cleared by an explicit user resync or
 *     by a change of media.
 *
 * The caller supplies the drift threshold, because a device that needs 5s to
 * recover from a seek can never stay within 1.5s. `effectiveDriftThreshold()`
 * expands the tolerance based on the measured seek recovery time, capped so a
 * hopeless device eventually falls back to the hold instead of drifting
 * forever.
 */

/** Ignore automatic corrections for this long after any applied seek. */
export const DRIFT_SETTLE_MS = 6000;

/** Continuous alignment needed before the backoff level is forgotten. */
export const DRIFT_STABLE_ALIGN_MS = 10000;

/** Consecutive ineffective corrections before the fallback hold engages. */
export const DRIFT_STRIKES_BEFORE_FALLBACK = 2;

/** Fallback hold durations per level (ms). Index = level - 1. */
export const DRIFT_FALLBACK_HOLD_MS: readonly number[] = [20000, 40000, 60000];

/**
 * Upper bound for the adaptive tolerance. Beyond this a guest is not "slightly
 * behind" any more: the fallback hold (continuous playback + manual resync)
 * is the better trade-off than seeking on every ping.
 */
export const DRIFT_ADAPTIVE_MAX_SEC = 12;

/**
 * Tolerated drift for a device whose last seek spent `recoveryMs` buffering.
 * While a seek is buffering the host advances by the same amount, so the
 * guest's natural post-seek lag is ≈ recovery time. Adding one base threshold
 * as a margin avoids correcting a device for the lag its own buffering caused.
 */
export function effectiveDriftThreshold(
  recoveryMs: number,
  base: number = SYNC_DRIFT_THRESHOLD
): number {
  const recoveredSec = Number.isFinite(recoveryMs) ? Math.max(0, recoveryMs) / 1000 : 0;
  return Math.min(DRIFT_ADAPTIVE_MAX_SEC, base + recoveredSec);
}

export type DriftDecisionReason =
  | 'ok'
  | 'within-threshold'
  | 'buffering'
  | 'settling'
  | 'fallback-hold';

export interface DriftEvaluationInput {
  /** Absolute difference between local and host playback position (seconds). */
  drift: number;
  /** Whether the local player is currently loading/buffering. */
  isBuffering: boolean;
  /** Drift tolerance for this evaluation (see effectiveDriftThreshold). */
  threshold?: number;
  /** Timestamp override (tests use fake timers / injected clock). */
  at?: number;
}

export interface DriftEvaluation {
  action: 'correct' | 'ignore';
  reason: DriftDecisionReason;
  drift: number;
  threshold: number;
}

export interface DriftGuardOptions {
  now?: () => number;
  settleMs?: number;
  stableAlignMs?: number;
  strikesBeforeFallback?: number;
  holdDurationsMs?: readonly number[];
}

export class DriftGuard {
  private readonly now: () => number;
  private readonly settleMs: number;
  private readonly stableAlignMs: number;
  private readonly strikesBeforeFallback: number;
  private readonly holdDurationsMs: readonly number[];

  private lastSeekAt = 0;
  private alignedSince: number | null = null;
  /** True while the previous correction has not yet produced an aligned ping. */
  private correctionPending = false;
  private strikes = 0;
  private holdUntil = 0;
  private holdLevel = 0;

  constructor(opts: DriftGuardOptions = {}) {
    this.now = opts.now ?? (() => Date.now());
    this.settleMs = opts.settleMs ?? DRIFT_SETTLE_MS;
    this.stableAlignMs = opts.stableAlignMs ?? DRIFT_STABLE_ALIGN_MS;
    this.strikesBeforeFallback =
      opts.strikesBeforeFallback ?? DRIFT_STRIKES_BEFORE_FALLBACK;
    this.holdDurationsMs = opts.holdDurationsMs ?? DRIFT_FALLBACK_HOLD_MS;
  }

  /** Record that a seek (local, remote or corrective) was applied. */
  noteSeek(at: number = this.now()): void {
    this.lastSeekAt = at;
    this.alignedSince = null;
  }

  /** Whether an automatic correction is allowed right now, and why not. */
  evaluate(input: DriftEvaluationInput): DriftEvaluation {
    const at = input.at ?? this.now();
    const threshold = input.threshold ?? SYNC_DRIFT_THRESHOLD;
    const drift = Math.abs(input.drift);

    if (drift <= threshold) {
      // Only a *playing* aligned sample proves the last correction worked.
      // While buffering, `getCurrentTime()` may coincidentally report the seek
      // target; counting that as success would erase a genuine failure.
      if (!input.isBuffering) {
        this.correctionPending = false;
        this.strikes = 0;
        if (this.alignedSince === null) this.alignedSince = at;
        // Forget the backoff escalation only after a stable aligned period, so
        // a device that flaps between "aligned" and "far behind" keeps backing
        // off.
        if (at - this.alignedSince >= this.stableAlignMs) {
          this.holdLevel = 0;
          // The device caught up and stayed aligned: the fallback has done its
          // job and can be released early (the UI badge follows on the next
          // publish), before the nominal hold duration expires.
          this.holdUntil = 0;
        }
      }
      return { action: 'ignore', reason: 'within-threshold', drift, threshold };
    }

    this.alignedSince = null;

    if (input.isBuffering) {
      return { action: 'ignore', reason: 'buffering', drift, threshold };
    }
    if (at - this.lastSeekAt < this.settleMs) {
      return { action: 'ignore', reason: 'settling', drift, threshold };
    }
    if (this.isHoldActive(at)) {
      return { action: 'ignore', reason: 'fallback-hold', drift, threshold };
    }
    return { action: 'correct', reason: 'ok', drift, threshold };
  }

  /**
   * Record that a correction was applied. Call *after* the seek, so the
   * settle window starts at the correction time. Returns true when this
   * correction triggered a fallback hold.
   */
  noteCorrection(at: number = this.now()): boolean {
    this.lastSeekAt = at;
    this.alignedSince = null;

    // If the previous correction never produced an aligned ping, it failed.
    this.strikes = this.correctionPending ? this.strikes + 1 : 1;
    this.correctionPending = true;

    if (this.strikes >= this.strikesBeforeFallback) {
      this.holdLevel = Math.min(this.holdLevel + 1, this.holdDurationsMs.length);
      const hold = this.holdDurationsMs[this.holdLevel - 1] ?? 0;
      this.holdUntil = at + hold;
      this.strikes = 0;
      this.correctionPending = false;
      return true;
    }
    return false;
  }

  isHoldActive(at: number = this.now()): boolean {
    return this.holdUntil > 0 && at < this.holdUntil;
  }

  activeHoldLevelAt(at: number = this.now()): number {
    return this.isHoldActive(at) ? this.holdLevel : 0;
  }

  get activeHoldLevel(): number {
    return this.activeHoldLevelAt();
  }

  get holdEndsAt(): number {
    return this.holdUntil;
  }

  get holdRemainingMs(): number {
    return Math.max(0, this.holdUntil - this.now());
  }

  /**
   * Release the current hold (e.g. the room paused) without forgetting the
   * escalation history: a device that keeps failing gets a longer hold next.
   */
  releaseHold(): void {
    this.holdUntil = 0;
  }

  /** Manual resync: stop the fallback and let corrections start over. */
  clearHold(): void {
    this.holdUntil = 0;
    this.holdLevel = 0;
    this.strikes = 0;
    this.correctionPending = false;
    this.alignedSince = null;
    // The caller issues a fresh seek right after this; resetting the settle
    // window keeps stale state from suppressing that seek.
    this.lastSeekAt = 0;
  }

  /** New media / new role: forget everything. */
  reset(): void {
    this.lastSeekAt = 0;
    this.alignedSince = null;
    this.correctionPending = false;
    this.strikes = 0;
    this.holdUntil = 0;
    this.holdLevel = 0;
  }
}

/**
 * A tiny helper for the room-sync layer: predicts the host's playback position
 * from the last authoritative timestamp we received.
 */
export interface RemoteClock {
  /** Host position (seconds) when the timestamp was taken. */
  time: number;
  isPlaying: boolean;
  /** Local `Date.now()` when the timestamp was received. */
  at: number;
}

export function predictRemoteTime(
  clock: RemoteClock | null,
  now: number = Date.now()
): number | null {
  if (!clock) return null;
  const elapsed = clock.isPlaying ? Math.max(0, now - clock.at) / 1000 : 0;
  return Math.max(0, clock.time + elapsed);
}
