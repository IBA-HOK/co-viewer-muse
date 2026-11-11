import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import VoiceChatPanel from './VoiceChatPanel';
import type { UseVoiceChatResult } from '../hooks/useVoiceChat';

const noop = vi.fn();

function voiceProps(overrides: Partial<UseVoiceChatResult> = {}): UseVoiceChatResult {
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
    hostStart: noop,
    hostStop: noop,
    guestJoin: noop,
    leave: noop,
    toggleMute: noop,
    toggleNoiseCancel: noop,
    setPeerVolume: noop,
    setMasterVolume: noop,
    getPeerVolume: () => 100,
    getMasterVolume: () => 100,
    ...overrides,
  };
}

describe('VoiceChatPanel starting state', () => {
  beforeEach(() => {
    localStorage.setItem('co-viewer:voice-expanded', '1');
  });

  it('disables START VC while starting', () => {
    render(
      <VoiceChatPanel
        {...voiceProps({ starting: true })}
        isHost
        vcActive={false}
        participants={[]}
      />
    );
    const button = screen.getByRole('button', { name: /START VC/ });
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  it('disables JOIN VC while starting', () => {
    render(
      <VoiceChatPanel
        {...voiceProps({ starting: true })}
        isHost={false}
        vcActive
        participants={[]}
      />
    );
    const button = screen.getByRole('button', { name: /JOIN VC/ });
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  it('keeps START VC enabled when not starting', () => {
    render(
      <VoiceChatPanel
        {...voiceProps()}
        isHost
        vcActive={false}
        participants={[]}
      />
    );
    const button = screen.getByRole('button', { name: /START VC/ });
    expect((button as HTMLButtonElement).disabled).toBe(false);
  });
});
