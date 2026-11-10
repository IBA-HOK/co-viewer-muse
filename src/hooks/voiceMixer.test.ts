import { describe, expect, it } from 'vitest';
import { resolvePeerGain, toGainValue } from './voiceMixer';

describe('resolvePeerGain', () => {
  it('defaults to 100% when only vcMaster is saved', () => {
    expect(resolvePeerGain({ vcMaster: 40 }, 'peer-a')).toBe(1);
  });

  it('uses the peer volume when saved and does not reapply vcMaster', () => {
    const peerGain = resolvePeerGain({ vcMaster: 40, vcPeers: { 'peer-a': 25 } }, 'peer-a');
    const masterGain = toGainValue(40);

    expect(peerGain).toBe(0.25);
    expect(masterGain).toBe(0.4);
    expect(peerGain * masterGain).toBeCloseTo(0.1);
  });

  it('defaults to 100% for peers missing from vcPeers', () => {
    expect(resolvePeerGain({ vcPeers: { 'peer-a': 25 } }, 'peer-b')).toBe(1);
  });

  it('clamps saved peer volumes to 0..100', () => {
    expect(resolvePeerGain({ vcPeers: { 'peer-a': -10 } }, 'peer-a')).toBe(0);
    expect(resolvePeerGain({ vcPeers: { 'peer-a': 150 } }, 'peer-a')).toBe(1);
  });
});
