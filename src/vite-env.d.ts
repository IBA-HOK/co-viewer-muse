/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_TRANSPORT?: 'peerjs' | 'mqtt';
  readonly VITE_MQTT_BROKER_URL?: string;
}

declare global {
  interface YTPlayerEvent {
    target: YTPlayer;
    data: number;
  }

  interface YTPlayer {
    playVideo(): void;
    pauseVideo(): void;
    seekTo(seconds: number, allowSeekAhead: boolean): void;
    loadVideoById(videoId: string, startSeconds?: number): void;
    cueVideoById(videoId: string, startSeconds?: number): void;
    getCurrentTime(): number;
    getPlayerState(): number;
    mute(): void;
    unMute(): void;
    destroy(): void;
  }

  interface YTPlayerConstructor {
    new (
      el: HTMLElement | string,
      options: {
        videoId?: string;
        playerVars?: Record<string, string | number>;
        events?: {
          onReady?: (e: YTPlayerEvent) => void;
          onStateChange?: (e: YTPlayerEvent) => void;
          onError?: (e: YTPlayerEvent) => void;
        };
      }
    ): YTPlayer;
  }

  interface Window {
    YT?: {
      Player: YTPlayerConstructor;
      PlayerState: {
        UNSTARTED: number;
        ENDED: number;
        PLAYING: number;
        PAUSED: number;
        BUFFERING: number;
        CUED: number;
      };
    };
    onYouTubeIframeAPIReady?: () => void;
  }
}

export {};
