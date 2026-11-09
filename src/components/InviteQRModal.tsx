import { useEffect } from 'react';
import { QRCodeSVG } from 'qrcode.react';

interface InviteQRModalProps {
  open: boolean;
  inviteUrl: string;
  copied: boolean;
  onClose: () => void;
  onCopy: () => void;
}

export default function InviteQRModal({ open, inviteUrl, copied, onClose, onCopy }: InviteQRModalProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button
        type="button"
        aria-label="QRモーダルを閉じる"
        onClick={onClose}
        className="absolute inset-0 bg-black/60 backdrop-blur-[2px]"
      />
      <div className="relative w-full max-w-[360px] nothing-panel p-4 space-y-3">
        <div className="nothing-glyph" aria-hidden />
        <div className="flex items-center justify-between gap-2">
          <h3 className="nothing-title text-sm tracking-[0.12em] text-[var(--nothing-text)]">INVITE · QR</h3>
          <button
            type="button"
            onClick={onClose}
            className="nothing-mono border border-[var(--nothing-border)] bg-black px-2 py-1 text-[11px] tracking-widest text-[var(--nothing-text-dim)] hover:text-[var(--nothing-text)]"
          >
            ✕ CLOSE
          </button>
        </div>
        <p className="nothing-mono text-[10px] tracking-widest text-[var(--nothing-text-faint)]">SCAN TO JOIN · P2P ROOM</p>

        <div className="flex justify-center bg-white p-3">
          <QRCodeSVG
            value={inviteUrl}
            size={220}
            level="M"
            bgColor="white"
            fgColor="black"
            marginSize={1}
            title="招待QRコード"
          />
        </div>

        <div className="space-y-1.5">
          <p className="nothing-mono break-all border border-[var(--nothing-border)] bg-black px-2.5 py-2 text-[11px] leading-relaxed text-[var(--nothing-text-muted)]">
            {inviteUrl}
          </p>
          <div className="flex gap-1.5">
            <button
              type="button"
              onClick={onCopy}
              className={`nothing-mono flex-1 border px-3 py-2 text-[11px] tracking-widest active:scale-[0.98] ${
                copied
                  ? 'border-[var(--nothing-red)] bg-[var(--nothing-red)] text-white'
                  : 'border-[var(--nothing-border)] bg-[var(--nothing-surface-raised)] text-[var(--nothing-text)] hover:bg-[var(--nothing-surface-hover)]'
              }`}
            >
              {copied ? 'COPIED' : 'COPY LINK'}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="nothing-mono flex-1 border border-[var(--nothing-border)] bg-black px-3 py-2 text-[11px] tracking-widest text-[var(--nothing-text-dim)] hover:text-[var(--nothing-text)]"
            >
              CLOSE
            </button>
          </div>
          <p className="nothing-mono text-center text-[10px] tracking-widest text-[var(--nothing-text-faint)]">QRは招待URLをエンコードしています</p>
        </div>
      </div>
    </div>
  );
}
