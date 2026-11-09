/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useRoomSync } from './useRoomSync';

// helper per spec — future implementation should export normalizeName from useRoomSync
const normalizeName = (s: string): string => s.trim().toLowerCase();

function createHostHook() {
  const broadcast = vi.fn();
  const sendTo = vi.fn();
  const { result } = renderHook(() =>
    useRoomSync({
      isHost: true,
      myId: 'host-1',
      connected: true,
      myName: 'Host',
      broadcast,
      sendTo,
    })
  );
  return { result, broadcast, sendTo };
}

describe('dedupe repro — peerId-only dedupe bug', () => {
  it('same nickname rejoin does not inflate count', () => {
    const { result, broadcast } = createHostHook();

    // initial host seeded via useEffect
    // first join Alice as peer-abc
    act(() => {
      result.current.onGuestJoined('peer-abc', 'Alice');
    });
    // second join same normalized name different peerId (simulates reload with new PeerJS ID, same nickname from localStorage)
    act(() => {
      result.current.onGuestJoined('peer-xyz', 'Alice');
    });

    // demonstrate normalizeName helper works as spec
    expect(normalizeName(' Alice ')).toBe(normalizeName('alice'));
    expect(normalizeName('Alice')).toBe('alice');

    const participants = result.current.participants;
    // expected after fix: host + one deduped Alice = 2
    // buggy current: host + peer-abc Alice + peer-xyz Alice = 3
    expect(participants.length).toBe(2);
    // only one guest entry for that normalized name
    const guests = participants.filter((p) => !p.isHost);
    expect(guests.length).toBe(1);
    // ensure the surviving entry is the latest peerId
    expect(guests[0].peerId).toBe('peer-xyz');
    // also expect broadcast not inflated — should have collapsed earlier event
    // (optional but documents inflation)
    void broadcast;
  });

  it('controller role survives rejoin via name', () => {
    const { result } = createHostHook();

    // first join Alice as Controller
    act(() => {
      result.current.onGuestJoined('peer-abc', 'Alice');
    });
    act(() => {
      result.current.delegateController('peer-abc', 'Controller');
    });

    // verify peer-abc is Controller
    let alice = result.current.participants.find((p) => p.peerId === 'peer-abc');
    expect(alice?.role).toBe('Controller');

    // simulate reload: new peerId same nickname
    act(() => {
      result.current.onGuestJoined('peer-xyz', 'Alice');
    });

    const newAlice = result.current.participants.find((p) => p.peerId === 'peer-xyz');
    // expected after fix: role remembered via normalized name → Controller
    // buggy current: controllerMemory keyed by peerId only → Viewer
    expect(newAlice).toBeDefined();
    expect(newAlice?.role).toBe('Controller');

    // old peerId should have been evicted (name-based dedupe)
    expect(result.current.participants.find((p) => p.peerId === 'peer-abc')).toBeUndefined();
    expect(normalizeName('Alice')).toBe(normalizeName('  ALICE  '));
  });

  it('peer.on connection double-fire idempotent', () => {
    const { result, broadcast } = createHostHook();

    // clear initial host seeding broadcasts
    broadcast.mockClear();

    // simulate peerjs 'connection' double-fire for same peerId
    act(() => {
      result.current.onGuestJoined('peer-abc', 'Alice');
    });
    act(() => {
      result.current.onGuestJoined('peer-abc', 'Alice');
    });

    const participants = result.current.participants;
    const aliceEntries = participants.filter((p) => p.peerId === 'peer-abc');
    // only one entry for that peerId
    expect(aliceEntries.length).toBe(1);
    // host + one guest = 2 total
    expect(participants.length).toBe(2);

    // double-fire should not broadcast twice — currently does
    // filter broadcasts for PARTICIPANTS to be precise
    const participantBroadcasts = broadcast.mock.calls.filter(
      (c) => (c[0] as { type: string })?.type === 'PARTICIPANTS'
    );
    expect(participantBroadcasts.length).toBe(1);
  });
});
