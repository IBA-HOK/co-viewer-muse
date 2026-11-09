import { useEffect, useState } from 'react';
import type { Participant, Role } from '../types';

interface ParticipantListProps {
  participants: Participant[];
  myId: string | null;
  isHost: boolean;
  onDelegate: (peerId: string, role: Role) => void;
  vcActive?: boolean;
  audioLevels?: Record<string, number>;
  localLevel?: number;
}

const ROLE_BADGE: Record<Role, string> = {
  Host: 'border-[var(--nothing-red)] bg-[var(--nothing-red)] text-white',
  Controller: 'border-[var(--nothing-text-dim)] bg-[var(--nothing-surface-raised)] text-[var(--nothing-text)]',
  Viewer: 'border-[var(--nothing-border)] bg-black text-[var(--nothing-text-dim)]',
};

const ROLE_SHORT: Record<Role, string> = {
  Host: 'HOST',
  Controller: 'cont.',
  Viewer: 'view.',
};

export default function ParticipantList({
  participants,
  myId,
  isHost,
  onDelegate,
  vcActive = false,
  audioLevels,
  localLevel = 0,
}: ParticipantListProps) {
  const [expanded, setExpanded] = useState(() => {
    try {
      const ne = localStorage.getItem('co-viewer:peers-expanded');
      if (ne !== null) return ne === '1';
      const legacy = localStorage.getItem('co-viewer:peers-voice-expanded');
      if (legacy !== null) {
        const val = legacy === '1';
        localStorage.setItem('co-viewer:peers-expanded', val ? '1' : '0');
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
  useEffect(() => {
    try {
      localStorage.setItem('co-viewer:peers-expanded', expanded ? '1' : '0');
    } catch {}
  }, [expanded]);
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === 'co-viewer:peers-expanded') setExpanded(e.newValue === '1');
    };
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  const dedupedParticipants = (() => {
    const seen = new Set<string>();
    return participants.filter((p) => {
      if (seen.has(p.peerId)) return false;
      seen.add(p.peerId);
      return true;
    });
  })();

  if (dedupedParticipants.length === 0) {
    return (
      <div className="nothing-panel p-3">
        <div className="flex items-center justify-between">
          <h3 className="nothing-title text-sm tracking-[0.12em] text-[var(--nothing-text)]">PEERS</h3>
          <span className="nothing-mono text-[10px] tracking-widest text-[var(--nothing-text-dim)]">0</span>
        </div>
        <div className="nothing-glyph my-2 opacity-30" aria-hidden />
        <p className="nothing-mono text-xs tracking-widest text-[var(--nothing-text-dim)]">NO PEERS · WAITING</p>
      </div>
    );
  }

  const summary = (() => {
    const counts: Record<string, number> = {};
    dedupedParticipants.forEach((p) => {
      counts[p.role] = (counts[p.role] ?? 0) + 1;
    });
    return Object.entries(counts).map(([role, n]) => `${(ROLE_SHORT[role as Role] ?? role).toUpperCase()} ${n}`).join(' · ');
  })();

  return (
    <div className="nothing-panel p-3">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center justify-between gap-2 text-left"
      >
        <div className="flex items-center gap-2">
          <h3 className="nothing-title text-sm tracking-[0.12em] text-[var(--nothing-text)]">
            PEERS <span className="nothing-mono text-[10px] tracking-widest text-[var(--nothing-text-dim)]">({dedupedParticipants.length})</span>
          </h3>
          {!expanded && (
            <span className="nothing-mono hidden sm:inline text-[10px] tracking-widest text-[var(--nothing-text-faint)]">
              {summary}
            </span>
          )}
        </div>
        <span className="nothing-mono shrink-0 border border-[var(--nothing-border)] bg-black px-2 py-0.5 text-[11px] tracking-widest text-[var(--nothing-text-dim)]">
          {expanded ? '—' : '+'}
        </span>
      </button>
      <div className="nothing-glyph my-2 opacity-30" aria-hidden />
      {!expanded && (
        <p className="nothing-mono text-[10px] tracking-widest text-[var(--nothing-text-faint)]">TAP TO EXPAND</p>
      )}

      {expanded && (
        <ul className="space-y-2">
          {dedupedParticipants.map((p) => {
            const isSelf = p.peerId === myId;
            const isParticipantHost = p.isHost;
            const showControls = isHost && !isParticipantHost && !isSelf;
            const level = isSelf
              ? localLevel
              : (audioLevels ? audioLevels[p.peerId] ?? 0 : 0);

            return (
              <li
                key={p.peerId}
                className="flex flex-wrap items-center gap-2 border border-[var(--nothing-border)] bg-black px-2.5 py-2"
              >
                <span className="nothing-mono min-w-0 flex-1 truncate text-xs tracking-wide text-[var(--nothing-text)]">
                  {p.name}
                  {isSelf && (
                    <span className="ml-1 text-[10px] tracking-widest text-[var(--nothing-text-dim)]">· YOU</span>
                  )}
                </span>

                {vcActive && (
                  <div
                    className="h-1 w-16 overflow-hidden border border-[var(--nothing-border)] bg-[var(--nothing-surface-raised)]"
                    title="音量"
                  >
                    <div
                      className="h-full bg-[var(--nothing-red)] transition-[width] duration-100"
                      style={{ width: `${Math.round(level * 100)}%` }}
                    />
                  </div>
                )}

                <span
                  className={`nothing-mono shrink-0 border px-1.5 py-0.5 text-[10px] font-medium tracking-widest ${ROLE_BADGE[p.role]}`}
                >
                  {ROLE_SHORT[p.role]}
                </span>

                {showControls && (
                  <div className="flex w-full gap-1.5 pt-1">
                    <button
                      type="button"
                      disabled={p.role === 'Controller'}
                      onClick={() => onDelegate(p.peerId, 'Controller')}
                      className="nothing-mono flex-1 border border-[var(--nothing-text-dim)] bg-[var(--nothing-surface-raised)] px-2 py-1 text-[10px] tracking-widest text-[var(--nothing-text)] hover:bg-[var(--nothing-surface-hover)] disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      → cont.
                    </button>
                    <button
                      type="button"
                      disabled={p.role === 'Viewer'}
                      onClick={() => onDelegate(p.peerId, 'Viewer')}
                      className="nothing-mono flex-1 border border-[var(--nothing-border)] bg-black px-2 py-1 text-[10px] tracking-widest text-[var(--nothing-text-dim)] hover:border-[var(--nothing-border-strong)] hover:text-[var(--nothing-text)] disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      → view.
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
