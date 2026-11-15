import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import VolumeMixerPanel, { normalizeMixer } from './VolumeMixerPanel';
import type { UseVoiceChatResult } from '../hooks/useVoiceChat';

const MIXER_KEY = 'co-viewer:mixer';

function voiceChat(overrides: Partial<UseVoiceChatResult> = {}): UseVoiceChatResult {
  return {
    inVc: false,
    muted: false,
    noiseCancel: false,
    noiseCancelAvailable: false,
    starting: false,
    error: null,
    remoteStreams: {},
    audioLevels: {},
    localLevel: 0,
    hostStart: vi.fn(),
    hostStop: vi.fn(),
    guestJoin: vi.fn(),
    leave: vi.fn(),
    toggleMute: vi.fn(),
    toggleNoiseCancel: vi.fn(),
    setPeerVolume: vi.fn(),
    setMasterVolume: vi.fn(),
    getPeerVolume: () => 100,
    getMasterVolume: () => 100,
    ...overrides,
  };
}

function renderPanel(saved: string, vc = voiceChat()) {
  localStorage.setItem(MIXER_KEY, saved);
  const result = render(
    <VolumeMixerPanel
      controllerRef={{ current: null }}
      voiceChat={vc}
      participants={[]}
      currentPlatform={null}
    />
  );
  return { ...result, voiceChat: vc };
}

describe('normalizeMixer', () => {
  it('falls back to defaults for non-object JSON values', () => {
    for (const value of [null, 'oops', [], 42, true]) {
      expect(normalizeMixer(value)).toEqual({ yt: 100, nico: 100, vcMaster: 100, vcPeers: {} });
    }
  });

  it('clamps finite volume numbers and defaults missing or invalid ones', () => {
    expect(normalizeMixer({ yt: 999, nico: -5, vcMaster: Number.NaN })).toEqual({
      yt: 100,
      nico: 0,
      vcMaster: 100,
      vcPeers: {},
    });
  });

  it('keeps only finite numeric peer volumes, clamped to 0..100', () => {
    expect(normalizeMixer({
      vcPeers: { a: 30, b: 150, c: -10, d: '40', e: null, f: Number.POSITIVE_INFINITY },
    }).vcPeers).toEqual({ a: 30, b: 100, c: 0 });
  });

  it('ignores non-object vcPeers', () => {
    for (const vcPeers of ['x', [], null, 5]) {
      expect(normalizeMixer({ yt: 40, vcPeers }).vcPeers).toEqual({});
    }
  });
});

describe('VolumeMixerPanel saved mixer handling', () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('co-viewer:mixer-expanded', '1');
  });

  it.each([
    ['null', null, 100],
    ['a string', 'oops', 100],
    ['an array', [], 100],
    ['a string vcPeers', { vcPeers: 'x' }, 100],
    ['out-of-range values', { yt: 999, vcMaster: -5 }, 0],
  ])('renders without throwing when the saved value is %s', (_label, saved, expectedMaster) => {
    const vc = voiceChat();
    const { container } = renderPanel(JSON.stringify(saved), vc);

    expect(container.textContent).toContain('YT 100');
    expect(container.textContent).toContain('NICO 100');
    expect(vc.setMasterVolume).toHaveBeenCalledWith(expectedMaster);
  });

  it('loads valid values unchanged and applies them', () => {
    const vc = voiceChat();
    const { container } = renderPanel(
      JSON.stringify({ yt: 40, nico: 70, vcMaster: 60, vcPeers: { 'peer-a': 30 } }),
      vc
    );

    expect(container.textContent).toContain('YT 40 · NICO 70 · VC 60');
    expect(vc.setMasterVolume).toHaveBeenCalledWith(60);
    expect(vc.setPeerVolume).toHaveBeenCalledWith('peer-a', 30);
  });

  it('never passes non-numeric peer volumes to setPeerVolume', () => {
    const vc = voiceChat();
    renderPanel(
      JSON.stringify({ vcPeers: { a: '30', b: null, c: 150, d: -10, e: {} } }),
      vc
    );

    expect(vc.setPeerVolume).not.toHaveBeenCalledWith('a', expect.anything());
    expect(vc.setPeerVolume).not.toHaveBeenCalledWith('b', expect.anything());
    expect(vc.setPeerVolume).not.toHaveBeenCalledWith('e', expect.anything());
    for (const [, volume] of (vc.setPeerVolume as ReturnType<typeof vi.fn>).mock.calls) {
      expect(typeof volume).toBe('number');
      expect(volume).toBeGreaterThanOrEqual(0);
      expect(volume).toBeLessThanOrEqual(100);
    }
  });

  it('writes the normalized value back to localStorage', async () => {
    renderPanel(JSON.stringify({ yt: 999, vcMaster: -5, vcPeers: 'x' }));

    await waitFor(() => {
      expect(JSON.parse(localStorage.getItem(MIXER_KEY) ?? 'null')).toEqual({
        yt: 100,
        nico: 100,
        vcMaster: 0,
        vcPeers: {},
      });
    });
  });
});
