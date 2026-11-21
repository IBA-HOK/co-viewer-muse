/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useFileTransfer, type CurrentLocalFile } from './useFileTransfer';
import { computeLocalMediaIntegrity } from '../localFile';
import type { TransportFileChannel } from '../transport/types';
import type { LocalMediaMeta } from '../types';
import { FILE_CHANNEL_LABEL } from '../transfer/fileTransfer';

type Listener = (event: {
  kind: 'open' | 'close' | 'data';
  peerId: string;
  data?: unknown;
}) => void;

interface FakeChannel extends TransportFileChannel {
  connected: boolean;
  delivered: unknown[];
}

/**
 * In-memory pair of labelled file channels. Control frames from the host reach
 * the guest and vice versa; chunks are delivered asynchronously like PeerJS.
 */
function createChannelPair(): {
  host: FakeChannel;
  guest: FakeChannel;
  connect: () => void;
} {
  const listeners = { host: new Set<Listener>(), guest: new Set<Listener>() };
  const delivered: unknown[] = [];
  const emit = (side: 'host' | 'guest', event: Parameters<Listener>[0]) => {
    for (const listener of [...listeners[side]]) listener(event);
  };
  let connected = false;
  const make = (side: 'host' | 'guest'): FakeChannel => {
    const other = side === 'host' ? 'guest' : 'host';
    const peerId = side === 'host' ? 'guest-1' : 'host-1';
    // The receiver sees the sender's peer id.
    const senderId = side === 'host' ? 'host-1' : 'guest-1';
    return {
      connected,
      delivered,
      open() {
        if (connected) return;
        connected = true;
        queueMicrotask(() => {
          emit('host', { kind: 'open', peerId: 'guest-1' });
          emit('guest', { kind: 'open', peerId: 'host-1' });
        });
      },
      send(_peerId: string, data: unknown) {
        if (!connected) return false;
        delivered.push(data);
        queueMicrotask(() => {
          emit(other, { kind: 'data', peerId: senderId, data });
        });
        return true;
      },
      close() {
        connected = false;
        emit(side, { kind: 'close', peerId });
      },
      isOpen() {
        return connected;
      },
      bufferedAmount() {
        return 0;
      },
      subscribe(callback: Listener) {
        listeners[side].add(callback);
        return () => listeners[side].delete(callback);
      },
    };
  };
  return {
    host: make('host'),
    guest: make('guest'),
    connect: () => {
      if (connected) return;
      connected = true;
      emit('host', { kind: 'open', peerId: 'guest-1' });
      emit('guest', { kind: 'open', peerId: 'host-1' });
    },
  };
}

async function makeLocalFile(): Promise<{
  file: File;
  meta: LocalMediaMeta;
}> {
  const bytes = new Uint8Array(40000);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = i % 251;
  const file = new File([bytes], 'holiday.mp4', { type: 'video/mp4' });
  const integrity = await computeLocalMediaIntegrity(file);
  return {
    file,
    meta: {
      fileName: 'holiday.mp4',
      sizeBytes: file.size,
      durationSec: 42,
      mimeType: 'video/mp4',
      integrity,
    },
  };
}

