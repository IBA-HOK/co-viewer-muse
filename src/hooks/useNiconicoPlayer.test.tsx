/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import type { MutableRefObject } from 'react';
import type { LocalPlayerEvent } from '../types';
import {
  useNiconicoPlayer,
  type UseNiconicoPlayerResult,
} from './useNiconicoPlayer';

const NICO_ORIGIN = 'https://embed.nicovideo.jp';

const STATUS = {
  BUFFERING: 1,
  PLAYING: 2,
  PAUSED: 3,
  ENDED: 4,
} as const;

let latest: UseNiconicoPlayerResult | null = null;

function Harness(props: {
  isRemoteSyncingRef: MutableRefObject<boolean>;
  onLocalEvent: (e: LocalPlayerEvent) => void;
}) {
  const nico = useNiconicoPlayer({
    isRemoteSyncingRef: props.isRemoteSyncingRef,
    onLocalEvent: props.onLocalEvent,
  });
  latest = nico;
  return <div ref={nico.containerRef} />;
}

/**
 * The playerId is generated inside the hook and is the postMessage routing
 * key. Reproduce it from the iframe URL so the test speaks the real protocol.
 */
function readPlayerId(container: HTMLElement): string {
  const iframe = container.querySelector('iframe');
  if (!iframe) throw new Error('niconico iframe not mounted');
  const playerId = new URL(iframe.src).searchParams.get('playerId');
  if (!playerId) throw new Error('playerId missing from embed URL');
  return playerId;
}

function mountHook() {
  const isRemoteSyncingRef = { current: false } as MutableRefObject<boolean>;
  const onLocalEvent = vi.fn<(e: LocalPlayerEvent) => void>();
  const view = render(
    <Harness
      isRemoteSyncingRef={isRemoteSyncingRef}
      onLocalEvent={onLocalEvent}
    />
  );
  act(() => latest!.loadMedia('sm9'));
  const playerId = readPlayerId(view.container);

  const emitEvent = (eventName: string, data?: Record<string, unknown>) => {
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          origin: NICO_ORIGIN,
          data: {
            sourceConnectorType: 0,
            playerId,
            eventName,
            data,
          },
        })
      );
    });
  };

  const emitPlayerStatus = (playerStatus: number) => {
    emitEvent('playerStatusChange', { playerStatus });
  };

  return {
    result: {
      get current(): UseNiconicoPlayerResult {
        if (!latest) throw new Error('hook not mounted');
        return latest;
      },
    },
    onLocalEvent,
    isRemoteSyncingRef,
    emitEvent,
    emitPlayerStatus,
    unmount: view.unmount,
  };
}

afterEach(() => {
  latest = null;
  vi.restoreAllMocks();
});

describe('useNiconicoPlayer · playerStatusChange', () => {
  it('tracks BUFFERING without broadcasting a PAUSE', () => {
    const { result, onLocalEvent, emitPlayerStatus } = mountHook();

    emitPlayerStatus(STATUS.PLAYING);
    onLocalEvent.mockClear();

    emitPlayerStatus(STATUS.BUFFERING);

    expect(onLocalEvent).not.toHaveBeenCalled();
    expect(result.current.isBuffering()).toBe(true);
  });

  it('broadcasts PLAY / PAUSE / END exactly once for their statuses', () => {
    const { onLocalEvent, emitPlayerStatus } = mountHook();

    emitPlayerStatus(STATUS.PLAYING);
    emitPlayerStatus(STATUS.PAUSED);
    emitPlayerStatus(STATUS.ENDED);

    expect(onLocalEvent).toHaveBeenCalledTimes(3);
    expect(onLocalEvent).toHaveBeenNthCalledWith(1, {
      kind: 'PLAY',
      currentTime: 0,
    });
    expect(onLocalEvent).toHaveBeenNthCalledWith(2, {
      kind: 'PAUSE',
      currentTime: 0,
    });
    expect(onLocalEvent).toHaveBeenNthCalledWith(3, { kind: 'END' });
  });

  it('ignores unknown statuses', () => {
    const { onLocalEvent, emitPlayerStatus } = mountHook();

    emitPlayerStatus(99);

    expect(onLocalEvent).not.toHaveBeenCalled();
  });

  it('reloads the same video after an error while loadMedia stays deduped', () => {
    const { result, emitEvent } = mountHook();
    const iframe = document.querySelector('iframe');
    if (!iframe) throw new Error('niconico iframe not mounted');
    const srcSetter = vi.spyOn(HTMLIFrameElement.prototype, 'src', 'set');

    emitEvent('loadComplete');
    expect(result.current.ready).toBe(true);

    emitEvent('error', { code: 'possibly_deleted_video' });
    expect(result.current.error).not.toBeNull();

    // The normal dedupe must not reload the iframe for the same video.
    act(() => result.current.loadMedia('sm9'));
    expect(srcSetter).not.toHaveBeenCalled();

    // The explicit recovery path bypasses the dedupe and resets error/ready.
    act(() => result.current.reloadMedia());
    expect(srcSetter).toHaveBeenCalledTimes(1);
    expect(result.current.error).toBeNull();
    expect(result.current.ready).toBe(false);
  });

  it('does not auto-play after loadComplete when paused during loading, but applies the seek', () => {
    const { result, emitEvent } = mountHook();
    const iframe = document.querySelector('iframe');
    if (!iframe || !iframe.contentWindow) {
      throw new Error('niconico iframe not mounted');
    }
    const postMessage = vi.spyOn(iframe.contentWindow, 'postMessage');

    // Simulate a guest receiving a paused room snapshot: seek + pause arrive
    // while the embed is still loading.
    act(() => result.current.seekTo(12));
    act(() => result.current.pause());
    postMessage.mockClear();

    emitEvent('loadComplete');

    const loadingCommands = postMessage.mock.calls.map(
      ([message]) => (message as { eventName?: string }).eventName
    );
    expect(loadingCommands).not.toContain('play');
    expect(loadingCommands).toContain('seek');
    const seek = postMessage.mock.calls.find(
      ([message]) => (message as { eventName?: string }).eventName === 'seek'
    );
    expect((seek?.[0] as { data?: { time?: number } }).data?.time).toBe(12000);

    // A later explicit play request must still reach the embed.
    act(() => result.current.play());
    const playCommand = postMessage.mock.calls.find(
      ([message]) => (message as { eventName?: string }).eventName === 'play'
    );
    expect(playCommand).toBeDefined();
  });

  it('still suppresses remote-operation echoes', () => {
    const { onLocalEvent, isRemoteSyncingRef, emitPlayerStatus } = mountHook();
    isRemoteSyncingRef.current = true;
    onLocalEvent.mockClear();

    emitPlayerStatus(STATUS.PLAYING);
    emitPlayerStatus(STATUS.PAUSED);
    emitPlayerStatus(STATUS.ENDED);

    expect(onLocalEvent).not.toHaveBeenCalled();
  });
});
