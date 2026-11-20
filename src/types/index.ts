// Core domain types for the P2P co-viewer.
// These contracts are the single source of truth shared by hooks and components.

export type Platform = 'youtube' | 'niconico' | 'local';

export type Role = 'Host' | 'Controller' | 'Viewer';

export interface Participant {
  peerId: string;
  name: string;
  isHost: boolean;
  role: Role;
}

/**
 * Identity metadata for a local file, shared over the existing sync messages.
 * A file path is deliberately never included: each participant picks their own
 * copy of the file from their own device.
 */
export interface LocalMediaMeta {
  /** Display / auxiliary match value (1..255 characters). */
  fileName: string;
  /** `File.size` (non-negative integer). */
  sizeBytes: number;
  /** Duration in seconds; 0 when it could not be read. */
  durationSec: number;
  /** `File.type`; may be an empty string. */
  mimeType: string;
}

/** A single queued video. `id` is `${platform}:${videoId}` for dedupe. */
export interface QueueItem {
  id: string;
  platform: Platform;
  videoId: string;
  addedBy: string;
  /** Present only when `platform === 'local'`. */
  local?: LocalMediaMeta;
}

/** The currently-playing media, derived from the queue + current pointer. */
export interface CurrentMedia {
  platform: Platform;
  videoId: string;
  local?: LocalMediaMeta;
}

/** A single P2P chat message. `id` is `${peerId}-${timestamp}-${rand}` for dedupe. */
export interface ChatMessage {
  id: string;
  peerId: string;
  name: string;
  text: string;
  timestamp: number;
}

/**
 * All P2P sync messages exchanged over the PeerJS DataChannel.
 * `senderId` lets receivers ignore their own echoes and attribute events.
 */
export type SyncMessage =
  | { type: 'PLAY'; currentTime: number; senderId: string }
  | { type: 'PAUSE'; currentTime: number; senderId: string }
  | { type: 'SEEK'; currentTime: number; senderId: string }
  | {
      type: 'SYNC_PING';
      currentTime: number;
      isPlaying: boolean;
      /**
       * Host wall-clock (`Date.now()`) when the ping was produced. Optional for
       * backward compatibility; lets guests tell a deliberate host seek apart
       * from the lag a slow device accumulates while buffering (see
       * useRoomSync's host-seek detection).
       */
      sentAt?: number;
      senderId: string;
    }
  | { type: 'ROLE_UPDATE'; targetPeerId: string; role: Role; senderId: string }
  | { type: 'PARTICIPANTS'; participants: Participant[]; senderId: string }
  | { type: 'REQUEST_STATE'; senderId: string }
  | {
      type: 'QUEUE_UPDATE';
      queue: QueueItem[];
      currentId: string | null;
      currentTime: number;
      /**
       * A reselect of the already-current item must still reload it on peers.
       * Optional for backward compatibility: older senders/clients omit it.
       */
      restart?: boolean;
      senderId: string;
    }
  | {
      type: 'STATE_SNAPSHOT';
      platform: Platform;
      videoId: string;
      currentTime: number;
      isPlaying: boolean;
      queue: QueueItem[];
      currentId: string | null;
      senderId: string;
    }
  | {
      type: 'NAME_UPDATE';
      peerId: string;
      name: string;
      senderId: string;
    }
  | { type: 'VC_STATE'; active: boolean; senderId: string }
  | {
      type: 'VC_PEER';
      peerId: string;
      inVc: boolean;
      senderId: string;
    }
  | {
      type: 'DRIVE_MODE';
      enabled: boolean;
      audioOnly: boolean;
      senderId: string;
    }
  | {
      type: 'CHAT_MESSAGE';
      peerId: string;
      name: string;
      text: string;
      timestamp: number;
      senderId: string;
    };

const PLATFORMS: readonly Platform[] = ['youtube', 'niconico', 'local'];
const ROLES: readonly Role[] = ['Host', 'Controller', 'Viewer'];

/** Maximum chat text/name lengths accepted from remote peers. */
export const MAX_CHAT_TEXT_LENGTH = 500;
export const MAX_CHAT_NAME_LENGTH = 24;

/** Bounds for local-media metadata accepted from remote peers. */
export const MAX_LOCAL_FILE_NAME_LENGTH = 255;
export const MAX_LOCAL_MIME_LENGTH = 100;
export const MAX_LOCAL_DURATION_SEC = 86400;
const LOCAL_VIDEO_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isPlatform(value: unknown): value is Platform {
  return PLATFORMS.includes(value as Platform);
}

