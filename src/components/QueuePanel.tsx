import { useCallback, useEffect, useRef, useState } from 'react';
import type { QueueItem } from '../types';

interface QueuePanelProps {
  queue: QueueItem[];
  currentId: string | null;
  canControl: boolean;
  titles: Record<string, string>;
  onPlay: (id: string) => void;
  onNext: () => void;
  onPrev: () => void;
  onRemove: (id: string) => void;
  onMove: (from: number, to: number) => void;
}

const PLATFORM_BADGE: Record<QueueItem['platform'], string> = {
  youtube: 'border-[var(--nothing-border)] bg-black text-[var(--nothing-text-muted)]',
  niconico: 'border-[var(--nothing-red)]/30 bg-[var(--nothing-red-dim)] text-[var(--nothing-red)]',
};

const PLATFORM_LABEL: Record<QueueItem['platform'], string> = {
  youtube: 'YT',
  niconico: 'NICO',
};

export default function QueuePanel({
  queue,
  currentId,
  canControl,
  titles,
  onPlay,
  onNext,
  onPrev,
  onRemove,
  onMove,
}: QueuePanelProps) {
  const currentIndex = queue.findIndex((q) => q.id === currentId);
  const disabled = !canControl;
  const needsCollapse = queue.length > 3;
  const [expanded, setExpanded] = useState(() => {
    try {
      return localStorage.getItem('co-viewer:queue-expanded') === '1';
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem('co-viewer:queue-expanded', expanded ? '1' : '0');
    } catch {}
  }, [expanded]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [topMore, setTopMore] = useState(0);
  const [bottomMore, setBottomMore] = useState(0);

  const updateIndicators = useCallback(() => {
    const el = scrollRef.current;
    if (!el || !needsCollapse) {
      setTopMore(0);
      setBottomMore(0);
      return;
    }
    if (expanded && el.scrollHeight <= el.clientHeight + 2) {
      setTopMore(0);
      setBottomMore(0);
      return;
    }
    const children = Array.from(el.children) as HTMLElement[];
    const contTop = el.getBoundingClientRect().top;
    const contBottom = el.getBoundingClientRect().bottom;
    let above = 0;
    let below = 0;
    children.forEach((child) => {
      const r = child.getBoundingClientRect();
      if (r.bottom < contTop + 2) above++;
      else if (r.top > contBottom - 2) below++;
    });
    setTopMore(above);
    setBottomMore(below);
  }, [needsCollapse, expanded]);

  useEffect(() => {
    updateIndicators();
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => updateIndicators();
    el.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    const ro = new ResizeObserver(onScroll);
    ro.observe(el);
    return () => {
      el.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      ro.disconnect();
    };
  }, [updateIndicators, queue]);

  useEffect(() => {
    const t = window.setTimeout(updateIndicators, 50);
    return () => window.clearTimeout(t);
  }, [queue, updateIndicators]);

    return (
    <div className="nothing-panel p-3 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => needsCollapse && setExpanded((v) => !v)}
          disabled={!needsCollapse}
          className={`flex items-center gap-2 text-left ${needsCollapse ? 'cursor-pointer hover:opacity-80' : 'cursor-default'}`}
        >
          <h3 className="nothing-title text-sm tracking-[0.12em] text-[var(--nothing-text)]">QUEUE</h3>
          <span className="nothing-mono text-[10px] tracking-widest text-[var(--nothing-text-dim)]">{queue.length} ITEMS</span>
          {needsCollapse && (
            <span className="nothing-mono ml-1 border border-[var(--nothing-border)] bg-black px-1.5 py-0.5 text-[10px] tracking-widest text-[var(--nothing-text-dim)]">
              {expanded ? '—' : '+'}
            </span>
          )}
        </button>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            disabled={disabled || currentIndex <= 0}
            onClick={onPrev}
            className="nothing-mono border border-[var(--nothing-border)] bg-[var(--nothing-surface-raised)] px-2.5 py-1 text-[11px] tracking-widest text-[var(--nothing-text)] hover:bg-[var(--nothing-surface-hover)] disabled:cursor-not-allowed disabled:opacity-30"
          >
            ‹ PREV
          </button>
          <button
            type="button"
            disabled={
              disabled || currentIndex < 0 || currentIndex >= queue.length - 1
            }
            onClick={onNext}
            className="nothing-mono border border-[var(--nothing-border)] bg-[var(--nothing-surface-raised)] px-2.5 py-1 text-[11px] tracking-widest text-[var(--nothing-text)] hover:bg-[var(--nothing-surface-hover)] disabled:cursor-not-allowed disabled:opacity-30"
          >
            NEXT ›
          </button>
        </div>
      </div>

      {queue.length > 0 && <div className="nothing-glyph opacity-30" aria-hidden />}

      {queue.length === 0 ? (
        <div className="py-6 text-center space-y-2">
          <div className="flex h-12 w-12 items-center justify-center border border-[var(--nothing-border)] bg-[var(--nothing-surface)] mx-auto"><span className="text-lg text-[var(--nothing-text-dim)]">◇</span></div>
          <p className="nothing-label">EMPTY · QUEUE</p>
        </div>
      ) : (
        <>
        <div className="relative">
          {topMore > 0 && (
            <div className="pointer-events-none absolute left-0 right-1 top-0 z-10 bg-gradient-to-b from-black via-black/80 to-transparent px-2 py-1 text-center">
              <span className="nothing-mono text-[10px] tracking-widest text-[var(--nothing-text-dim)]">↑ {topMore} more</span>
            </div>
          )}
          {bottomMore > 0 && (
            <div className="pointer-events-none absolute bottom-0 left-0 right-1 z-10 bg-gradient-to-t from-black via-black/80 to-transparent px-2 py-1 text-center">
              <span className="nothing-mono text-[10px] tracking-widest text-[var(--nothing-text-dim)]">↓ {bottomMore} more</span>
            </div>
          )}
        <div ref={scrollRef} className={`${expanded ? 'max-h-72' : 'max-h-36'} space-y-1.5 overflow-y-auto pr-1`}>
          {queue.map((item) => {
            const i = queue.findIndex((q) => q.id === item.id);
            const isCurrent = item.id === currentId;
            const isFirst = i === 0;
            const isLast = i === queue.length - 1;

            return (
              <div
                key={item.id}
                className={`flex items-center gap-2 border px-2.5 py-2 ${
                  isCurrent
                    ? 'border-[var(--nothing-red)] bg-[var(--nothing-red-dim)]'
                    : 'border-[var(--nothing-border)] bg-black hover:border-[var(--nothing-border-strong)]'
                }`}
              >
                <span
                  className={`nothing-mono shrink-0 border px-1.5 py-0.5 text-[10px] font-bold tracking-widest ${PLATFORM_BADGE[item.platform]}`}
                >
                  {PLATFORM_LABEL[item.platform]}
                </span>

                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => onPlay(item.id)}
                  className={`min-w-0 flex-1 text-left ${
                    disabled ? 'cursor-not-allowed opacity-50' : ''
                  }`}
                >
                  <div className="nothing-mono truncate text-xs text-[var(--nothing-text)]">
                    {titles[item.id] ?? item.videoId}
                  </div>
                  <div className="truncate text-[10px] tracking-widest text-[var(--nothing-text-faint)]">
                    {item.videoId} {item.addedBy ? `· ${item.addedBy}` : ''}
                  </div>
                </button>

                {isCurrent && (
                  <span className="nothing-mono shrink-0 bg-[var(--nothing-red)] px-1.5 py-0.5 text-[9px] font-bold tracking-[0.16em] text-white">
                    PLAYING
                  </span>
                )}

                {canControl && (
                  <div className="flex shrink-0 items-center gap-1">
                    <button
                      type="button"
                      disabled={isFirst}
                      onClick={() => onMove(i, i - 1)}
                      aria-label="上へ移動"
                      className="nothing-mono border border-[var(--nothing-border)] bg-[var(--nothing-surface-raised)] px-1.5 py-1 text-xs leading-none text-[var(--nothing-text)] hover:bg-[var(--nothing-surface-hover)] disabled:opacity-30"
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      disabled={isLast}
                      onClick={() => onMove(i, i + 1)}
                      aria-label="下へ移動"
                      className="nothing-mono border border-[var(--nothing-border)] bg-[var(--nothing-surface-raised)] px-1.5 py-1 text-xs leading-none text-[var(--nothing-text)] hover:bg-[var(--nothing-surface-hover)] disabled:opacity-30"
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      onClick={() => onRemove(item.id)}
                      aria-label="削除"
                      className="nothing-mono border border-[var(--nothing-red)]/30 bg-[var(--nothing-red-dim)] px-1.5 py-1 text-xs leading-none text-[var(--nothing-red)] hover:bg-[var(--nothing-red)] hover:text-white"
                    >
                      ✕
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
        </div>
        </>
      )}
    </div>
  );
}
