import { useRef, useState } from 'react';
import { probeLocalMedia } from '../localFile';
import type { LocalMediaMeta } from '../types';

interface LocalFilePanelProps {
  /** Queue permission (host / controller / drive mode). */
  canQueue: boolean;
  /**
   * Whether this participant may upload. In PeerJS mode only the host is the
   * uploader; MQTT keeps the existing "everyone picks their own copy" flow and
   * leaves this at `canQueue` (the default).
   */
  canUpload?: boolean;
  /** Called after the picked file has been probed. */
  onAddFile: (file: File, meta: LocalMediaMeta) => void;
}

/**
 * The former "expand panel" button is now the upload button: no panel
 * expansion, no format lecture, and no false "no upload" claim.
 */
export default function LocalFilePanel({
  canQueue,
  canUpload,
  onAddFile,
}: LocalFilePanelProps) {
  const uploadEnabled = canUpload ?? canQueue;
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSelect = async (picked: File | null) => {
    if (!picked || !uploadEnabled) return;
    setBusy(true);
    setError(null);
    try {
      const probed = await probeLocalMedia(picked);
      onAddFile(picked, probed);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'このファイルを読み込めませんでした'
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="nothing-panel flex flex-wrap items-center justify-between gap-2 p-3">
      <div className="flex items-center gap-2">
        <h3 className="nothing-title text-sm tracking-[0.12em] text-[var(--nothing-text)]">
          LOCAL FILE
        </h3>
        {busy && (
          <span className="nothing-mono text-[10px] tracking-widest text-[var(--nothing-text-dim)]">
            読み取り中…
          </span>
        )}
      </div>
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        disabled={!uploadEnabled || busy}
        data-testid="local-file-panel-upload"
        className="nothing-mono border border-[var(--nothing-border)] bg-black px-3 py-1 text-[11px] tracking-widest text-[var(--nothing-text-dim)] hover:border-[var(--nothing-border-strong)] hover:text-[var(--nothing-text)] disabled:cursor-not-allowed disabled:opacity-40"
      >
        UPLOAD
      </button>
      <input
        ref={inputRef}
        type="file"
        accept="video/*,audio/*"
        disabled={!uploadEnabled || busy}
        data-testid="local-file-panel-input"
        className="sr-only"
        onChange={(e) => {
          void handleSelect(e.target.files?.[0] ?? null);
          e.currentTarget.value = '';
        }}
      />
      {error && (
        <p className="nothing-mono w-full border border-[var(--nothing-red)]/30 bg-[var(--nothing-red-dim)] px-2 py-1 text-xs text-[var(--nothing-red)]">
          ⚠ {error}
        </p>
      )}
    </div>
  );
}
