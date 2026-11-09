/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { MutableRefObject } from 'react';
import { Player, type PlayerProps } from './Player';
import type { LocalPlayerEvent, PlayerController } from '../types';

function renderPlayer(overrides: Partial<PlayerProps> = {}) {
  const controllerRef = { current: null } as MutableRefObject<PlayerController | null>;
  const isRemoteSyncingRef = { current: false } as MutableRefObject<boolean>;
  const reportLocalEvent = vi.fn<(e: LocalPlayerEvent) => void>();
  const onResync = vi.fn();
  const props: PlayerProps = {
    platform: 'youtube',
    videoId: 'abc123def45',
    canControl: false,
    isHost: false,
    controllerRef,
    isRemoteSyncingRef,
    reportLocalEvent,
    syncFallbackLevel: 1,
    onResync,
    ...overrides,
  };
  const view = render(<Player {...props} />);
  return { ...view, props, onResync };
}

describe('Player · low-performance fallback notice', () => {
  it('shows the notice and calls onResync when fallback is active', () => {
    const { onResync } = renderPlayer();
    expect(screen.getByText(/自動追従を保留中/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '最新の再生位置に再同期' }));
    expect(onResync).toHaveBeenCalledTimes(1);
  });

  it('shows an in-progress state while a manual resync is pending', () => {
    const { rerender, props } = renderPlayer({ syncFallbackLevel: 0, syncResyncing: true });
    expect(screen.getByText(/再同期中/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '最新の再生位置に再同期' }));

    rerender(<Player {...props} syncFallbackLevel={0} syncResyncing={false} />);
    expect(screen.queryByText(/再同期中/)).toBeNull();
  });

  it('surfaces a tolerated adaptive lag with a resync action', () => {
    const { onResync } = renderPlayer({
      syncFallbackLevel: 0,
      syncResyncing: false,
      syncToleranceLag: 8.2,
    });
    expect(screen.getByText(/ズレ 8\.2s を許容中/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '最新の再生位置に再同期' }));
    expect(onResync).toHaveBeenCalledTimes(1);
  });

  it('hides the notice when the fallback is cleared', () => {
    const { rerender, props } = renderPlayer();
    expect(screen.getByText(/自動追従を保留中/)).toBeTruthy();

    rerender(<Player {...props} syncFallbackLevel={0} />);
    expect(screen.queryByText(/自動追従を保留中/)).toBeNull();
    expect(
      screen.queryByRole('button', { name: '最新の再生位置に再同期' })
    ).toBeNull();
  });
});
