import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  computeLocalMediaIntegrity,
  createLocalMediaId,
  formatBytes,
  formatDuration,
  localIntegritySampleOffsets,
  matchLocalFile,
  probeLocalMedia,
  verifyLocalMediaIntegrity,
} from './localFile';
import type { LocalMediaMeta } from './types';

function meta(overrides: Partial<LocalMediaMeta> = {}): LocalMediaMeta {
  return {
    fileName: 'sample.mp4',
    sizeBytes: 1024,
    durationSec: 120,
    mimeType: 'video/mp4',
    ...overrides,
  };
}

describe('matchLocalFile', () => {
  it('accepts an exact size / duration / name match', () => {
    expect(matchLocalFile(meta(), meta())).toMatchObject({
      status: 'exact',
      canBind: true,
      requiresConfirmation: false,
      suppressEnd: false,
      message: null,
    });
  });

  it('accepts a renamed file when size and duration match', () => {
    expect(
      matchLocalFile(meta(), meta({ fileName: 'renamed.mp4' }))
    ).toMatchObject({
      status: 'name-only',
      canBind: true,
      requiresConfirmation: false,
      suppressEnd: false,
    });
  });

  it('requires confirmation for a duration difference above 0.5s', () => {
    const result = matchLocalFile(meta(), meta({ durationSec: 120.6 }));
    expect(result.status).toBe('duration-mismatch');
    expect(result.requiresConfirmation).toBe(true);
    expect(result.suppressEnd).toBe(true);
    expect(result.canBind).toBe(true);
    expect(result.message).toContain('120.0s');
    expect(result.message).toContain('120.6s');
  });

  it('accepts a duration difference exactly at the tolerance', () => {
    expect(
      matchLocalFile(meta(), meta({ durationSec: 120.5 })).status
    ).toBe('exact');
  });

  it('rejects a file whose size differs, regardless of duration', () => {
    const result = matchLocalFile(
      meta(),
      meta({ sizeBytes: 2048, durationSec: 120 })
    );
    expect(result.status).toBe('size-mismatch');
    expect(result.canBind).toBe(false);
    expect(result.message).toContain('サイズが一致しません');
  });

  it('treats an unreadable duration as unknown and binds with a warning', () => {
    const result = matchLocalFile(meta({ durationSec: 0 }), meta({ durationSec: 0 }));
    expect(result.status).toBe('duration-unknown');
    expect(result.canBind).toBe(true);
    expect(result.requiresConfirmation).toBe(false);
    expect(result.suppressEnd).toBe(true);
    expect(result.message).toContain('再生時間を確認できない');
  });
});

describe('sampled file integrity', () => {
  it('hashes small files as a single sample', () => {
    expect(localIntegritySampleOffsets(1000, 1000)).toEqual([0]);
  });

  it('samples the start, middle and end of large files', () => {
    const size = 1024 * 1024;
    const offsets = localIntegritySampleOffsets(size, 64 * 1024);
    expect(offsets).toHaveLength(3);
    expect(offsets[0]).toBe(0);
    expect(offsets[1]).toBeGreaterThan(0);
    expect(offsets[2]).toBe(size - 64 * 1024);
  });

  it('matches the same bytes and rejects different bytes', async () => {
    const file = new File([new Uint8Array([1, 2, 3, 4, 5])], 'a.bin');
    const integrity = await computeLocalMediaIntegrity(file);
    await expect(verifyLocalMediaIntegrity(file, integrity)).resolves.toBe(
      true
    );
    const changed = new File([new Uint8Array([1, 2, 3, 4, 6])], 'a.bin');
    await expect(
      verifyLocalMediaIntegrity(changed, integrity)
    ).resolves.toBe(false);
  });

  it('detects a change in the middle of a file larger than one sample', async () => {
    const bytes = new Uint8Array(200000).fill(7);
    const file = new File([bytes], 'a.bin');
    const integrity = await computeLocalMediaIntegrity(file, 1024);
    const edited = new Uint8Array(bytes);
    edited[100000] = 8;
    const changed = new File([edited], 'a.bin');
    await expect(
      verifyLocalMediaIntegrity(changed, integrity)
    ).resolves.toBe(false);
  });
});

