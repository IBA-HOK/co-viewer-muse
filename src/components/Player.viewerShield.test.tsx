/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { MutableRefObject } from 'react';
import { Player, type PlayerProps } from './Player';
import type { LocalPlayerEvent, PlayerController } from '../types';

function renderPlayer(overrides: Partial<PlayerProps> = {}) {
  const controllerRef = { current: null } as MutableRefObject<PlayerController | null>;
  const isRemoteSyncingRef = { current: false } as MutableRefObject<boolean>;
  const reportLocalEvent = vi.fn<(e: LocalPlayerEvent) => void>();
  const props: PlayerProps = {
    platform: 'youtube',
    videoId: 'abc123def45',
    canControl: false,
    isHost: false,
    controllerRef,
    isRemoteSyncingRef,
    reportLocalEvent,
    ...overrides,
  };
  return render(<Player {...props} />);
}

describe('Player · viewer input shield', () => {
  it('renders the shield over the iframe for a Viewer', () => {
    renderPlayer({ canControl: false });
    expect(screen.getByTestId('viewer-input-shield')).toBeTruthy();
  });

  it('does not render the shield when playback control is allowed', () => {
    renderPlayer({ canControl: true });
    expect(screen.queryByTestId('viewer-input-shield')).toBeNull();
  });
});
