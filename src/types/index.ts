// Core domain types for the P2P co-viewer.
// These contracts are the single source of truth shared by hooks and components.

export type Platform = 'youtube' | 'niconico';

export type Role = 'Host' | 'Controller' | 'Viewer';

export interface Participant {
  peerId: string;
  name: string;
  isHost: boolean;
  role: Role;
}

/** A single queued video. `id` is `${platform}:${videoId}` for dedupe. */
export interface QueueItem {
  id: string;
  platform: Platform;
  videoId: string;
  addedBy: string;
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
  return media.platform === 'youtube'
    ? `https://www.youtube.com/watch?v=${media.videoId}`
    : `https://www.nicovideo.jp/watch/${media.videoId}`;
}
