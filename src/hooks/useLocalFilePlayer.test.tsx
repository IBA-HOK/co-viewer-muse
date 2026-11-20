/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import type { MutableRefObject } from 'react';
import type { LocalPlayerEvent } from '../types';
import {
  useLocalFilePlayer,
  type UseLocalFilePlayerResult,
} from './useLocalFilePlayer';

let latest: UseLocalFilePlayerResult | null = null;

function Harness(props: {
  isRemoteSyncingRef: MutableRefObject<boolean>;
  onLocalEvent: (e: LocalPlayerEvent) => void;
  resolveUrl: (videoId: string) => string | null;
  suppressEnd?: boolean;
}) {
  const local = useLocalFilePlayer({
    isRemoteSyncingRef: props.isRemoteSyncingRef,
    onLocalEvent: props.onLocalEvent,
    resolveUrl: props.resolveUrl,
    suppressEnd: props.suppressEnd,
  });
  latest = local;
  return <video ref={local.mediaRef} data-testid="local-video" />;
}

function setMediaState(
  el: HTMLVideoElement,
  state: Partial<{
    currentTime: number;
    readyState: number;
    paused: boolean;
    ended: boolean;
  }>
) {
  for (const [key, value] of Object.entries(state)) {
    Object.defineProperty(el, key, {
      configurable: true,
      writable: true,
      value,
    });
  }
}

function mountHook(options: {
  url?: string | null;
  suppressEnd?: boolean;
} = {}) {
  const isRemoteSyncingRef = { current: false } as MutableRefObject<boolean>;
  const onLocalEvent = vi.fn<(e: LocalPlayerEvent) => void>();
  const resolveUrl = vi.fn((videoId: string) =>
    videoId === 'local-id-1' ? (options.url ?? 'blob:test') : null
  );
  const view = render(
    <Harness
      isRemoteSyncingRef={isRemoteSyncingRef}
      onLocalEvent={onLocalEvent}
      resolveUrl={resolveUrl}
      suppressEnd={options.suppressEnd}
    />
  );
  const video = view.getByTestId('local-video') as HTMLVideoElement;
  setMediaState(video, {
    currentTime: 0,
    readyState: 4,
    paused: true,
    ended: false,
  });
  return { video, onLocalEvent, isRemoteSyncingRef, resolveUrl, view };
}

beforeEach(() => {
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
});

