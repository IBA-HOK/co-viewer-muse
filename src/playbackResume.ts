export const RESUME_RETRY_DELAYS_MS = [0, 150, 400, 900, 1800, 3000] as const;

export interface ResumeRetryScheduler {
  cancel: () => void;
}

export interface ResumeRetryOptions {
  /** The room's latest playback state, checked again right before every retry. */
  isRoomPlaying: () => boolean;
  /** Whether the local player is already playing (the retry succeeded). */
  isPlayerPlaying: () => boolean;
  isDocumentHidden: () => boolean;
  play: () => void;
  delays?: readonly number[];
  /** Called once when the retries finish, succeed, or are cancelled. */
  onFinished?: () => void;
}

/**
 * Schedule the tab-return playback retries. Every callback re-checks the room
 * state so a pause that arrives while the tab was hidden is never overridden.
 */
export function scheduleResumeRetries(options: ResumeRetryOptions): ResumeRetryScheduler {
  const {
    isRoomPlaying,
    isPlayerPlaying,
    isDocumentHidden,
    play,
    onFinished,
  } = options;
  const delays = options.delays ?? RESUME_RETRY_DELAYS_MS;
  const timers = new Set<number>();
  let cancelled = false;

  const finish = () => {
    if (cancelled) return;
    cancelled = true;
    for (const id of timers) window.clearTimeout(id);
    timers.clear();
    onFinished?.();
  };

  for (const delay of delays) {
    const id = window.setTimeout(() => {
      timers.delete(id);
      if (cancelled) return;

      // The room may have been paused while the tab was hidden or during a
      // previous retry. Never resume playback for a paused room.
      if (!isRoomPlaying()) {
        finish();
        return;
      }
      if (isDocumentHidden()) {
        if (timers.size === 0) finish();
        return;
      }
      // A previous retry already succeeded.
      if (isPlayerPlaying()) {
        finish();
        return;
      }

      try {
        play();
      } catch {
        // Keep retrying: some players throw until their iframe is ready.
      }

      if (isRoomPlaying() && isPlayerPlaying()) {
        finish();
      } else if (timers.size === 0) {
        finish();
      }
    }, delay);
    timers.add(id);
  }

  return { cancel: finish };
}