describe('formatBytes', () => {
  it.each([
    [0, '0 B'],
    [512, '512 B'],
    [1024, '1.0 KB'],
    [1536, '1.5 KB'],
    [10 * 1024, '10 KB'],
    [1024 * 1024, '1.0 MB'],
    [2.5 * 1024 * 1024 * 1024, '2.5 GB'],
  ])('formats %s bytes as %s', (bytes, expected) => {
    expect(formatBytes(bytes)).toBe(expected);
  });

  it('handles invalid input', () => {
    expect(formatBytes(Number.NaN)).toBe('0 B');
    expect(formatBytes(-1)).toBe('0 B');
  });
});

describe('formatDuration', () => {
  it.each([
    [0, '0:00'],
    [5, '0:05'],
    [65, '1:05'],
    [3600, '1:00:00'],
    [3661, '1:01:01'],
  ])('formats %s seconds as %s', (seconds, expected) => {
    expect(formatDuration(seconds)).toBe(expected);
  });

  it('handles invalid input', () => {
    expect(formatDuration(Number.NaN)).toBe('0:00');
    expect(formatDuration(-5)).toBe('0:00');
  });
});

describe('createLocalMediaId', () => {
  it('produces an id accepted by the local videoId validation', () => {
    for (let i = 0; i < 10; i += 1) {
      expect(createLocalMediaId()).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    }
  });
});

describe('probeLocalMedia', () => {
  type FakeVideo = {
    preload: string;
    src: string;
    duration: number;
    onloadedmetadata: (() => void) | null;
    onerror: (() => void) | null;
    removeAttribute: ReturnType<typeof vi.fn>;
    load: ReturnType<typeof vi.fn>;
  };

  let fake: FakeVideo;
  let createObjectURL: ReturnType<typeof vi.fn>;
  let revokeObjectURL: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fake = {
      preload: '',
      src: '',
      duration: 42.5,
      onloadedmetadata: null,
      onerror: null,
      removeAttribute: vi.fn(),
      load: vi.fn(),
    };
    vi.spyOn(document, 'createElement').mockReturnValue(
      fake as unknown as HTMLVideoElement
    );
    createObjectURL = vi.fn(() => 'blob:test');
    revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('reads duration / mime metadata and revokes the object URL', async () => {
    const file = new File(['abc'], 'clip.mp4', { type: 'video/mp4' });
    const promise = probeLocalMedia(file);
    fake.onloadedmetadata?.();
    await expect(promise).resolves.toEqual({
      fileName: 'clip.mp4',
      sizeBytes: file.size,
      durationSec: 42.5,
      mimeType: 'video/mp4',
    });
    expect(createObjectURL).toHaveBeenCalledWith(file);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:test');
  });

  it('stores 0 for an infinite duration', async () => {
    fake.duration = Infinity;
    const promise = probeLocalMedia(
      new File(['abc'], 'clip.mp4', { type: 'video/mp4' })
    );
    fake.onloadedmetadata?.();
    const result = await promise;
    expect(result.durationSec).toBe(0);
  });

  it('rejects an unsupported file and still revokes the URL', async () => {
    const promise = probeLocalMedia(
      new File(['abc'], 'broken.mkv', { type: '' })
    );
    fake.onerror?.();
    await expect(promise).rejects.toThrow('再生できない');
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:test');
  });

  it('rejects when metadata never arrives', async () => {
    vi.useFakeTimers();
    const promise = probeLocalMedia(
      new File(['abc'], 'slow.mp4', { type: 'video/mp4' }),
      { timeoutMs: 1000 }
    );
    const assertion = expect(promise).rejects.toThrow('メタ情報');
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
    vi.useRealTimers();
  });
});
