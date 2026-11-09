import { useEffect, useState } from 'react';

interface DriveModePanelProps {
  isHost: boolean;
  driveMode: boolean;
  audioOnly: boolean;
  onToggleDrive: (enabled: boolean) => void;
  onToggleAudioOnly: (audioOnly: boolean) => void;
}

export default function DriveModePanel({
  isHost,
  driveMode,
  audioOnly,
  onToggleDrive,
  onToggleAudioOnly,
}: DriveModePanelProps) {
  if (!isHost && !driveMode) return null;

  const [collapsed, setCollapsed] = useState(() => {
    try {
      const v = localStorage.getItem('co-viewer:drive-collapsed');
      if (v !== null) return v === '1';
      return !driveMode;
    } catch {
      return !driveMode;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem('co-viewer:drive-collapsed', collapsed ? '1' : '0');
    } catch {}
  }, [collapsed]);
  useEffect(() => {
    if (driveMode) setCollapsed(false);
  }, [driveMode]);

  return (
    <div className="nothing-panel p-3 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => setCollapsed((v) => !v)}
          className="flex items-center gap-2 text-left"
        >
          <h3 className="nothing-title text-sm tracking-[0.12em] text-[var(--nothing-text)]">DRIVE MODE</h3>
          {!driveMode && collapsed && (
            <span className="nothing-mono text-[10px] tracking-widest text-[var(--nothing-text-faint)]">OFF · TAP TO CONFIG</span>
          )}
        </button>
        {isHost ? (
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => onToggleDrive(!driveMode)}
              className={`nothing-mono border px-3 py-1 text-[11px] tracking-widest active:scale-[0.98] ${
                driveMode
                  ? 'border-[var(--nothing-red)] bg-[var(--nothing-red)] text-white hover:bg-[var(--nothing-red-hover)]'
                  : 'border-[var(--nothing-border)] bg-black text-[var(--nothing-text-dim)] hover:border-[var(--nothing-border-strong)] hover:text-[var(--nothing-text)]'
              }`}
            >
              {driveMode ? '● ON' : '○ OFF'}
            </button>
            {!driveMode && (
              <button
                type="button"
                onClick={() => setCollapsed((v) => !v)}
                className="nothing-mono border border-[var(--nothing-border)] bg-black px-2 py-1 text-[11px] tracking-widest text-[var(--nothing-text-dim)] hover:text-[var(--nothing-text)]"
              >
                {collapsed ? '+' : '—'}
              </button>
            )}
          </div>
        ) : (
          <span className={`nothing-mono border px-2 py-0.5 text-[10px] tracking-widest ${driveMode ? 'border-amber-500/30 bg-amber-500/10 text-amber-300' : 'border-[var(--nothing-border)] bg-black text-[var(--nothing-text-dim)]'}`}>
            {driveMode ? '● ACTIVE' : '○ IDLE'}
          </span>
        )}
      </div>

      {!collapsed || driveMode ? (
        <>
          {isHost && driveMode && (
            <div className="flex gap-1.5">
              <button
                type="button"
                onClick={() => onToggleAudioOnly(false)}
                className={`nothing-mono flex-1 border px-3 py-2 text-[11px] tracking-widest ${
                  !audioOnly ? 'border-[var(--nothing-red)] bg-[var(--nothing-red)] text-white' : 'border-[var(--nothing-border)] bg-black text-[var(--nothing-text-muted)] hover:bg-[var(--nothing-surface-raised)]'
                }`}
              >
                VIDEO
              </button>
              <button
                type="button"
                onClick={() => onToggleAudioOnly(true)}
                className={`nothing-mono flex-1 border px-3 py-2 text-[11px] tracking-widest ${
                  audioOnly ? 'border-[var(--nothing-red)] bg-[var(--nothing-red)] text-white' : 'border-[var(--nothing-border)] bg-black text-[var(--nothing-text-muted)] hover:bg-[var(--nothing-surface-raised)]'
                }`}
              >
                AUDIO ONLY
              </button>
            </div>
          )}
          <p className="nothing-mono text-[10px] tracking-widest text-[var(--nothing-text-faint)]">
            {driveMode ? (audioOnly ? 'AUDIO SYNC · VIDEO HIDDEN ON HOST' : 'DRIVE SYNC · ALL PEERS') : 'DRIVE OFF · STANDARD SYNC'}
          </p>
        </>
      ) : null}
    </div>
  );
}
