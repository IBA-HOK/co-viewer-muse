/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { MutableRefObject } from 'react';
import { Player, type PlayerProps } from './Player';
import type {
  FileTransferStatus,
  LocalMediaMeta,
  LocalPlayerEvent,
  PlayerController,
} from '../types';
import type { LocalMatchResult } from '../localFile';

const META: LocalMediaMeta = {
  fileName: 'holiday.mp4',
  sizeBytes: 123456,
  durationSec: 90,
  mimeType: 'video/mp4',
};

function renderPlayer(overrides: Partial<PlayerProps> = {}) {
  const controllerRef = { current: null } as MutableRefObject<PlayerController | null>;
  const isRemoteSyncingRef = { current: false } as MutableRefObject<boolean>;
  const reportLocalEvent = vi.fn<(e: LocalPlayerEvent) => void>();
  const onSelectLocalFile = vi.fn();
  const onConfirmLocalFile = vi.fn();
  const onCancelLocalFile = vi.fn();
  const props: PlayerProps = {
    platform: 'local',
    videoId: 'local-abcdefgh',
    canControl: true,
    isHost: false,
    controllerRef,
    isRemoteSyncingRef,
    reportLocalEvent,
    localMeta: META,
    localFileUrl: null,
    localMatch: null,
    localPending: null,
    localError: null,
    onSelectLocalFile,
    onConfirmLocalFile,
    onCancelLocalFile,
    ...overrides,
  };
  const view = render(<Player {...props} />);
  return {
    ...view,
    props,
    controllerRef,
    onSelectLocalFile,
    onConfirmLocalFile,
    onCancelLocalFile,
  };
}