afterEach(() => {
  latest = null;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('useLocalFilePlayer · load and playback', () => {
  it('sets the resolved object URL and reports ready on loadedmetadata', () => {
    const { video } = mountHook();
    act(() => latest!.loadMedia('local-id-1'));
    expect(video.getAttribute('src')).toBe('blob:test');
    expect(latest!.ready).toBe(false);

    act(() => video.dispatchEvent(new Event('loadedmetadata')));
    expect(latest!.ready).toBe(true);
  });

  it('does not load when no file is selected yet', () => {
    const { video, resolveUrl } = mountHook();
    act(() => latest!.loadMedia('missing-id'));
    expect(resolveUrl).toHaveBeenCalledWith('missing-id');
    expect(video.getAttribute('src')).toBeNull();
    expect(latest!.ready).toBe(false);
  });

  it('deduplicates the same video + URL but reloads when the URL changes', () => {
    const { video } = mountHook();
    act(() => latest!.loadMedia('local-id-1'));
    expect(video.getAttribute('src')).toBe('blob:test');
    act(() => latest!.loadMedia('local-id-1'));
    expect(HTMLMediaElement.prototype.load).toHaveBeenCalledTimes(1);
  });

  it('reports play / pause / seek events with the element position', () => {
    vi.useFakeTimers();
    const { video, onLocalEvent } = mountHook();
    act(() => latest!.loadMedia('local-id-1'));
    act(() => video.dispatchEvent(new Event('loadedmetadata')));
    // The load keeps a short echo-suppression window.
    act(() => {
      vi.advanceTimersByTime(1500);
    });

    setMediaState(video, { currentTime: 12.5, paused: false });
    act(() => video.dispatchEvent(new Event('play')));
    expect(onLocalEvent).toHaveBeenCalledWith({
      kind: 'PLAY',
      currentTime: 12.5,
    });

    setMediaState(video, { currentTime: 13, paused: true });
    act(() => video.dispatchEvent(new Event('pause')));
    expect(onLocalEvent).toHaveBeenCalledWith({
      kind: 'PAUSE',
      currentTime: 13,
    });

    setMediaState(video, { currentTime: 30 });
    act(() => video.dispatchEvent(new Event('seeked')));
    expect(onLocalEvent).toHaveBeenCalledWith({
      kind: 'SEEK',
      currentTime: 30,
    });
  });

  it('implements the controller getters', () => {
    const { video } = mountHook();
    act(() => latest!.loadMedia('local-id-1'));
    setMediaState(video, { currentTime: 7.25, paused: false, ended: false });
    expect(latest!.getCurrentTime()).toBe(7.25);
    expect(latest!.getIsPlaying()).toBe(true);

    setMediaState(video, { readyState: 2, paused: true });
    expect(latest!.isBuffering()).toBe(true);
    setMediaState(video, { readyState: 4 });

    act(() => latest!.setVolume(40));
    expect(video.volume).toBeCloseTo(0.4);
    expect(latest!.getVolume()).toBe(40);
  });

  it('queues a seek until metadata is available and applies it on load', () => {
    const { video } = mountHook();
    act(() => latest!.loadMedia('local-id-1'));
    setMediaState(video, { readyState: 0 });
    act(() => latest!.seekTo(45));
    expect(video.currentTime).toBe(0);

    setMediaState(video, { readyState: 1 });
    act(() => video.dispatchEvent(new Event('loadedmetadata')));
    expect(video.currentTime).toBe(45);
  });

  it('replays a play() issued before metadata once the file is loaded', () => {
    const { video } = mountHook();
    act(() => latest!.loadMedia('local-id-1'));
    setMediaState(video, { readyState: 0 });
    const playSpy = vi.mocked(HTMLMediaElement.prototype.play);
    playSpy.mockClear();

    act(() => latest!.play());
    expect(playSpy).not.toHaveBeenCalled();

    setMediaState(video, { readyState: 1 });
    act(() => video.dispatchEvent(new Event('loadedmetadata')));
    expect(playSpy).toHaveBeenCalledTimes(1);
  });
});

describe('useLocalFilePlayer · drift-guard signals', () => {
  it('measures seek recovery between seeking and seeked', () => {
    vi.useFakeTimers();
    const { video } = mountHook();
    act(() => latest!.loadMedia('local-id-1'));
    act(() => video.dispatchEvent(new Event('loadedmetadata')));
    act(() => {
      vi.advanceTimersByTime(1500);
    });

    act(() => video.dispatchEvent(new Event('seeking')));
    act(() => {
      vi.advanceTimersByTime(450);
    });
    act(() => video.dispatchEvent(new Event('seeked')));
    expect(latest!.getSeekRecoveryMs()).toBe(450);
    expect(latest!.isBuffering()).toBe(false);
  });

  it('suppresses events while a remote command is being applied', () => {
    const { video, onLocalEvent, isRemoteSyncingRef } = mountHook();
    isRemoteSyncingRef.current = true;

    act(() => video.dispatchEvent(new Event('play')));
    act(() => video.dispatchEvent(new Event('pause')));
    act(() => video.dispatchEvent(new Event('seeked')));

    expect(onLocalEvent).not.toHaveBeenCalled();
  });

  it('does not emit a SEEK echo for a programmatic seek', () => {
    const { video, onLocalEvent } = mountHook();
    act(() => latest!.loadMedia('local-id-1'));
    act(() => video.dispatchEvent(new Event('loadedmetadata')));
    onLocalEvent.mockClear();

    act(() => latest!.seekTo(20));
    act(() => video.dispatchEvent(new Event('seeking')));
    act(() => video.dispatchEvent(new Event('seeked')));

    expect(onLocalEvent).not.toHaveBeenCalled();
  });
});

describe('useLocalFilePlayer · end handling and autoplay', () => {
  it('reports END when the file ends normally', () => {
    const { video, onLocalEvent } = mountHook();
    act(() => video.dispatchEvent(new Event('ended')));
    expect(onLocalEvent).toHaveBeenCalledWith({ kind: 'END' });
    expect(latest!.endedSuppressed).toBe(false);
  });

  it('suppresses END and flags the UI when suppressEnd is active', () => {
    const { video, onLocalEvent } = mountHook({ suppressEnd: true });
    act(() => video.dispatchEvent(new Event('ended')));
    expect(onLocalEvent).not.toHaveBeenCalled();
    expect(latest!.endedSuppressed).toBe(true);
  });

  it('sets needsGesture when play() is rejected by the autoplay policy', async () => {
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockRejectedValue(
      Object.assign(new Error('blocked'), { name: 'NotAllowedError' })
    );
    const { video } = mountHook();
    act(() => latest!.play());
    await act(async () => {
      await Promise.resolve();
    });
    expect(video).toBeTruthy();
    expect(latest!.needsGesture).toBe(true);
  });

  it('exposes a user-facing message when the browser cannot decode the file', () => {
    const { video } = mountHook();
    Object.defineProperty(video, 'error', {
      configurable: true,
      value: { code: 4 },
    });
    act(() => video.dispatchEvent(new Event('error')));
    expect(latest!.ready).toBe(false);
    expect(latest!.error).toContain('この形式はブラウザで再生できません');
  });
});
