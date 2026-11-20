/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import LocalFilePanel from './LocalFilePanel';
import { probeLocalMedia } from '../localFile';
import type { LocalMediaMeta } from '../types';

vi.mock('../localFile', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../localFile')>();
  return {
    ...actual,
    probeLocalMedia: vi.fn(),
  };
});

const META: LocalMediaMeta = {
  fileName: 'clip.mp4',
  sizeBytes: 2048,
  durationSec: 65,
  mimeType: 'video/mp4',
};

const probe = vi.mocked(probeLocalMedia);

function openPanel() {
  fireEvent.click(screen.getByRole('button', { name: '+ OPEN' }));
}

beforeEach(() => {
  probe.mockReset();
  probe.mockResolvedValue(META);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('LocalFilePanel', () => {
  it('disables selection for a Viewer and explains read-only mode', () => {
    render(<LocalFilePanel canQueue={false} onAddFile={vi.fn()} />);
    openPanel();

    expect(
      (screen.getByTestId('local-file-panel-input') as HTMLInputElement).disabled
    ).toBe(true);
    expect(screen.getByText(/VIEWER · QUEUE READ ONLY/)).toBeTruthy();
  });

  it('probes a selected file, shows metadata, and adds it after confirmation', async () => {
    const onAddFile = vi.fn();
    render(<LocalFilePanel canQueue onAddFile={onAddFile} />);
    openPanel();

    const file = new File(['abcd'], 'clip.mp4', { type: 'video/mp4' });
    fireEvent.change(screen.getByTestId('local-file-panel-input'), {
      target: { files: [file] },
    });

    await waitFor(() => {
      expect(screen.getByText('clip.mp4')).toBeTruthy();
    });
    expect(probe).toHaveBeenCalledWith(file);
    expect(screen.getByText(/2\.0 KB/)).toBeTruthy();
    expect(screen.getByText(/1:05/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'キューに追加' }));
    expect(onAddFile).toHaveBeenCalledWith(file, META);
    // The confirmation form resets after adding.
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'キューに追加' })).toBeNull();
    });
  });

  it('shows a probe error and does not offer to add', async () => {
    probe.mockRejectedValue(new Error('この形式は再生できません'));
    const onAddFile = vi.fn();
    render(<LocalFilePanel canQueue onAddFile={onAddFile} />);
    openPanel();

    fireEvent.change(screen.getByTestId('local-file-panel-input'), {
      target: {
        files: [new File(['x'], 'broken.mkv', { type: '' })],
      },
    });

    await waitFor(() => {
      expect(screen.getByText(/この形式は再生できません/)).toBeTruthy();
    });
    expect(screen.queryByRole('button', { name: 'キューに追加' })).toBeNull();
    expect(onAddFile).not.toHaveBeenCalled();
  });

  it('mentions the supported formats and the no-transcode limitation', () => {
    render(<LocalFilePanel canQueue onAddFile={vi.fn()} />);
    openPanel();
    expect(screen.getByText(/トランスコードは行いません/)).toBeTruthy();
    expect(screen.getByText(/\.mp4/)).toBeTruthy();
  });
});
