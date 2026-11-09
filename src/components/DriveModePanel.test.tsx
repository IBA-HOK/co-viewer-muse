import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import DriveModePanel from './DriveModePanel';

const baseProps = {
  audioOnly: false,
  onToggleDrive: vi.fn(),
  onToggleAudioOnly: vi.fn(),
};

describe('DriveModePanel', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not crash or log errors for a guest when driveMode toggles false -> true -> false', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { rerender } = render(
      <DriveModePanel {...baseProps} isHost={false} driveMode={false} />,
    );

    expect(screen.queryByText('DRIVE MODE')).toBeNull();

    expect(() =>
      rerender(<DriveModePanel {...baseProps} isHost={false} driveMode />),
    ).not.toThrow();
    expect(screen.getByText('DRIVE MODE')).toBeTruthy();
    expect(screen.getByText('● ACTIVE')).toBeTruthy();

    expect(() =>
      rerender(<DriveModePanel {...baseProps} isHost={false} driveMode={false} />),
    ).not.toThrow();
    expect(screen.queryByText('DRIVE MODE')).toBeNull();

    expect(consoleError).not.toHaveBeenCalled();
  });

  it('keeps host display and localStorage persistence unchanged across OFF/ON/OFF', () => {
    const { rerender } = render(
      <DriveModePanel {...baseProps} isHost driveMode={false} />,
    );

    expect(screen.getByText('DRIVE MODE')).toBeTruthy();
    expect(screen.getByText('○ OFF')).toBeTruthy();
    expect(screen.queryByText('VIDEO')).toBeNull();
    expect(localStorage.getItem('co-viewer:drive-collapsed')).toBe('1');

    rerender(<DriveModePanel {...baseProps} isHost driveMode />);

    expect(screen.getByText('● ON')).toBeTruthy();
    expect(screen.getByText('VIDEO')).toBeTruthy();
    expect(screen.getByText('AUDIO ONLY')).toBeTruthy();
    expect(screen.getByText('DRIVE SYNC · ALL PEERS')).toBeTruthy();
    expect(localStorage.getItem('co-viewer:drive-collapsed')).toBe('0');

    rerender(<DriveModePanel {...baseProps} isHost driveMode={false} />);

    expect(screen.getByText('○ OFF')).toBeTruthy();
    expect(screen.getByText('DRIVE OFF · STANDARD SYNC')).toBeTruthy();
    expect(localStorage.getItem('co-viewer:drive-collapsed')).toBe('0');
  });

  it('forces the panel expanded when driveMode turns on even if it was stored collapsed', () => {
    localStorage.setItem('co-viewer:drive-collapsed', '1');

    render(<DriveModePanel {...baseProps} isHost={false} driveMode />);

    expect(screen.getByText('DRIVE MODE')).toBeTruthy();
    expect(screen.getByText('● ACTIVE')).toBeTruthy();
    expect(screen.getByText('DRIVE SYNC · ALL PEERS')).toBeTruthy();
    expect(localStorage.getItem('co-viewer:drive-collapsed')).toBe('0');
  });

  it('does not write localStorage while a guest panel is hidden', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');

    render(<DriveModePanel {...baseProps} isHost={false} driveMode={false} />);

    expect(screen.queryByText('DRIVE MODE')).toBeNull();
    expect(setItem).not.toHaveBeenCalled();
  });

  it('toggles the host collapsed state and persists it', () => {
    render(<DriveModePanel {...baseProps} isHost driveMode={false} />);

    expect(localStorage.getItem('co-viewer:drive-collapsed')).toBe('1');

    fireEvent.click(screen.getByText('+'));

    expect(screen.getByText('—')).toBeTruthy();
    expect(screen.getByText('DRIVE OFF · STANDARD SYNC')).toBeTruthy();
    expect(localStorage.getItem('co-viewer:drive-collapsed')).toBe('0');
  });
});
