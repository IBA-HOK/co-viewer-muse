import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  fetchSearchResults,
  watchUrl,
  sortResults,
  type SearchResult,
  type SortKey,
  PAGE_SIZE,
} from './browserParser';
import { parseMediaInput } from '../types';

interface BrowserPanelProps {
  onAddToQueue: (url: string) => void;
  canQueue?: boolean;
}

const QUEUE_READ_ONLY_TITLE = 'キューに追加する権限がありません（VIEWER）';

const BOOKMARKS_KEY = 'co-viewer:browser-bookmarks';

function loadJSON<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

export default function BrowserPanel({ onAddToQueue, canQueue = true }: BrowserPanelProps) {
  const [expanded, setExpanded] = useState(() => {
    try {
      const v = localStorage.getItem('co-viewer:browser-expanded');
      return v ? v === '1' : false;
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem('co-viewer:browser-expanded', expanded ? '1' : '0');
    } catch {}
  }, [expanded]);
  const [query, setQuery] = useState('');
  const [engine, setEngine] = useState<'youtube' | 'nico'>('youtube');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [bookmarks, setBookmarks] = useState<string[]>(() =>
    loadJSON<string[]>(BOOKMARKS_KEY, [])
  );
  const [sort, setSort] = useState<SortKey>('relevance');
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [animStates, setAnimStates] = useState<Record<string, 'idle' | 'pending' | 'success'>>({});
  const keyFor = (r: SearchResult) => `${r.platform}:${r.id}`;
  const bookmarkKey = (b: string) => b;
  function triggerAnim(key: string) {
    setAnimStates((s) => ({ ...s, [key]: 'pending' }));
    window.setTimeout(() => setAnimStates((s) => ({ ...s, [key]: 'success' })), 220);
    window.setTimeout(
      () =>
        setAnimStates((s) => {
          const n = { ...s };
          delete n[key];
          return n;
        }),
      900 + 220
    );
  }

  const abortRef = useRef<AbortController | null>(null);
  const queryRef = useRef('');
  const loadingLockRef = useRef(false);
  const seenIdsRef = useRef<Set<string>>(new Set());
  const containerRef = useRef<HTMLUListElement | null>(null);
  const sentinelRef = useRef<HTMLLIElement | null>(null);
  const loadMoreAbortRef = useRef<AbortController | null>(null);
  const hasMoreRef = useRef(true);

  // Keep a ref in sync with hasMore so a stale IntersectionObserver callback
  // cannot trigger another request after we discover there are no more pages.
  const updateHasMore = useCallback((value: boolean) => {
    hasMoreRef.current = value;
    setHasMore(value);
  }, []);

  // Abort every in-flight request and reset the pagination/search state. Old
  // promise callbacks compare their controller against the refs above before
  // touching state, so a late response cannot revive a cancelled search.
  const cancelPendingSearches = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    loadMoreAbortRef.current?.abort();
    loadMoreAbortRef.current = null;
    queryRef.current = '';
    loadingLockRef.current = false;
    seenIdsRef.current.clear();
    setLoading(false);
    setLoadingMore(false);
    setPage(1);
    updateHasMore(false);
  }, [updateHasMore]);

  useEffect(() => {
    try {
      localStorage.setItem(BOOKMARKS_KEY, JSON.stringify(bookmarks));
    } catch {
    }
  }, [bookmarks]);

  useEffect(
    () => () => {
      abortRef.current?.abort();
      loadMoreAbortRef.current?.abort();
    },
    []
  );

  const runSearch = () => {
    const q = query.trim();
    if (!q) return;
    const parsed = parseMediaInput(q);
    if (parsed) {
      cancelPendingSearches();
      if (!canQueue) {
        setError(
          'キューに追加する権限がありません（VIEWER · QUEUE READ ONLY）。キーワード検索は利用できます。'
        );
        return;
      }
      onAddToQueue(q);
      setQuery('');
      setError(null);
      setResults([]);
      return;
    }
    cancelPendingSearches();
    queryRef.current = q;
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setLoading(true);
    setError(null);
    fetchSearchResults(engine, q, ctrl.signal, 1)
      .then((outcome) => {
        if (abortRef.current !== ctrl || ctrl.signal.aborted) return;
        if (outcome.ok) {
          seenIdsRef.current.clear();
          outcome.results.forEach((r) => seenIdsRef.current.add(`${r.platform}:${r.id}`));
          setResults(outcome.results);
          setPage(1);
          updateHasMore(outcome.hasMore ?? outcome.results.length >= PAGE_SIZE);
          setError(null);
        } else if (outcome.reason === 'network') {
          seenIdsRef.current.clear();
          setResults([]);
          updateHasMore(false);
          setError(
            '検索に失敗しました。ネットワークやプロキシ/CORS の制限で取得できませんでした。'
          );
        } else {
          seenIdsRef.current.clear();
          setResults([]);
          updateHasMore(false);
          setError('結果が見つかりませんでした');
        }
      })
      .catch(() => {
        if (abortRef.current === ctrl && !ctrl.signal.aborted) {
          setError('検索に失敗しました（プロキシがブロックされた可能性があります）');
        }
      })
      .finally(() => {
        if (abortRef.current === ctrl && !ctrl.signal.aborted) {
          setLoading(false);
        }
      });
  };

  const loadMore = useCallback(async () => {
    if (loading || loadingMore || !hasMore || !hasMoreRef.current || loadingLockRef.current) return;
    const q = queryRef.current.trim();
    if (!q) return;
    loadingLockRef.current = true;
    setLoadingMore(true);
    loadMoreAbortRef.current?.abort();
    const ctrl = new AbortController();
    loadMoreAbortRef.current = ctrl;
    const nextPage = page + 1;
    try {
      const outcome = await fetchSearchResults(engine, q, ctrl.signal, nextPage);
      if (loadMoreAbortRef.current !== ctrl || ctrl.signal.aborted) return;
      if (outcome.ok) {
        const deduped = outcome.results.filter((r) => !seenIdsRef.current.has(`${r.platform}:${r.id}`));
        if (deduped.length > 0) {
          deduped.forEach((r) => seenIdsRef.current.add(`${r.platform}:${r.id}`));
          setResults((prev) => [...prev, ...deduped]);
          setPage(nextPage);
          updateHasMore(outcome.hasMore ?? outcome.results.length >= PAGE_SIZE);
        } else {
          // A page with only already-seen results cannot make progress. Stop
          // pagination even if the source claims there are more pages.
          updateHasMore(false);
        }
      } else if (outcome.reason === 'empty') {
        updateHasMore(false);
      } else {
        setError('検索に失敗しました。ネットワークやプロキシ/CORS の制限で取得できませんでした。');
      }
    } catch {
      if (loadMoreAbortRef.current === ctrl && !ctrl.signal.aborted) {
        setError('検索に失敗しました（プロキシがブロックされた可能性があります）');
      }
    } finally {
      // A stale request must not clear the loading state or release the lock
      // that belongs to a newer loadMore (or search) request.
      if (loadMoreAbortRef.current === ctrl) {
        setLoadingMore(false);
        loadingLockRef.current = false;
      }
    }
  }, [engine, page, hasMore, loading, loadingMore, queryRef]);

  const switchEngine = (next: 'youtube' | 'nico') => {
    if (next === engine) return;
    cancelPendingSearches();
    // Drop results rendered by the previous engine as well: aborting in-flight
    // requests does not remove cards, errors, or queue animations already on
    // screen. Bookmarks, the query, sort order, and expansion are preserved.
    setResults([]);
    setError(null);
    setAnimStates({});
    setEngine(next);
  };

  useEffect(() => {
    const container = containerRef.current;
    const sentinel = sentinelRef.current;
    if (!container || !sentinel || !hasMore || error) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting || loading || loadingMore || !hasMore || loadingLockRef.current) return;
        loadMore();
      },
      { root: container, rootMargin: '300px 0px', threshold: 0 }
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMore, loading, loadingMore, error, loadMore]);

  const addToQueue = (r: SearchResult) => {
    if (!canQueue) return;
    onAddToQueue(watchUrl(r));
  };

  const openOriginal = (r: SearchResult) => {
    const w = window.open(watchUrl(r), '_blank', 'noopener');
    if (w) w.focus();
  };

  const addBookmark = (r: SearchResult) => {
    const u = watchUrl(r);
    setBookmarks((prev) => (prev.includes(u) ? prev : [u, ...prev].slice(0, 50)));
  };

  const removeBookmark = (u: string) => {
    setBookmarks((prev) => prev.filter((b) => b !== u));
  };

  const sorted = useMemo(() => sortResults(results, sort), [results, sort]);

  return (
    <div className="nothing-panel p-3 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h3 className="nothing-title text-sm tracking-[0.12em] text-[var(--nothing-text)]">BROWSER</h3>
          {!expanded && (results.length > 0 || bookmarks.length > 0) && (
            <span className="nothing-mono border border-[var(--nothing-border)] bg-black px-1.5 py-0.5 text-[10px] tracking-widest text-[var(--nothing-text-dim)]">
              {results.length > 0 ? `${results.length} HITS` : ''}{results.length > 0 && bookmarks.length > 0 ? ' · ' : ''}{bookmarks.length > 0 ? `${bookmarks.length} SAVED` : ''}
            </span>
          )}
          {!expanded && results.length === 0 && bookmarks.length === 0 && (
            <span className="nothing-mono text-[10px] tracking-widest text-[var(--nothing-text-faint)]">IDLE</span>
          )}
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
        <p className="nothing-mono text-[10px] tracking-widest text-[var(--nothing-text-faint)]">IDLE</p>
      )}

      {expanded && (
        <>
          <div className="space-y-2">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && runSearch()}
              placeholder="URL / ID or SEARCH KEYWORD"
              className="nothing-mono w-full border border-[var(--nothing-border)] bg-black px-3 py-2 text-sm text-[var(--nothing-text)] placeholder:text-[var(--nothing-text-faint)] outline-none focus:border-[var(--nothing-red)]"
            />
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex border border-[var(--nothing-border)]">
                <button
                  type="button"
                  onClick={() => switchEngine('youtube')}
                  className={`nothing-mono px-3 py-1 text-xs tracking-widest ${
                    engine === 'youtube'
                      ? 'bg-[var(--nothing-red)] text-white'
                      : 'bg-black text-[var(--nothing-text-dim)] hover:text-[var(--nothing-text)]'
                  }`}
                >
                  YOUTUBE
                </button>
                <button
                  type="button"
                  onClick={() => switchEngine('nico')}
                  className={`nothing-mono px-3 py-1 text-xs tracking-widest ${
                    engine === 'nico'
                      ? 'bg-[var(--nothing-red)] text-white'
                      : 'bg-black text-[var(--nothing-text-dim)] hover:text-[var(--nothing-text)]'
                  }`}
                >
                  NICO
                </button>
              </div>
              <button
                type="button"
                onClick={runSearch}
                disabled={loading}
                className="nothing-mono bg-[var(--nothing-surface-raised)] border border-[var(--nothing-border)] px-3 py-1 text-xs tracking-widest text-[var(--nothing-text)] hover:bg-[var(--nothing-surface-hover)] disabled:opacity-50"
              >
                {loading ? 'SEARCHING…' : 'LOAD / SEARCH'}
              </button>
              <select
                value={sort}
                onChange={(e) => setSort(e.target.value as SortKey)}
                className="nothing-mono border border-[var(--nothing-border)] bg-black px-2 py-1 text-xs tracking-widest text-[var(--nothing-text)] outline-none focus:border-[var(--nothing-red)]"
              >
                <option value="relevance">関連順</option>
                <option value="views">再生数順</option>
              </select>
            </div>
          </div>

          {!canQueue && (
            <p
              className="nothing-mono border border-[var(--nothing-border)] bg-[var(--nothing-surface-raised)] px-2 py-1 text-[10px] tracking-widest text-[var(--nothing-text-dim)]"
              title={QUEUE_READ_ONLY_TITLE}
            >
              VIEWER · QUEUE READ ONLY
            </p>
          )}

          {error && <p className="nothing-mono border border-[var(--nothing-red)]/30 bg-[var(--nothing-red-dim)] px-2 py-1 text-xs text-[var(--nothing-red)]">{error}</p>}

          {sorted.length > 0 && (
            <>
              <ul ref={containerRef} className="max-h-72 space-y-1.5 overflow-y-auto pr-1">
                {sorted.map((r) => (
                <li
                  key={`${r.platform}:${r.id}`}
                  className="flex gap-2 border border-[var(--nothing-border)] bg-black p-2 hover:border-[var(--nothing-border-strong)]"
                >
                  {r.thumbnail ? (
                    <img
                      src={r.thumbnail}
                      alt=""
                      loading="lazy"
                      className="h-14 w-24 shrink-0 border border-[var(--nothing-border)] bg-[var(--nothing-surface)] object-cover"
                    />
                  ) : (
                    <div className="h-14 w-24 shrink-0 border border-[var(--nothing-border)] bg-[var(--nothing-surface)]" />
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="nothing-mono truncate text-xs text-[var(--nothing-text)]" title={r.title}>
                      {r.title}
                    </p>
                    <div className="flex flex-wrap items-center gap-2">
                      {(r.views !== undefined || r.published !== undefined) && (
                        <p className="nothing-mono text-[10px] tracking-widest text-[var(--nothing-text-dim)]">
                          {r.views !== undefined && `${r.views.toLocaleString()} views`}
                          {r.views !== undefined && r.published !== undefined && ' · '}
                          {r.published !== undefined &&
                            new Date(r.published).toLocaleDateString()}
                        </p>
                      )}
                      <button
                        type="button"
                        onClick={() => openOriginal(r)}
                        className="nothing-mono text-[9px] tracking-widest text-[var(--nothing-text-dim)] hover:text-[var(--nothing-text)]"
                      >
                        ↗ OPEN
                      </button>
                    </div>
                    <div className="mt-1 flex flex-wrap gap-1">
                      <button
                        type="button"
                        disabled={!canQueue || animStates[keyFor(r)] === 'pending'}
                        aria-disabled={!canQueue ? true : undefined}
                        title={!canQueue ? QUEUE_READ_ONLY_TITLE : undefined}
                        onClick={() => {
                          if (!canQueue || animStates[keyFor(r)] === 'pending') return;
                          triggerAnim(keyFor(r));
                          addToQueue(r);
                        }}
                        className={`nothing-mono bg-[var(--nothing-red)] px-2 py-0.5 text-[10px] tracking-widest text-white hover:bg-[var(--nothing-red-hover)] nothing-enqueue transition-transform active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed ${animStates[keyFor(r)] === 'pending' ? 'nothing-enqueue--pending' : ''} ${animStates[keyFor(r)] === 'success' ? 'nothing-enqueue--success' : ''}`}
                      >
                        {animStates[keyFor(r)] === 'success' ? '✓ QUEUED' : '＋ QUEUE'}
                      </button>
                      <button
                        type="button"
                        onClick={() => addBookmark(r)}
                        aria-label="保存"
                        className="nothing-mono border border-[var(--nothing-border)] bg-black px-2 py-0.5 text-[10px] tracking-widest text-[var(--nothing-text-dim)] hover:text-[var(--nothing-text)]"
                      >
                        ☆ SAVE
                      </button>
                    </div>
                  </div>
                </li>
              ))}
                {hasMore && !error && (
                  <li ref={sentinelRef as unknown as React.RefObject<HTMLLIElement>} aria-hidden className="h-px list-none p-0 m-0" />
                )}
                {loadingMore && (
                  <>
                    <li className="flex gap-2 border border-[var(--nothing-border)] bg-black p-2 animate-pulse">
                      <div className="h-14 w-24 shrink-0 bg-[var(--nothing-surface)]" />
                      <div className="flex-1 space-y-2"><div className="h-3 w-3/4 bg-[var(--nothing-surface)]" /><div className="h-2 w-1/2 bg-[var(--nothing-surface)]" /></div>
                    </li>
                    <li className="flex justify-center py-2">
                      <span className="size-3 animate-spin border border-[var(--nothing-border-strong)] border-t-transparent rounded-full" />
                      <span className="nothing-mono ml-2 text-[10px] tracking-widest text-[var(--nothing-text-dim)]">LOADING…</span>
                    </li>
                  </>
                )}
              </ul>
              {!hasMore && results.length > 0 && (
                <p className="nothing-mono py-2 text-center text-[10px] tracking-widest text-[var(--nothing-text-faint)]">— END —</p>
              )}
            </>
          )}

          {bookmarks.length > 0 && (
            <div className="space-y-1">
              <p className="nothing-label">
                BOOKMARKS
              </p>
              <ul className="max-h-32 space-y-1 overflow-y-auto">
                {bookmarks.map((b) => (
                  <li
                    key={b}
                    className="flex items-center gap-2 border border-[var(--nothing-border)] bg-black px-2 py-1"
                  >
                    <button
                      type="button"
                      onClick={() => window.open(b, '_blank', 'noopener')?.focus()}
                      className="nothing-mono min-w-0 flex-1 truncate text-left text-xs text-[var(--nothing-text-muted)] hover:text-[var(--nothing-text)]"
                    >
                      {b}
                    </button>
                      <button
                        type="button"
                        disabled={!canQueue || animStates[bookmarkKey(b)] === 'pending'}
                        aria-disabled={!canQueue ? true : undefined}
                        title={!canQueue ? QUEUE_READ_ONLY_TITLE : undefined}
                        onClick={() => {
                          if (!canQueue || animStates[bookmarkKey(b)] === 'pending') return;
                          triggerAnim(bookmarkKey(b));
                          onAddToQueue(b);
                        }}
                        aria-label="キューに追加"
                        className={`nothing-mono shrink-0 bg-[var(--nothing-red)] px-2 py-0.5 text-xs text-white hover:bg-[var(--nothing-red-hover)] nothing-enqueue transition-transform active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed ${animStates[bookmarkKey(b)] === 'pending' ? 'nothing-enqueue--pending' : ''} ${animStates[bookmarkKey(b)] === 'success' ? 'nothing-enqueue--success' : ''}`}
                      >
                        {animStates[bookmarkKey(b)] === 'success' ? '✓' : '＋'}
                      </button>
                    <button
                      type="button"
                      onClick={() => removeBookmark(b)}
                      aria-label="削除"
                      className="nothing-mono shrink-0 border border-[var(--nothing-red)]/30 bg-[var(--nothing-red-dim)] px-2 py-0.5 text-xs text-[var(--nothing-red)] hover:bg-[var(--nothing-red)] hover:text-white"
                    >
                      ✕
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}


        </>
      )}
    </div>
  );
}
