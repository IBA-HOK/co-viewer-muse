import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useVoiceChat } from './useVoiceChat';
import type { UsePeerResult } from './usePeer';
import type { UseRoomSyncResult } from './useRoomSync';

// jsdom has no AudioWorkletNode; the noise-suppressor module subclasses it at import time.
vi.mock('@sapphi-red/web-noise-suppressor', () => ({
  RnnoiseWorkletNode: class {},
  loadRnnoise: vi.fn(),
}));

function makeTrack() {
  return {
    kind: 'audio',
    enabled: true,
    readyState: 'live',
    stop: vi.fn(),
  } as unknown as MediaStreamTrack;
}

function makeStream(tracks: MediaStreamTrack[]) {
  return {
    getTracks: () => tracks,
    getAudioTracks: () => tracks,
  } as unknown as MediaStream;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function makePeer(): UsePeerResult {
  return {
    isHost: true,
    myId: 'host-peer',
    roomId: 'room',
    connected: true,
    broadcast: vi.fn(),
    sendTo: vi.fn(),
    callPeer: vi.fn(() => null),
    onCall: vi.fn(),
    reconnect: vi.fn(),
  };
}

function makeRoomSync(broadcastVcPeer = vi.fn(), setVcActive = vi.fn()): UseRoomSyncResult {
  return {
    vcActive: false,
    vcPeers: new Set<string>(),
    broadcastVcPeer,
    setVcActive,
  } as unknown as UseRoomSyncResult;
}

describe('useVoiceChat start cancellation', () => {
  const originalMediaDevices = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices');

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    if (originalMediaDevices) {
      Object.defineProperty(navigator, 'mediaDevices', originalMediaDevices);
    } else {
      delete (navigator as unknown as { mediaDevices?: unknown }).mediaDevices;
    }
  });

  function stubGetUserMedia(getUserMedia: () => Promise<MediaStream>) {
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia },
    });
  }

  it('aborts a pending start when hostStop is called before the mic is granted', async () => {
    const d = deferred<MediaStream>();
    const getUserMedia = vi.fn(() => d.promise);
    stubGetUserMedia(getUserMedia);
    const track = makeTrack();
    const stream = makeStream([track]);
    const broadcastVcPeer = vi.fn();
    const setVcActive = vi.fn();

    const { result } = renderHook(() =>
      useVoiceChat({
        peer: makePeer(),
        roomSync: makeRoomSync(broadcastVcPeer, setVcActive),
        isHost: true,
        myId: 'host-peer',
      })
    );

    act(() => {
      result.current.hostStart();
    });
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(result.current.starting).toBe(true);

    act(() => {
      result.current.hostStop();
    });

    await act(async () => {
      d.resolve(stream);
      await d.promise;
      await Promise.resolve();
    });

    expect(result.current.inVc).toBe(false);
    expect(broadcastVcPeer).not.toHaveBeenCalledWith(true);
    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(result.current.starting).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('shares one getUserMedia call when hostStart is invoked twice', async () => {
    const d = deferred<MediaStream>();
    const getUserMedia = vi.fn(() => d.promise);
    stubGetUserMedia(getUserMedia);

    const { result } = renderHook(() =>
      useVoiceChat({
        peer: makePeer(),
        roomSync: makeRoomSync(),
        isHost: true,
        myId: 'host-peer',
      })
    );

    act(() => {
      result.current.hostStart();
      result.current.hostStart();
    });

    expect(getUserMedia).toHaveBeenCalledTimes(1);

    // Cancel and settle so the pending start does not outlive the test.
    act(() => {
      result.current.hostStop();
    });
    await act(async () => {
      d.resolve(makeStream([makeTrack()]));
      await d.promise;
      await Promise.resolve();
    });
  });
});
