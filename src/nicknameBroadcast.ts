/** Trailing debounce applied before a nickname change is broadcast to the room. */
export const NICKNAME_BROADCAST_DELAY_MS = 300;

/** Timer handle shared with the component that owns the debounce lifecycle. */
export interface NicknameBroadcastTimer {
  current: number | null;
}

/** Clear a pending nickname broadcast, if any. */
export function cancelNicknameBroadcast(timerRef: NicknameBroadcastTimer): void {
  if (timerRef.current === null) return;
  window.clearTimeout(timerRef.current);
  timerRef.current = null;
}

/**
 * Schedule (or reschedule) the trailing broadcast for `name`. Only the last
 * value passed before the delay elapses is broadcast.
 */
export function scheduleNicknameBroadcast(
  timerRef: NicknameBroadcastTimer,
  name: string,
  setMyNickname: (name: string) => void,
  delayMs: number = NICKNAME_BROADCAST_DELAY_MS
): void {
  cancelNicknameBroadcast(timerRef);
  timerRef.current = window.setTimeout(() => {
    timerRef.current = null;
    setMyNickname(name);
  }, delayMs);
}

/**
 * Broadcast a pending nickname immediately (e.g. on blur) and prevent the
 * timer from firing a second time. A blur with no pending update is a no-op.
 */
export function flushNicknameBroadcast(
  timerRef: NicknameBroadcastTimer,
  name: string,
  setMyNickname: (name: string) => void
): void {
  if (timerRef.current === null) return;
  cancelNicknameBroadcast(timerRef);
  setMyNickname(name);
}
