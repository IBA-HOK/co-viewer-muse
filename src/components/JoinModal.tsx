interface JoinModalProps {
  open: boolean;
  roomId: string | null;
  onConfirm: () => void;
}

export default function JoinModal({ open, roomId, onConfirm }: JoinModalProps) {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center p-3 pointer-events-none">
      <div className="absolute inset-0 bg-black/30" aria-hidden="true" />
      <div className="pointer-events-auto relative w-full max-w-[640px] nothing-panel p-6 text-center translate-y-0 transition-transform">
        <div className="nothing-glyph mb-4" aria-hidden />
        <p className="nothing-label">ROOM · JOIN</p>
        <h2 className="nothing-title mt-2 text-lg tracking-[0.12em] text-[var(--nothing-text)]">JOIN ROOM</h2>

        <p className="nothing-mono mt-3 text-xs leading-relaxed tracking-wide text-[var(--nothing-text-muted)]">
          再生を有効化するためにタップしてください。<br />
          <span className="text-[11px] tracking-widest text-[var(--nothing-text-dim)]">TAP TO ENABLE AUTOPLAY · USER GESTURE REQUIRED</span>
        </p>

        {roomId && (
          <p className="nothing-mono mt-3 border border-[var(--nothing-border)] bg-black px-2 py-1 text-[10px] tracking-widest text-[var(--nothing-text-dim)]">ROOM {roomId}</p>
        )}

        <button
          type="button"
          onClick={onConfirm}
          className="nothing-mono mt-4 w-full bg-[var(--nothing-red)] px-6 py-3 text-xs font-medium tracking-[0.16em] text-white hover:bg-[var(--nothing-red-hover)] active:scale-[0.98]"
        >
          ▶ JOIN & ENABLE PLAYBACK
        </button>
        <p className="nothing-mono mt-2 text-[10px] tracking-widest text-[var(--nothing-text-faint)]">NOTHING · TRANSPARENT · GLYPH</p>
      </div>
    </div>
  );
}
