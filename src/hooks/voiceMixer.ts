/** Saved VC mixer values (`co-viewer:mixer` in localStorage). */
export interface SavedMixerValues {
  vcPeers?: Record<string, number>;
  vcMaster?: number;
}

/** Convert a 0..100 mixer value to a 0..1 GainNode value. */
export function toGainValue(volume: number): number {
  return Math.max(0, Math.min(1, volume / 100));
}

/**
 * Resolve the per-peer gain for a remote stream.
 *
 * Only the peer's own saved volume applies here. The master volume is applied
 * exclusively by the master GainNode; using it as a per-peer fallback would
 * apply it twice.
 */
export function resolvePeerGain(
  saved: SavedMixerValues | null | undefined,
  peerId: string
): number {
  const volume = saved?.vcPeers?.[peerId];
  return typeof volume === 'number' ? toGainValue(volume) : 1;
}