function isRole(value: unknown): value is Role {
  return ROLES.includes(value as Role);
}

function isParticipant(value: unknown): value is Participant {
  if (!isRecord(value)) return false;
  return (
    typeof value.peerId === 'string' &&
    typeof value.name === 'string' &&
    typeof value.isHost === 'boolean' &&
    isRole(value.role)
  );
}

function isQueueItem(value: unknown): value is QueueItem {
  if (!isRecord(value)) return false;
  if (
    typeof value.id !== 'string' ||
    !isPlatform(value.platform) ||
    typeof value.videoId !== 'string' ||
    typeof value.addedBy !== 'string'
  ) {
    return false;
  }
  if (value.platform !== 'local') {
    // Backward compatibility: a non-local item may legitimately omit `local`.
    // A stray `local` field on a YouTube/Niconico item is simply ignored.
    return true;
  }
  return (
    LOCAL_VIDEO_ID_RE.test(value.videoId) && isLocalMediaMeta(value.local)
  );
}

/** Validate a `LocalMediaMeta` received from an untrusted transport. */
export function isLocalMediaMeta(value: unknown): value is LocalMediaMeta {
  if (!isRecord(value)) return false;
  return (
    typeof value.fileName === 'string' &&
    value.fileName.length >= 1 &&
    value.fileName.length <= MAX_LOCAL_FILE_NAME_LENGTH &&
    typeof value.sizeBytes === 'number' &&
    Number.isSafeInteger(value.sizeBytes) &&
    value.sizeBytes >= 0 &&
    typeof value.durationSec === 'number' &&
    Number.isFinite(value.durationSec) &&
    value.durationSec >= 0 &&
    value.durationSec <= MAX_LOCAL_DURATION_SEC &&
    typeof value.mimeType === 'string' &&
    value.mimeType.length <= MAX_LOCAL_MIME_LENGTH
  );
}

function isQueue(value: unknown): value is QueueItem[] {
  return Array.isArray(value) && value.every(isQueueItem);
}

function isParticipants(value: unknown): value is Participant[] {
  return Array.isArray(value) && value.every(isParticipant);
}

/**
 * Runtime validation for messages received from untrusted transports (MQTT is
 * a public broker, and PeerJS data can be sent by any connected peer). A
 * message may carry extra fields, but every field required by its type must be
 * present and correctly typed. Optional fields, when specified, are validated
 * as well.
 */
export function isValidSyncMessage(value: unknown): value is SyncMessage {
  if (!isRecord(value) || typeof value.type !== 'string') return false;

  switch (value.type) {
    case 'PLAY':
    case 'PAUSE':
    case 'SEEK':
      return (
        typeof value.senderId === 'string' && isFiniteNumber(value.currentTime)
      );
    case 'SYNC_PING':
      return (
        typeof value.senderId === 'string' &&
        isFiniteNumber(value.currentTime) &&
        typeof value.isPlaying === 'boolean' &&
        (value.sentAt === undefined || isFiniteNumber(value.sentAt))
      );
    case 'ROLE_UPDATE':
      return (
        typeof value.targetPeerId === 'string' &&
        isRole(value.role) &&
        typeof value.senderId === 'string'
      );
    case 'PARTICIPANTS':
      return (
        isParticipants(value.participants) &&
        typeof value.senderId === 'string'
      );
    case 'REQUEST_STATE':
      return typeof value.senderId === 'string';
    case 'QUEUE_UPDATE':
      return (
        isQueue(value.queue) &&
        (value.currentId === null || typeof value.currentId === 'string') &&
        isFiniteNumber(value.currentTime) &&
        (value.restart === undefined || typeof value.restart === 'boolean') &&
        typeof value.senderId === 'string'
      );
    case 'STATE_SNAPSHOT':
      return (
        isPlatform(value.platform) &&
        typeof value.videoId === 'string' &&
        (value.platform !== 'local' || LOCAL_VIDEO_ID_RE.test(value.videoId)) &&
        isFiniteNumber(value.currentTime) &&
        typeof value.isPlaying === 'boolean' &&
        isQueue(value.queue) &&
        (value.currentId === null || typeof value.currentId === 'string') &&
        typeof value.senderId === 'string'
      );
    case 'NAME_UPDATE':
      return (
        typeof value.peerId === 'string' &&
        typeof value.name === 'string' &&
        typeof value.senderId === 'string'
      );
    case 'VC_STATE':
      return (
        typeof value.active === 'boolean' && typeof value.senderId === 'string'
      );
    case 'VC_PEER':
      return (
        typeof value.peerId === 'string' &&
        typeof value.inVc === 'boolean' &&
        typeof value.senderId === 'string'
      );
    case 'DRIVE_MODE':
      return (
        typeof value.enabled === 'boolean' &&
        typeof value.audioOnly === 'boolean' &&
        typeof value.senderId === 'string'
      );
    case 'CHAT_MESSAGE':
      return (
        typeof value.peerId === 'string' &&
        typeof value.name === 'string' &&
        typeof value.text === 'string' &&
        isFiniteNumber(value.timestamp) &&
        typeof value.senderId === 'string' &&
        value.text.length <= MAX_CHAT_TEXT_LENGTH &&
        value.name.length <= MAX_CHAT_NAME_LENGTH
      );
    default:
      return false;
  }
}

