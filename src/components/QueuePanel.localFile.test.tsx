/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ComponentProps } from 'react';
import QueuePanel from './QueuePanel';
import type { QueueItem } from '../types';

const LOCAL_ITEM: QueueItem = {
  id: 'local:local-abcdefgh',
  platform: 'local',
  videoId: 'local-abcdefgh',
  addedBy: 'Host',
  local: {
    fileName: 'holiday.mp4',
    sizeBytes: 123456,
    durationSec: 90,
    mimeType: 'video/mp4',
  },
};

const YT_ITEM: QueueItem = {
  id: 'youtube:abc123def45',
  platform: 'youtube',
  videoId: 'abc123def45',
  addedBy: 'Host',
};

function renderQueue(overrides: Partial<ComponentProps<typeof QueuePanel>> = {}) {
  const onRemove = vi.fn();
  const onMove = vi.fn();
  const onPlay = vi.fn();
  const view = render(
    <QueuePanel
      queue={[LOCAL_ITEM, YT_ITEM]}
      currentId={LOCAL_ITEM.id}
      canControl
      titles={{}}
      onPlay={onPlay}
      onNext={vi.fn()}
      onPrev={vi.fn()}
      onRemove={onRemove}
      onMove={onMove}
      {...overrides}
    />
  );
  return { ...view, onRemove, onMove, onPlay };
}

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('QueuePanel · local files', () => {
  it('shows the LOCAL badge, file name, size and duration', () => {
    renderQueue();
    expect(screen.getByText('LOCAL')).toBeTruthy();
    expect(screen.getByText('holiday.mp4')).toBeTruthy();
    expect(screen.getByText(/121 KB · 1:30 · Host/)).toBeTruthy();
  });

  it('prefers the shared file name over the random video id', () => {
    renderQueue({
      titles: { [LOCAL_ITEM.id]: 'Overridden title' },
    });
    expect(screen.getByText('Overridden title')).toBeTruthy();
    expect(screen.queryByText('local-abcdefgh')).toBeNull();
  });

  it('shows the selection status badge when provided', () => {
    renderQueue({ localStatus: { [LOCAL_ITEM.id]: 'confirm' } });
    expect(screen.getByText('要確認')).toBeTruthy();
  });

  it('removes and reorders local items like any other queue item', () => {
    const { onRemove, onMove } = renderQueue();
    const removeButtons = screen.getAllByRole('button', { name: '削除' });
    fireEvent.click(removeButtons[0]);
    expect(onRemove).toHaveBeenCalledWith(LOCAL_ITEM.id);

    const downButtons = screen.getAllByRole('button', { name: '下へ移動' });
    fireEvent.click(downButtons[0]);
    expect(onMove).toHaveBeenCalledWith(0, 1);
  });

  it('plays a local item when its row is clicked', () => {
    const { onPlay } = renderQueue();
    fireEvent.click(screen.getByText('holiday.mp4'));
    expect(onPlay).toHaveBeenCalledWith(LOCAL_ITEM.id);
  });
});
