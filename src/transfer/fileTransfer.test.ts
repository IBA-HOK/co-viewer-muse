import { describe, expect, it } from 'vitest';
import {
  CHUNK_HEADER_BYTES,
  FILE_CHANNEL_LABEL,
  MAX_MOBILE_TRANSFER_BYTES,
  MAX_TRANSFER_BYTES,
  TRANSFER_CHUNK_SIZE,
  decodeChunkFrame,
  encodeChunkFrame,
  getMaxTransferBytes,
  isFileControlMessage,
  transferRatio,
} from './fileTransfer';
import type { LocalMediaIntegrity, LocalMediaMeta } from '../types';

const INTEGRITY: LocalMediaIntegrity = {
  algorithm: 'SHA-256',
  sampleSize: 1024,
  offsets: [0],
  hashes: ['a'.repeat(64)],
};

const META: LocalMediaMeta = {
  fileName: 'holiday.mp4',
  sizeBytes: 1234,
  durationSec: 42,
  mimeType: 'video/mp4',
  integrity: INTEGRITY,
};

describe('chunk framing', () => {
  it('round-trips transfer id, offset and payload', () => {
    const payload = new Uint8Array([1, 2, 3, 4]).buffer;
    const frame = encodeChunkFrame(77, 4096, payload);
    expect(frame.byteLength).toBe(CHUNK_HEADER_BYTES + 4);
    const decoded = decodeChunkFrame(frame);
    expect(decoded?.transferId).toBe(77);
    expect(decoded?.offset).toBe(4096);
    expect(Array.from(new Uint8Array(decoded!.payload))).toEqual([1, 2, 3, 4]);
  });

  it('returns null for control objects and foreign binary data', () => {
    expect(decodeChunkFrame({ type: 'FILE_END' })).toBeNull();
    expect(decodeChunkFrame(new ArrayBuffer(4))).toBeNull();
    expect(decodeChunkFrame('nope')).toBeNull();
  });

  it('keeps chunks well below the PeerJS internal split', () => {
    expect(TRANSFER_CHUNK_SIZE).toBeLessThanOrEqual(16 * 1024);
  });
});

describe('size limits', () => {
  it('uses 1 GB on desktop and 500 MB on mobile', () => {
    expect(getMaxTransferBytes('Mozilla/5.0 (Windows NT 10.0)')).toBe(
      MAX_TRANSFER_BYTES
    );
    expect(getMaxTransferBytes('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)')).toBe(
      MAX_MOBILE_TRANSFER_BYTES
    );
  });
});

describe('isFileControlMessage', () => {
  it('accepts the offer / accept / end / cancel / request protocol', () => {
    expect(
      isFileControlMessage({
        type: 'FILE_OFFER',
        transferId: 1,
        videoId: 'local-abcdefgh',
        meta: META,
        totalBytes: META.sizeBytes,
        integrity: INTEGRITY,
      })
    ).toBe(true);
    expect(
      isFileControlMessage({ type: 'FILE_ACCEPT', transferId: 1, offset: 0 })
    ).toBe(true);
    expect(
      isFileControlMessage({ type: 'FILE_END', transferId: 1 })
    ).toBe(true);
    expect(
      isFileControlMessage({
        type: 'FILE_CANCEL',
        transferId: 1,
        reason: 'verification-failed',
      })
    ).toBe(true);
    expect(
      isFileControlMessage({
        type: 'FILE_REQUEST',
        videoId: 'local-abcdefgh',
      })
    ).toBe(true);
  });

  it('rejects malformed offers (negative size, missing integrity)', () => {
    expect(
      isFileControlMessage({
        type: 'FILE_OFFER',
        transferId: 1,
        videoId: 'local-abcdefgh',
        meta: { ...META, sizeBytes: -1 },
        totalBytes: -1,
        integrity: INTEGRITY,
      })
    ).toBe(false);
    expect(
      isFileControlMessage({
        type: 'FILE_OFFER',
        transferId: 1,
        videoId: 'local-abcdefgh',
        meta: META,
        totalBytes: META.sizeBytes,
      })
    ).toBe(false);
    expect(isFileControlMessage({ type: 'UNKNOWN' })).toBe(false);
  });

  it('rejects binary frames; they are not sync/control messages', () => {
    expect(isFileControlMessage(new ArrayBuffer(16))).toBe(false);
  });
});

describe('transferRatio', () => {
  it('clamps progress to 0..1', () => {
    expect(transferRatio(0, 100)).toBe(0);
    expect(transferRatio(50, 100)).toBe(0.5);
    expect(transferRatio(200, 100)).toBe(1);
    expect(transferRatio(10, 0)).toBe(0);
  });
});

describe('channel label', () => {
  it('is distinct from the default PeerJS sync label', () => {
    expect(FILE_CHANNEL_LABEL).toBe('co-viewer-file-v1');
  });
});