/** Local player state changes detected by a platform hook (emitted for broadcast). */
export type LocalPlayerEvent =
  | { kind: 'PLAY'; currentTime: number }
  | { kind: 'PAUSE'; currentTime: number }
  | { kind: 'SEEK'; currentTime: number }
  | { kind: 'END' };

/**
 * Uniform control surface implemented by both useYouTubePlayer and
 * useNiconicoPlayer. useRoomSync drives the active platform's controller for
 * remote commands without caring which platform is mounted.
 */
export type YouTubePlaybackQuality =
  | 'tiny'
  | 'small'
  | 'medium'
  | 'large'
  | 'hd720'
  | 'hd1080'
  | 'highres'
  | 'default';

export interface PlayerController {
  loadMedia(videoId: string, suggestedQuality?: YouTubePlaybackQuality | string): void;
  /**
   * Force a reload of the currently loaded media, bypassing `loadMedia`'s
   * same-id dedupe. Used by error-recovery UI (e.g. Niconico's "再読み込み")
   * where the iframe was kept mounted but playback failed.
   */
  reloadMedia?(): void;
  play(): void;
  pause(): void;
  seekTo(seconds: number): void;
  getCurrentTime(): number;
  getIsPlaying(): boolean;
  /**
   * True while the player is loading (YouTube BUFFERING / Niconico
   * playerStatus===1). The sync layer must not correct drift during this
   * phase — the device is loading, not out of sync. Optional so lightweight
   * test doubles stay valid.
   */
  isBuffering?(): boolean;
  /**
   * How long the last seek spent buffering before playback resumed (ms).
   * Used to widen the drift tolerance on devices where a seek is expensive.
   */
  getSeekRecoveryMs?(): number;
  setVolume?(volume: number): void;
  getVolume?(): number;
  setPlaybackQuality?(quality: string): void;
  getPlaybackQuality?(): string;
  setLowQualityMode?(enabled: boolean): void;
}

/** Threshold (seconds) beyond which a SYNC_PING forces a re-seek. */
export const SYNC_DRIFT_THRESHOLD = 1.5;

/** Interval (ms) between periodic SYNC_PING messages. */
export const SYNC_PING_INTERVAL = 3000;

/** Parsed media reference produced from a user-supplied URL or raw id. */
export interface ParsedMedia {
  platform: Platform;
  videoId: string;
}

/** Best-effort parse of a YouTube or Niconico URL / id. Returns null if unknown. */
export function parseMediaInput(raw: string): ParsedMedia | null {
  const s = raw.trim();
  if (!s) return null;

  // YouTube
  const ytIdMatch = s.match(
    /(?:youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/|v\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/
  );
  if (ytIdMatch) return { platform: 'youtube', videoId: ytIdMatch[1] };
  if (/^[A-Za-z0-9_-]{11}$/.test(s)) return { platform: 'youtube', videoId: s };

  // Niconico
  const nicoMatch = s.match(
    /(?:nicovideo\.jp\/watch\/|embed\.nicovideo\.jp\/watch\/|nico\.ms\/(?:watch\/)?)([a-z]{2}[0-9]+)/
  );
  if (nicoMatch) return { platform: 'niconico', videoId: nicoMatch[1] };
  if (/^(sm|nm|so)[0-9]+$/.test(s)) return { platform: 'niconico', videoId: s };

  return null;
}

/** A human-readable display URL for a parsed media reference. */
export function toWatchUrl(media: ParsedMedia): string {
  if (media.platform === 'youtube') {
    return `https://www.youtube.com/watch?v=${media.videoId}`;
  }
  if (media.platform === 'niconico') {
    return `https://www.nicovideo.jp/watch/${media.videoId}`;
  }
  // Local media has no external watch page.
  return '';
}