beforeEach(() => {
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Player · local file', () => {
  it('shows the unselected prompt with the host metadata', () => {
    renderPlayer();
    expect(screen.getByTestId('local-file-unselected')).toBeTruthy();
    expect(screen.getByText('LOCAL FILE · 未選択')).toBeTruthy();
    expect(screen.getByText('holiday.mp4')).toBeTruthy();
    expect(screen.getByText(/121 KB/)).toBeTruthy();
    expect(screen.getByTestId('local-file-input')).toBeTruthy();
  });

  it('passes the selected File to onSelectLocalFile', () => {
    const { onSelectLocalFile } = renderPlayer();
    const file = new File(['abc'], 'holiday.mp4', { type: 'video/mp4' });
    fireEvent.change(screen.getByTestId('local-file-input'), {
      target: { files: [file] },
    });
    expect(onSelectLocalFile).toHaveBeenCalledWith(file);
  });

  it('renders the video when a file is bound', () => {
    renderPlayer({ localFileUrl: 'blob:selected' });
    expect(screen.getByTestId('local-file-video')).toBeTruthy();
    expect(screen.queryByTestId('local-file-unselected')).toBeNull();
  });

  it('shows a duration-mismatch warning and confirms explicitly', () => {
    const match: LocalMatchResult = {
      status: 'duration-mismatch',
      canBind: true,
      requiresConfirmation: true,
      suppressEnd: true,
      message: '再生時間がホストと一致しません（ホスト 90.0s / 手元 60.0s）。',
    };
    const { onConfirmLocalFile, onCancelLocalFile } = renderPlayer({
      localPending: { meta: { ...META, durationSec: 60 }, match },
    });

    expect(screen.getByText(/再生時間がホストと一致しません/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'このファイルを使用' }));
    expect(onConfirmLocalFile).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: '選び直す' }));
    expect(onCancelLocalFile).toHaveBeenCalledTimes(1);
  });

  it('shows a selection error with a reselect affordance', () => {
    renderPlayer({
      localError: 'サイズが一致しません。別のファイルを選択してください。',
    });
    expect(screen.getByText(/サイズが一致しません/)).toBeTruthy();
    expect(screen.getByTestId('local-file-input')).toBeTruthy();
  });

  it('keeps the viewer shield over a local video', () => {
    renderPlayer({ canControl: false, localFileUrl: 'blob:selected' });
    expect(screen.getByTestId('viewer-input-shield')).toBeTruthy();
  });

  it('does not show the shield for a controller', () => {
    renderPlayer({ canControl: true, localFileUrl: 'blob:selected' });
    expect(screen.queryByTestId('viewer-input-shield')).toBeNull();
  });

  it('plays local audio for the host in audio-only drive mode', () => {
    const item = {
      id: 'local:local-abcdefgh',
      platform: 'local' as const,
      videoId: 'local-abcdefgh',
      addedBy: 'Host',
      local: META,
    };
    renderPlayer({
      isHost: true,
      driveMode: true,
      audioOnly: true,
      localFileUrl: 'blob:selected',
      queue: [item],
      currentId: item.id,
      titles: { [item.id]: 'holiday.mp4' },
    });
    expect(screen.getByTestId('local-file-video')).toBeTruthy();
    expect(screen.getByText('holiday.mp4')).toBeTruthy();
    expect(screen.getByText(/AUDIO ONLY/)).toBeTruthy();
  });

  it('shows the host transfer wait state instead of a file picker', () => {
    renderPlayer({
      localTransferEnabled: true,
      localTransfer: { phase: 'offering', videoId: 'local-abcdefgh', meta: META },
    });
    expect(screen.getByText('ホストからの受信待ち')).toBeTruthy();
    expect(screen.queryByTestId('local-file-input')).toBeNull();
    expect(screen.getByTestId('local-file-phase').textContent).toContain('受信待ち');
  });

  it('shows transfer progress while receiving', () => {
    const status: FileTransferStatus = {
      phase: 'transferring',
      videoId: 'local-abcdefgh',
      meta: META,
      receivedBytes: 512,
      totalBytes: 1024,
    };
    renderPlayer({ localTransferEnabled: true, localTransfer: status });
    expect(screen.getByTestId('local-transfer-progress')).toBeTruthy();
    expect(screen.getByText(/50%/)).toBeTruthy();
    expect(screen.queryByTestId('local-file-input')).toBeNull();
  });

  it('offers a retry after a verification failure', () => {
    const onRetryLocalTransfer = vi.fn();
    const status: FileTransferStatus = {
      phase: 'error',
      videoId: 'local-abcdefgh',
      meta: META,
      message: '照合できませんでした。',
      retryable: true,
      fallbackToManual: false,
    };
    renderPlayer({
      localTransferEnabled: true,
      localTransfer: status,
      onRetryLocalTransfer,
    });
    fireEvent.click(screen.getByRole('button', { name: '再試行' }));
    expect(onRetryLocalTransfer).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('local-file-input')).toBeNull();
  });

  it('falls back to the manual picker for an oversized file', () => {
    const status: FileTransferStatus = {
      phase: 'error',
      videoId: 'local-abcdefgh',
      meta: META,
      message: 'ファイルが大きすぎるため自動受信できません。',
      retryable: false,
      fallbackToManual: true,
    };
    renderPlayer({
      localTransferEnabled: true,
      localTransfer: status,
    });
    expect(screen.getByTestId('local-file-input')).toBeTruthy();
    expect(screen.getByText(/大きすぎる/)).toBeTruthy();
  });

  it('does not mount a local video for a drive-mode guest', () => {
    const item = {
      id: 'local:local-abcdefgh',
      platform: 'local' as const,
      videoId: 'local-abcdefgh',
      addedBy: 'Host',
      local: META,
    };
    renderPlayer({
      isHost: false,
      driveMode: true,
      audioOnly: true,
      localFileUrl: 'blob:selected',
      queue: [item],
      currentId: item.id,
      titles: { [item.id]: 'holiday.mp4' },
    });
    expect(screen.queryByTestId('local-file-video')).toBeNull();
    expect(screen.getByText(/DRIVE · AUDIO SYNC/)).toBeTruthy();
    expect(screen.getByText('holiday.mp4')).toBeTruthy();
  });
});
