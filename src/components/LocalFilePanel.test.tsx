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

beforeEach(() => {
  probe.mockReset();
  probe.mockResolvedValue(META);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('LocalFilePanel', () => {
  it('renders the upload button (no expandable panel / no NO UPLOAD claim)', () => {
    render(<LocalFilePanel canQueue onAddFile={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'UPLOAD' })).toBeTruthy();
    expect(screen.queryByText(/NO UPLOAD/)).toBeNull();
    expect(screen.queryByText(/送信されることはありません/)).toBeNull();
    expect(screen.queryByRole('button', { name: '+ OPEN' })).toBeNull();
  });

  it('disables upload for a Viewer', () => {
    render(<LocalFilePanel canQueue={false} onAddFile={vi.fn()} />);
    expect(
      (screen.getByTestId('local-file-panel-input') as HTMLInputElement).disabled
    ).toBe(true);
    expect(
      (screen.getByRole('button', { name: 'UPLOAD' }) as HTMLButtonElement)
        .disabled
    ).toBe(true);
  });

  it('probes the selected file and adds it immediately', async () => {
    const onAddFile = vi.fn();
    render(<LocalFilePanel canQueue onAddFile={onAddFile} />);

    const file = new File(['abcd'], 'clip.mp4', { type: 'video/mp4' });
    fireEvent.change(screen.getByTestId('local-file-panel-input'), {
      target: { files: [file] },
    });

    await waitFor(() => {
      expect(onAddFile).toHaveBeenCalledWith(file, META);
    });
    expect(probe).toHaveBeenCalledWith(file);
  });

  it('shows a probe error and does not add', async () => {
    probe.mockRejectedValue(new Error('この形式は再生できません'));
    const onAddFile = vi.fn();
    render(<LocalFilePanel canQueue onAddFile={onAddFile} />);

    fireEvent.change(screen.getByTestId('local-file-panel-input'), {
      target: {
        files: [new File(['x'], 'broken.mkv', { type: '' })],
      },
    });

    await waitFor(() => {
      expect(screen.getByText(/この形式は再生できません/)).toBeTruthy();
    });
    expect(onAddFile).not.toHaveBeenCalled();
  });

  it('uses canUpload to keep guests read-only in PeerJS mode', () => {
    render(
      <LocalFilePanel canQueue canUpload={false} onAddFile={vi.fn()} />
    );
    expect(
      (screen.getByTestId('local-file-panel-input') as HTMLInputElement).disabled
    ).toBe(true);
  });
});
