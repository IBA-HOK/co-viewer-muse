import {
  MAX_LOCAL_DURATION_SEC,
  MAX_LOCAL_FILE_NAME_LENGTH,
  MAX_LOCAL_MIME_LENGTH,
  type LocalMediaIntegrity,
  type LocalMediaMeta,
} from './types';

/** Default time to wait for `loadedmetadata` before treating a file as unusable. */
const PROBE_TIMEOUT_MS = 15000;

/** Accepted duration difference (seconds) between the host's copy and ours. */
export const LOCAL_DURATION_TOLERANCE_SEC = 0.5;

export type LocalMatchStatus =
  | 'exact'
  | 'name-only'
  | 'duration-mismatch'
  | 'duration-unknown'
  | 'size-mismatch';

export interface LocalMatchResult {
  status: LocalMatchStatus;
  /** False only when the file cannot be the same media (size differs). */
  canBind: boolean;
  /** The user must explicitly opt in before the file is bound. */
  requiresConfirmation: boolean;
  /** Do not propagate END for this file (it may be shorter than the host's). */
  suppressEnd: boolean;
  message: string | null;
}

/**
 * Generate the host-side id used in `local:${id}`. File names/paths are never
 * used: they differ between devices and would leak local information.
 */
export function createLocalMediaId(): string {
  const cryptoObj =
    typeof globalThis !== 'undefined'
      ? (globalThis.crypto as Crypto | undefined)
      : undefined;
  if (cryptoObj && typeof cryptoObj.randomUUID === 'function') {
    return cryptoObj.randomUUID();
  }
  const random = Math.random().toString(36).slice(2, 12);
  return `${Date.now().toString(36)}${random}`;
}

/** Bytes hashed for each start / middle / end sample. */
export const LOCAL_INTEGRITY_SAMPLE_SIZE = 64 * 1024;

/**
 * Pick the byte offsets to sample for a content fingerprint. Small files are
 * hashed whole (a single sample); larger files use start / middle / end.
 */
export function localIntegritySampleOffsets(
  sizeBytes: number,
  sampleSize = LOCAL_INTEGRITY_SAMPLE_SIZE
): number[] {
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) return [0];
  if (sizeBytes <= sampleSize * 3) return [0];
  const middle = Math.floor((sizeBytes - sampleSize) / 2);
  return [0, middle, sizeBytes - sampleSize];
}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error('この環境ではファイルの照合を行えません');
  }
  return toHex(await subtle.digest('SHA-256', data));
}

/**
 * Compute the sampled fingerprint of a file/Blob. Only a few 64 KiB slices are
 * read, so even a 1 GB file does not block for long.
 */
export async function computeLocalMediaIntegrity(
  file: Blob,
  sampleSize = LOCAL_INTEGRITY_SAMPLE_SIZE
): Promise<LocalMediaIntegrity> {
  const offsets = localIntegritySampleOffsets(file.size, sampleSize);
  const hashes: string[] = [];
  for (const offset of offsets) {
    const length = Math.min(sampleSize, Math.max(0, file.size - offset));
    const slice = file.slice(offset, offset + length);
    hashes.push(await sha256Hex(await slice.arrayBuffer()));
  }
  return { algorithm: 'SHA-256', sampleSize, offsets, hashes };
}

/** True when the file's sampled fingerprint matches the declared one. */
export async function verifyLocalMediaIntegrity(
  file: Blob,
  integrity: LocalMediaIntegrity
): Promise<boolean> {
  if (file.size <= 0) return false;
  const actual = await computeLocalMediaIntegrity(file, integrity.sampleSize);
  if (
    actual.offsets.length !== integrity.offsets.length ||
    actual.hashes.length !== integrity.hashes.length
  ) {
    return false;
  }
  for (let i = 0; i < actual.offsets.length; i += 1) {
    if (actual.offsets[i] !== integrity.offsets[i]) return false;
    if (actual.hashes[i] !== integrity.hashes[i]) return false;
  }
  return true;
}

/**
 * Read duration / MIME metadata from a local file without uploading it.
 * `durationSec` is 0 when the browser cannot report a finite duration.
 */
