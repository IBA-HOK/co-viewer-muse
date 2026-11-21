import {
  isLocalMediaIntegrity,
  isLocalMediaMeta,
  type LocalMediaIntegrity,
  type LocalMediaMeta,
} from '../types';

/**
 * Label of the dedicated PeerJS DataConnection that carries file bytes.
 * Main sync connections never use this label, so `peer.on('connection')` can
 * keep registering them as the room connection without a file offer replacing
 * it (see src/hooks/usePeer.ts).
 */
export const FILE_CHANNEL_LABEL = 'co-viewer-file-v1';

/** App-level chunk size. PeerJS itself splits around 16 KiB, so keep it small. */
export const TRANSFER_CHUNK_SIZE = 16 * 1024;

/** Stop sending when the DataChannel has this much queued (flow control). */
export const TRANSFER_BUFFER_HIGH_WATER = 1024 * 1024;
/** Resume sending once the queued amount falls back below this. */
export const TRANSFER_BUFFER_LOW_WATER = 256 * 1024;

/** v1 distribution limits (the host never offers a bigger file). */
export const MAX_TRANSFER_BYTES = 1024 * 1024 * 1024;
export const MAX_MOBILE_TRANSFER_BYTES = 500 * 1024 * 1024;

/** Magic + version for the binary chunk frame. */
const CHUNK_MAGIC = 0x4346; // 'CF'
const CHUNK_VERSION = 1;
export const CHUNK_HEADER_BYTES = 12;

export type FileTransferCancelReason =
  | 'user'
  | 'queue-changed'
  | 'host-disconnected'
  | 'too-large'
  | 'verification-failed'
  | 'no-integrity'
  | 'already-have'
  | 'no-file'
  | 'channel-closed';

/** Control frames travel as JSON on the same dedicated channel as the chunks. */
export type FileControlMessage =
  | {
      type: 'FILE_OFFER';
      transferId: number;
      videoId: string;
      meta: LocalMediaMeta;
      totalBytes: number;
      integrity: LocalMediaIntegrity;
    }
  | { type: 'FILE_ACCEPT'; transferId: number; offset: number }
  | {
      type: 'FILE_CANCEL';
      transferId: number;
      reason: FileTransferCancelReason;
    }
  | { type: 'FILE_END'; transferId: number }
  | { type: 'FILE_REQUEST'; videoId: string };

export interface ChunkFrame {
  transferId: number;
  offset: number;
  payload: ArrayBuffer;
}

/** Upper bound used by the transfer UI; mobile devices get the smaller cap. */
export function getMaxTransferBytes(
  userAgent = typeof navigator !== 'undefined' ? navigator.userAgent : ''
): number {
  return /Mobi|Android|iPhone|iPad|iPod/i.test(userAgent)
    ? MAX_MOBILE_TRANSFER_BYTES
    : MAX_TRANSFER_BYTES;
}

export function createTransferId(): number {
  return Math.floor(Math.random() * 0xffffffff) + 1;
}

/** Build a chunk with a small fixed header (transfer id + byte offset). */
export function encodeChunkFrame(
  transferId: number,
  offset: number,
  payload: ArrayBuffer
): ArrayBuffer {
  const out = new ArrayBuffer(CHUNK_HEADER_BYTES + payload.byteLength);
  const view = new DataView(out);
  view.setUint16(0, CHUNK_MAGIC);
  view.setUint8(2, CHUNK_VERSION);
  view.setUint8(3, 0);
  view.setUint32(4, transferId >>> 0);
  view.setUint32(8, offset >>> 0);
  new Uint8Array(out, CHUNK_HEADER_BYTES).set(new Uint8Array(payload));
  return out;
}

/** Decode a binary chunk from the DataChannel, or null for any other payload. */
export function decodeChunkFrame(data: unknown): ChunkFrame | null {
  let buffer: ArrayBuffer | null = null;
  if (data instanceof ArrayBuffer) buffer = data;
  else if (ArrayBuffer.isView(data)) {
    buffer = data.buffer.slice(
      data.byteOffset,
      data.byteOffset + data.byteLength
    ) as ArrayBuffer;
  }
  if (!buffer || buffer.byteLength < CHUNK_HEADER_BYTES) return null;
  const view = new DataView(buffer);
  if (view.getUint16(0) !== CHUNK_MAGIC) return null;
  if (view.getUint8(2) !== CHUNK_VERSION) return null;
  return {
    transferId: view.getUint32(4),
    offset: view.getUint32(8),
    payload: buffer.slice(CHUNK_HEADER_BYTES),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCancelReason(value: unknown): value is FileTransferCancelReason {
  return (
    value === 'user' ||
    value === 'queue-changed' ||
    value === 'host-disconnected' ||
    value === 'too-large' ||
    value === 'verification-failed' ||
    value === 'no-integrity' ||
    value === 'already-have' ||
    value === 'no-file' ||
    value === 'channel-closed'
  );
}

/** Runtime validation for control frames received from a peer. */
export function isFileControlMessage(
  value: unknown
): value is FileControlMessage {
  if (!isRecord(value) || typeof value.type !== 'string') return false;
  switch (value.type) {
    case 'FILE_OFFER':
      return (
        Number.isSafeInteger(value.transferId) &&
        (value.transferId as number) > 0 &&
        typeof value.videoId === 'string' &&
        isLocalMediaMeta(value.meta) &&
        Number.isSafeInteger(value.totalBytes) &&
        (value.totalBytes as number) > 0 &&
        isLocalMediaIntegrity(value.integrity)
      );
    case 'FILE_ACCEPT':
      return (
        Number.isSafeInteger(value.transferId) &&
        (value.transferId as number) > 0 &&
        Number.isSafeInteger(value.offset) &&
        (value.offset as number) >= 0
      );
    case 'FILE_CANCEL':
      return (
        Number.isSafeInteger(value.transferId) &&
        (value.transferId as number) > 0 &&
        isCancelReason(value.reason)
      );
    case 'FILE_END':
      return (
        Number.isSafeInteger(value.transferId) &&
        (value.transferId as number) > 0
      );
    case 'FILE_REQUEST':
      return typeof value.videoId === 'string' && value.videoId.length > 0;
    default:
      return false;
  }
}

/** Transfer progress as a 0..1 ratio (0 when the total is unknown). */
export function transferRatio(receivedBytes: number, totalBytes: number): number {
  if (!Number.isFinite(totalBytes) || totalBytes <= 0) return 0;
  return Math.max(0, Math.min(1, receivedBytes / totalBytes));
}
