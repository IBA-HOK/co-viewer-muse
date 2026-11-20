import { useState } from 'react';
import {
  formatBytes,
  formatDuration,
  mediaTypeWarning,
  probeLocalMedia,
} from '../localFile';
import type { LocalMediaMeta } from '../types';

interface LocalFilePanelProps {
  canQueue: boolean;
  /** Called after the user confirms the probed metadata. */
  onAddFile: (file: File, meta: LocalMediaMeta) => void;
}

const QUEUE_READ_ONLY_TITLE = 'キューに追加する権限がありません（VIEWER）';

export default function LocalFilePanel({ canQueue, onAddFile }: LocalFilePanelProps) {
  const [expanded, setExpanded] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [meta, setMeta] = useState<LocalMediaMeta | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reset = () => {
    setFile(null);
    setMeta(null);
    setWarning(null);
    setError(null);
    setBusy(false);
  };

  const handleSelect = async (picked: File | null) => {
    if (!picked) return;
    setFile(picked);
    setMeta(null);
    setError(null);
    setWarning(mediaTypeWarning(picked.type));
    setBusy(true);
    try {
      const probed = await probeLocalMedia(picked);
      setMeta(probed);
    } catch (err) {
      setFile(null);
      setError(
        err instanceof Error ? err.message : 'このファイルを読み込めませんでした'
      );
    } finally {
      setBusy(false);
    }
  };

  const handleAdd = () => {
    if (!canQueue || !file || !meta) return;
    onAddFile(file, meta);
    reset();
  };

  return (
    <div className="nothing-panel space-y-3 p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h3 className="nothing-title text-sm tracking-[0.12em] text-[var(--nothing-text)]">
            LOCAL FILE
          </h3>
          <span className="nothing-mono text-[10px] tracking-widest text-[var(--nothing-text-faint)]">
            NO UPLOAD
          </span>
        </div>
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="nothing-mono border border-[var(--nothing-border)] bg-black px-3 py-1 text-[11px] tracking-widest text-[var(--nothing-text-dim)] hover:border-[var(--nothing-border-strong)] hover:text-[var(--nothing-text)]"
        >
          {expanded ? '— CLOSE' : '+ OPEN'}
        </button>
      </div>
      <div className="nothing-glyph opacity-30" aria-hidden />

      {!expanded && (
        <p className="nothing-mono text-[10px] tracking-widest text-[var(--nothing-text-faint)]">
          音声・動画ファイルをルームで同時再生
        </p>
      )}

      {expanded && (
        <div className="space-y-2">
          <p className="text-[11px] leading-relaxed text-[var(--nothing-text-muted)]">
            ファイルの実体は送信されません。メタ情報（ファイル名・サイズ・再生時間・形式）だけを共有し、
            各参加者が手元の同じファイルを選択して同時再生します。
          </p>

          {!canQueue && (
            <p
              className="nothing-mono border border-[var(--nothing-border)] bg-[var(--nothing-surface-raised)] px-2 py-1 text-[10px] tracking-widest text-[var(--nothing-text-dim)]"
              title={QUEUE_READ_ONLY_TITLE}
            >
              VIEWER · QUEUE READ ONLY
            </p>
          )}

          <label
            className={`nothing-mono inline-flex items-center gap-1.5 border px-3 py-1 text-xs tracking-widest ${
              canQueue
                ? 'cursor-pointer border-[var(--nothing-border)] bg-[var(--nothing-surface-raised)] text-[var(--nothing-text)] hover:bg-[var(--nothing-surface-hover)]'
                : 'cursor-not-allowed border-[var(--nothing-border)] bg-black text-[var(--nothing-text-faint)]'
            }`}
          >
            ファイルを選択
            <input
              type="file"
              accept="video/*,audio/*"
              disabled={!canQueue || busy}
              data-testid="local-file-panel-input"
              className="sr-only"
              onChange={(e) => {
                void handleSelect(e.target.files?.[0] ?? null);
                e.currentTarget.value = '';
              }}
            />
          </label>

          <p className="nothing-mono text-[10px] leading-relaxed text-[var(--nothing-text-faint)]">
            目安: .mp4 / .m4v / .webm / .ogv / .mp3 / .m4a / .aac / .wav / .ogg / .flac。
            accept は選択ダイアログのヒントです。MKV / AVI / HEVC / AC-3 等や DRM 付きファイルは
            保証外で、トランスコードは行いません。ブラウザがネイティブに再生できる形式のみ利用できます。
          </p>

          {busy && (
            <p className="nothing-mono text-[10px] tracking-widest text-[var(--nothing-text-dim)]">
              メタ情報を読み取り中…
            </p>
          )}

          {error && (
            <p className="nothing-mono border border-[var(--nothing-red)]/30 bg-[var(--nothing-red-dim)] px-2 py-1 text-xs text-[var(--nothing-red)]">
              ⚠ {error}
            </p>
          )}

          {warning && !error && (
            <p className="nothing-mono border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-[11px] text-amber-300">
              ⚠ {warning}
            </p>
          )}

          {file && meta && !error && (
            <div className="space-y-2 border border-[var(--nothing-border)] bg-black p-2">
              <p className="nothing-mono truncate text-xs text-[var(--nothing-text)]">
                {meta.fileName}
              </p>
              <p className="nothing-mono text-[10px] tracking-widest text-[var(--nothing-text-dim)]">
                {formatBytes(meta.sizeBytes)} · {formatDuration(meta.durationSec)} ·{' '}
                {meta.mimeType || 'unknown type'}
              </p>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={handleAdd}
                  disabled={!canQueue}
                  className="nothing-mono bg-[var(--nothing-red)] px-3 py-1 text-xs tracking-widest text-white hover:bg-[var(--nothing-red-hover)] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  キューに追加
                </button>
                <button
                  type="button"
                  onClick={reset}
                  className="nothing-mono border border-[var(--nothing-border)] bg-black px-3 py-1 text-xs tracking-widest text-[var(--nothing-text-dim)] hover:text-[var(--nothing-text)]"
                >
                  キャンセル
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