export async function probeLocalMedia(
  file: File,
  options: { timeoutMs?: number } = {}
): Promise<LocalMediaMeta> {
  const url = URL.createObjectURL(file);
  const el = document.createElement('video');
  el.preload = 'metadata';
  el.src = url;
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('このファイルのメタ情報を取得できませんでした'));
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        el.onloadedmetadata = null;
        el.onerror = null;
      };
      el.onloadedmetadata = () => {
        cleanup();
        resolve();
      };
      el.onerror = () => {
        cleanup();
        reject(new Error('この形式はブラウザで再生できない可能性があります'));
      };
    });
    const duration = el.duration;
    return {
      fileName: file.name.slice(0, MAX_LOCAL_FILE_NAME_LENGTH),
      sizeBytes: Number.isSafeInteger(file.size) ? file.size : 0,
      durationSec:
        Number.isFinite(duration) && duration > 0
          ? Math.min(duration, MAX_LOCAL_DURATION_SEC)
          : 0,
      mimeType: (file.type || '').slice(0, MAX_LOCAL_MIME_LENGTH),
    };
  } finally {
    el.onloadedmetadata = null;
    el.onerror = null;
    el.removeAttribute('src');
    try {
      el.load();
    } catch {
      // jsdom / older browsers may not implement load(); nothing to clean up.
    }
    URL.revokeObjectURL(url);
  }
}

function durationsComparable(
  a: LocalMediaMeta,
  b: LocalMediaMeta
): boolean {
  return (
    Number.isFinite(a.durationSec) &&
    Number.isFinite(b.durationSec) &&
    a.durationSec > 0 &&
    b.durationSec > 0
  );
}

/**
 * Compare the host's metadata with a locally selected file.
 *
 * Size is authoritative (a different size cannot be the same file). Duration
 * is a recommendation with a 0.5s tolerance; the file name is informational
 * only, because renames and OS differences are common.
 */
export function matchLocalFile(
  host: LocalMediaMeta,
  candidate: LocalMediaMeta
): LocalMatchResult {
  if (host.sizeBytes !== candidate.sizeBytes) {
    return {
      status: 'size-mismatch',
      canBind: false,
      requiresConfirmation: false,
      suppressEnd: false,
      message: 'サイズが一致しません。別のファイルを選択してください。',
    };
  }

  if (!durationsComparable(host, candidate)) {
    return {
      status: 'duration-unknown',
      canBind: true,
      requiresConfirmation: false,
      suppressEnd: true,
      message:
        '再生時間を確認できないため、完全な一致確認はできません。ファイルサイズとファイル名で照合しました。',
    };
  }

  const diff = Math.abs(host.durationSec - candidate.durationSec);
  if (diff > LOCAL_DURATION_TOLERANCE_SEC) {
    return {
      status: 'duration-mismatch',
      canBind: true,
      requiresConfirmation: true,
      suppressEnd: true,
      message: `再生時間がホストと一致しません（ホスト ${host.durationSec.toFixed(
        1
      )}s / 手元 ${candidate.durationSec.toFixed(
        1
      )}s）。編集版・別エンコードの可能性があります。`,
    };
  }

  if (host.fileName === candidate.fileName) {
    return {
      status: 'exact',
      canBind: true,
      requiresConfirmation: false,
      suppressEnd: false,
      message: null,
    };
  }

  return {
    status: 'name-only',
    canBind: true,
    requiresConfirmation: false,
    suppressEnd: false,
    message: 'ファイル名がホストと異なりますが、サイズと再生時間が一致しています。',
  };
}

/** Human-readable byte size (1 KB = 1024 B). */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  if (unit === 0) return `${Math.round(value)} B`;
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

/** Human-readable duration (`m:ss` or `h:mm:ss`). */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0:00';
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/**
 * Best-effort format hint. `accept` is only a dialog hint and browsers differ,
 * so this never blocks a selection; the real decision is made by the decoder.
 */
export function mediaTypeWarning(mimeType: string): string | null {
  if (!mimeType) return null;
  try {
    const el = document.createElement('video');
    if (el.canPlayType(mimeType) === '') {
      return 'この形式はブラウザで再生できない可能性があります。';
    }
  } catch {
    // canPlayType is unavailable in some test/embedded environments.
  }
  return null;
}