describe('useFileTransfer', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('transfers a file over the dedicated channel and verifies it', async () => {
    const { file, meta } = await makeLocalFile();
    const currentLocal: CurrentLocalFile = {
      videoId: 'local-abcdefgh',
      file,
      meta,
    };
    const channels = createChannelPair();
    const onFileReceived = vi.fn();

    const host = renderHook(() =>
      useFileTransfer({
        enabled: true,
        isHost: true,
        myId: 'host-1',
        hostPeerId: 'host-1',
        peers: ['guest-1'],
        currentLocal,
        activeVideoId: null,
        hasLocalFile: () => false,
        channel: channels.host,
        onFileReceived: vi.fn(),
        maxBytes: 1024 * 1024,
      })
    );

    const guest = renderHook(() =>
      useFileTransfer({
        enabled: true,
        isHost: false,
        myId: 'guest-1',
        hostPeerId: 'host-1',
        peers: [],
        currentLocal: null,
        activeVideoId: 'local-abcdefgh',
        hasLocalFile: () => false,
        channel: channels.guest,
        onFileReceived,
        maxBytes: 1024 * 1024,
      })
    );

    // Host opens the dedicated channel; the offer follows on open.
    act(() => channels.host.open());

    await waitFor(
      () => {
        expect(onFileReceived).toHaveBeenCalledTimes(1);
      },
      { timeout: 10000 }
    );

    const [videoId, receivedFile, receivedMeta] =
      onFileReceived.mock.calls[0];
    expect(videoId).toBe('local-abcdefgh');
    expect(receivedFile.size).toBe(file.size);
    expect(receivedMeta.integrity?.hashes).toEqual(meta.integrity?.hashes);
    expect(guest.result.current.status.phase).toBe('ready');
    // The sync channel never sees any of this; it all went over the file channel.
    expect(channels.host.delivered.length).toBeGreaterThan(0);

    act(() => {
      host.unmount();
      guest.unmount();
    });
  }, 15000);

  it('rejects an oversized offer and asks for the manual flow', async () => {
    const { file, meta } = await makeLocalFile();
    const channels = createChannelPair();
    const guest = renderHook(() =>
      useFileTransfer({
        enabled: true,
        isHost: false,
        myId: 'guest-1',
        hostPeerId: 'host-1',
        peers: [],
        currentLocal: null,
        activeVideoId: 'local-abcdefgh',
        hasLocalFile: () => false,
        channel: channels.guest,
        onFileReceived: vi.fn(),
        maxBytes: 10,
      })
    );

    act(() => {
      channels.guest.isOpen();
      // Simulate the host's channel opening and offering the file.
      channels.host.open();
    });
    // The host side of the fake pair must send an actual offer.
    act(() => {
      channels.host.send('guest-1', {
        type: 'FILE_OFFER',
        transferId: 1,
        videoId: 'local-abcdefgh',
        meta,
        totalBytes: file.size,
        integrity: meta.integrity,
      });
    });

    await waitFor(() => {
      expect(guest.result.current.status.phase).toBe('error');
    });
    const status = guest.result.current.status;
    expect(status.phase).toBe('error');
    if (status.phase === 'error') {
      expect(status.fallbackToManual).toBe(true);
    }

    act(() => guest.unmount());
  });

  it('cancels an in-flight receive when the queue moves to another item', async () => {
    const { file, meta } = await makeLocalFile();
    const channels = createChannelPair();
    const guest = renderHook(
      (props: { activeVideoId: string }) =>
        useFileTransfer({
          enabled: true,
          isHost: false,
          myId: 'guest-1',
          hostPeerId: 'host-1',
          peers: [],
          currentLocal: null,
          activeVideoId: props.activeVideoId,
          hasLocalFile: () => false,
          channel: channels.guest,
          onFileReceived: vi.fn(),
          maxBytes: 1024 * 1024,
        }),
      { initialProps: { activeVideoId: 'local-abcdefgh' } }
    );

    act(() => channels.host.open());
    act(() => {
      channels.host.send('guest-1', {
        type: 'FILE_OFFER',
        transferId: 9,
        videoId: 'local-abcdefgh',
        meta,
        totalBytes: file.size,
        integrity: meta.integrity,
      });
    });

    await waitFor(() => {
      expect(guest.result.current.status.phase).toBe('offering');
    });

    act(() => guest.rerender({ activeVideoId: 'local-zzzzzzzz' }));

    await waitFor(() => {
      expect(guest.result.current.status.phase).toBe('cancelled');
    });

    act(() => guest.unmount());
  });

  it('exposes the dedicated label for the PeerJS channel', () => {
    expect(FILE_CHANNEL_LABEL).toBe('co-viewer-file-v1');
  });
});
