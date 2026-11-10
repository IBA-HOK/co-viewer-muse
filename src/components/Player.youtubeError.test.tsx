/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act, screen, waitFor } from '@testing-library/react';
import type { MutableRefObject } from 'react';
import { Player, type PlayerProps } from './Player';
import type { LocalPlayerEvent, PlayerController } from '../types';

const PLAYER_STATE = {
  UNSTARTED: -1,
  ENDED: 0,
  PLAYING: 1,
  PAUSED: 2,
  BUFFERING: 3,
  CUED: 5,
} as const;

interface FakeEvents {
  onReady?: () => void;
  onStateChange?: (e: { target: unknown; data: number }) => void;
  onError?: (e: { data: number }) => void;
}

class FakePlayer {
  loadVideoById = vi.fn();
  getCurrentTime = vi.fn(() => 0);
  playVideo = vi.fn();
  pauseVideo = vi.fn();
  seekTo = vi.fn();
  setVolume = vi.fn();
  getVolume = vi.fn(() => 100);
  destroy = vi.fn();
  readonly events: FakeEvents;

  constructor(_el: HTMLElement, options: { events?: FakeEvents }) {
    this.events = options.events ?? {};
  }

  emitReady() {
    this.events.onReady?.();
  }

  emitError(data: number) {
    this.events.onError?.({ data });
  }
}

let player: FakePlayer | null = null;

function installYouTubeStub() {
  player = null;
  (window as unknown as { YT?: unknown }).YT = {
    Player: function PlayerMock(
      el: HTMLElement,
      options: { events?: FakeEvents }
    ) {
      player = new FakePlayer(el, options);
      return player;
    },
    PlayerState: PLAYER_STATE,
  };
}

function renderPlayer(overrides: Partial<PlayerProps> = {}) {
  const controllerRef = { current: null } as MutableRefObject<PlayerController | null>;
  const isRemoteSyncingRef = { current: false } as MutableRefObject<boolean>;
  const reportLocalEvent = vi.fn<(e: LocalPlayerEvent) => void>();
  const props: PlayerProps = {
    platform: 'youtube',
    videoId: 'aaaaaaaaaaa',
    canControl: true,
    isHost: true,
    controllerRef,
    isRemoteSyncingRef,
    reportLocalEvent,
    ...overrides,
  };
  const view = render(<Player {...props} />);
  return { ...view, props };
}

async function waitForReady() {
  await waitFor(() => expect(player).not.toBeNull());
  act(() => player!.emitReady());
}

beforeEach(() => {
  installYouTubeStub();
});

afterEach(() => {
  vi.restoreAllMocks();
  delete (window as unknown as { YT?: unknown }).YT;
  player = null;
});

describe('Player · YouTube error overlay', () => {
  it('hides the error overlay after a different video is loaded', async () => {
    const { rerender, props } = renderPlayer();
    await waitForReady();

    act(() => player!.emitError(150));
    expect(screen.getByText(/YouTube再生エラー \(code 150\)/)).toBeTruthy();

    rerender(<Player {...props} videoId="bbbbbbbbbbb" />);

    await waitFor(() =>
      expect(screen.queryByText(/YouTube再生エラー/)).toBeNull()
    );
    expect(player!.loadVideoById).toHaveBeenLastCalledWith('bbbbbbbbbbb');
  });
});

describe('Player · YouTube IFrame API load failure', () => {
  it('shows an error overlay instead of an empty player when the API script fails', async () => {
    delete (window as unknown as { YT?: unknown }).YT;
    const original = document.head.appendChild.bind(document.head);
    const scripts: HTMLScriptElement[] = [];
    vi.spyOn(document.head, 'appendChild').mockImplementation((node: Node) => {
      if (node instanceof HTMLScriptElement) scripts.push(node);
      return original(node);
    });

    renderPlayer();
    await waitFor(() => expect(scripts).toHaveLength(1));
    act(() => {
      scripts[0].dispatchEvent(new Event('error'));
    });

    await waitFor(() =>
      expect(
        screen.getByText(/YouTubeプレーヤーを読み込めませんでした/)
      ).toBeTruthy()
    );
    expect(scripts[0].isConnected).toBe(false);
  });
});
