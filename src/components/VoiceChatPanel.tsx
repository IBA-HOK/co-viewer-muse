import { useEffect, useState } from 'react';
import type { Participant } from '../types';
import type { UseVoiceChatResult } from '../hooks/useVoiceChat';

interface VoiceChatPanelProps extends UseVoiceChatResult {
  isHost: boolean;
  vcActive: boolean;
  participants: Participant[];
}

/**
 * Voice-chat control surface — NOTHING industrial, collapsed when IDLE.
 */
export default function VoiceChatPanel({
  isHost,
  vcActive,
  participants,
  inVc,
  muted,
  noiseCancel,
  noiseCancelAvailable,
  starting,
  error,
  remoteStreams,
  hostStart,
  hostStop,
  guestJoin,
  leave,
  toggleMute,
  toggleNoiseCancel,
}: VoiceChatPanelProps) {
  const nameOf = (id: string) =>
    participants.find((p) => p.peerId === id)?.name ?? id.slice(0, 6);

  const [expanded, setExpanded] = useState(() => {
    try {
      const ne = localStorage.getItem('co-viewer:voice-expanded');
      if (ne !== null) return ne === '1';
      const legacy = localStorage.getItem('co-viewer:peers-voice-expanded');
      if (legacy !== null) {
        const val = legacy === '1';
        localStorage.setItem('co-viewer:voice-expanded', val ? '1' : '0');
        try {
          localStorage.removeItem('co-viewer:peers-voice-expanded');
        } catch {}
        return val;
      }
      return false;
    } catch {
      return false;
    }
  });
  const collapsed = !expanded;
  const setCollapsed = (v: boolean | ((prev: boolean) => boolean)) => {
    const nextCollapsed = typeof v === 'function' ? (v as (p: boolean) => boolean)(collapsed) : v;
    setExpanded(!nextCollapsed);
  };
  useEffect(() => {
    try {
      localStorage.setItem('co-viewer:voice-expanded', expanded ? '1' : '0');
    } catch {}
  }, [expanded]);
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === 'co-viewer:voice-expanded') setExpanded(e.newValue === '1');
    };
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener('storage', onStorage);
    };
  }, []);
  useEffect(() => {
    if (vcActive) setExpanded(true);
  }, [vcActive]);

  const btnBase =
    'nothing-mono border px-3 py-1 text-[11px] tracking-widest active:scale-[0.98] transition-colors';
  const primary = 'bg-[var(--nothing-red)] border-[var(--nothing-red)] text-white hover:bg-[var(--nothing-red-hover)]';
  const danger = 'bg-transparent border-[var(--nothing-red)]/40 text-[var(--nothing-red)] hover:bg-[var(--nothing-red-dim)]';
  const neutral = 'bg-[var(--nothing-surface-raised)] border-[var(--nothing-border)] text-[var(--nothing-text)] hover:bg-[var(--nothing-surface-hover)]';

  const remoteEntries = Object.entries(remoteStreams);
  const isIdleCollapsed = !vcActive && collapsed;

  return (
    <div className="nothing-panel p-3 space-y-3">
      <button
        type="button"
        onClick={() => setCollapsed((v) => !v)}
        className="flex w-full items-center justify-between gap-2 text-left"
      >
        <div className="flex items-center gap-2">
          <h3 className="nothing-title text-sm tracking-[0.12em] text-[var(--nothing-text)]">VOICE</h3>
          {vcActive ? (
            <span className="nothing-mono inline-flex items-center gap-1.5 border border-[var(--nothing-red)]/30 bg-[var(--nothing-red-dim)] px-2 py-0.5 text-[10px] tracking-widest text-[var(--nothing-red)]">
              <span className="h-1.5 w-1.5 bg-[var(--nothing-red)] animate-pulse" /> LIVE {inVc ? `· ${remoteEntries.length + 1}` : ''}
            </span>
          ) : (
            <span className="nothing-mono border border-[var(--nothing-border)] bg-black px-2 py-0.5 text-[10px] tracking-widest text-[var(--nothing-text-dim)]">IDLE</span>
          )}
        </div>
        <span className="nothing-mono shrink-0 border border-[var(--nothing-border)] bg-black px-2 py-0.5 text-[11px] tracking-widest text-[var(--nothing-text-dim)]">
          {collapsed ? '+' : '—'}
        </span>
      </button>
      <div className="nothing-glyph opacity-30" aria-hidden />

      {isIdleCollapsed ? (
        <p className="nothing-mono text-[10px] tracking-widest text-[var(--nothing-text-faint)]">
          {'TAP TO EXPAND'}
        </p>
      ) : (
        <>
          {isHost ? (
            !vcActive ? (
              <button type="button" className={`${btnBase} ${primary}`} onClick={hostStart} disabled={starting}>
                ▶ START VC
              </button>
            ) : (
              <div className="space-y-2">
                <div className="flex flex-wrap gap-1.5">
                  <button type="button" className={`${btnBase} ${danger}`} onClick={hostStop}>
                    ■ STOP
                  </button>
                  {inVc && (
                    <button type="button" className={`${btnBase} ${neutral}`} onClick={toggleMute}>
                      {muted ? 'MIC · MUTED' : 'MIC · ON'}
                    </button>
                  )}
                  {inVc && noiseCancelAvailable && (
                    <button
                      type="button"
                      className={`${btnBase} ${neutral}`}
                      onClick={toggleNoiseCancel}
                    >
                      NR: {noiseCancel ? 'ON' : 'OFF'}
                    </button>
                  )}
                </div>
                {inVc && <ConnectedPeers entries={remoteEntries} nameOf={nameOf} />}
              </div>
            )
          ) : !vcActive ? (
            <p className="nothing-mono text-xs tracking-widest text-[var(--nothing-text-dim)]">
              WAITING FOR HOST
            </p>
          ) : !inVc ? (
            <button type="button" className={`${btnBase} ${primary}`} onClick={guestJoin} disabled={starting}>
              ▶ JOIN VC
            </button>
          ) : (
            <div className="space-y-2">
              <div className="flex flex-wrap gap-1.5">
                <button type="button" className={`${btnBase} ${danger}`} onClick={leave}>
                  ■ LEAVE
                </button>
                <button type="button" className={`${btnBase} ${neutral}`} onClick={toggleMute}>
                  {muted ? 'MIC · MUTED' : 'MIC · ON'}
                </button>
                {noiseCancelAvailable && (
                  <button
                    type="button"
                    className={`${btnBase} ${neutral}`}
                    onClick={toggleNoiseCancel}
                  >
                    NR: {noiseCancel ? 'ON' : 'OFF'}
                  </button>
                )}
              </div>
              <ConnectedPeers entries={remoteEntries} nameOf={nameOf} />
            </div>
          )}

          {starting && <p className="nothing-mono text-xs tracking-widest text-[var(--nothing-text-dim)]">CONNECTING…</p>}
          {error && <p className="nothing-mono border border-[var(--nothing-red)]/30 bg-[var(--nothing-red-dim)] px-2 py-1 text-xs text-[var(--nothing-red)]">{error}</p>}
        </>
      )}
    </div>
  );
}

function ConnectedPeers({
  entries,
  nameOf,
}: {
  entries: [string, MediaStream][];
  nameOf: (id: string) => string;
}) {
  if (entries.length === 0) {
    return <p className="nothing-mono text-xs tracking-widest text-[var(--nothing-text-dim)]">WAITING FOR PEERS…</p>;
  }
  return (
    <ul className="space-y-1 border border-[var(--nothing-border)] bg-black p-2">
      {entries.map(([peerId]) => (
        <li key={peerId} className="nothing-mono flex items-center gap-2 text-xs tracking-widest text-[var(--nothing-text-muted)]">
          <span className="h-1 w-1 bg-[var(--nothing-red)]" /> {nameOf(peerId)} · CONNECTED
        </li>
      ))}
    </ul>
  );
}
