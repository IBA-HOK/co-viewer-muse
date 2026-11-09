export const PAGE_SIZE = 30;

export interface SearchResult {
  id: string;
  title: string;
  thumbnail: string;
  platform: 'youtube' | 'nico';
  views?: number;
  published?: number;
}

// ---------------------------------------------------------------------------
// YouTube (ytInitialData) — used as a fallback when the Invidious JSON API is
// unreachable. Brace-balanced scan that respects strings/escapes.
// ---------------------------------------------------------------------------
function extractYtInitialData(html: string): unknown {
  const marker = 'ytInitialData';
  let searchFrom = 0;
  while (true) {
    const idx = html.indexOf(marker, searchFrom);
    if (idx === -1) return null;
    let i = idx + marker.length;
    while (i < html.length && html[i] !== '{') i++;
    if (i >= html.length) {
      searchFrom = idx + marker.length;
      continue;
    }
    const start = i;
    let depth = 0;
    let inStr = false;
    let esc = false;
    let parsed: unknown | null = null;
    let found = false;
    for (; i < html.length; i++) {
      const c = html[i];
      if (esc) {
        esc = false;
        continue;
      }
      if (c === '\\') {
        esc = true;
        continue;
      }
      if (c === '"') {
        inStr = !inStr;
        continue;
      }
      if (inStr) continue;
      if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) {
          const slice = html.slice(start, i + 1);
          try {
            parsed = JSON.parse(slice);
            found = true;
          } catch {
            found = false;
          }
          break;
        }
      }
    }
    if (found) return parsed;
    searchFrom = idx + marker.length;
    if (i >= html.length) {
      continue;
    }
  }
}

function parseCount(text: string | undefined): number | undefined {
  if (!text) return undefined;
  const m = text.match(/[\d.,]+/);
  if (!m) return undefined;
  let n = parseFloat(m[0].replace(/,/g, ''));
  if (/K/i.test(text)) n *= 1e3;
  else if (/M/i.test(text)) n *= 1e6;
  else if (/B/i.test(text)) n *= 1e9;
  return Number.isFinite(n) ? n : undefined;
}

export function extractYouTubeResults(html: string): SearchResult[] {
  const data = extractYtInitialData(html);
  if (!data) return [];
  const results: SearchResult[] = [];
  const seen = new Set<string>();
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    const obj = node as Record<string, unknown>;
    const vr = obj.videoRenderer as
      | {
          videoId?: string;
          title?: { runs?: { text?: string }[]; simpleText?: string };
          thumbnail?: { thumbnails?: { url: string }[] };
          viewCountText?: { simpleText?: string };
          shortViewCountText?: { simpleText?: string };
        }
      | undefined;
    if (vr && typeof vr.videoId === 'string') {
      const id = vr.videoId;
      if (seen.has(id)) return;
      seen.add(id);
      const runs = vr.title?.runs ?? [];
      const title =
        runs.map((r) => r.text ?? '').join('') || vr.title?.simpleText || '';
      const thumb = vr.thumbnail?.thumbnails?.[0]?.url ?? '';
      const views = parseCount(
        vr.viewCountText?.simpleText ?? vr.shortViewCountText?.simpleText
      );
      results.push({ id, title: String(title), thumbnail: thumb, platform: 'youtube', views });
      return;
    }
    const lm = obj.lockupViewModel as
      | {
          contentId?: string;
          videoId?: string;
          id?: string;
          title?: { content?: string; simpleText?: string };
          metadata?: {
            lockupMetadataViewModel?: {
              title?: { content?: string; simpleText?: string };
              metadata?: { contentImageSecondaryStats?: { content?: string } };
            };
            title?: { content?: string; simpleText?: string };
          };
          contentImage?: {
            thumbnailViewModel?: { image?: { sources?: { url: string }[] } };
          };
          thumbnail?: { sources?: { url: string }[]; thumbnails?: { url: string }[] };
          viewCountText?: { simpleText?: string };
        }
      | undefined;
    if (lm && typeof lm === 'object') {
      const raw = lm as Record<string, unknown>;
      const id =
        (typeof raw.contentId === 'string' && raw.contentId) ||
        (typeof raw.videoId === 'string' && raw.videoId) ||
        (typeof raw.id === 'string' && raw.id) ||
        '';
      if (typeof id === 'string' && id) {
        if (seen.has(id)) return;
        seen.add(id);
        const title =
          lm.metadata?.lockupMetadataViewModel?.title?.content ??
          lm.metadata?.title?.content ??
          lm.title?.content ??
          lm.title?.simpleText ??
          '';
        const thumb =
          lm.contentImage?.thumbnailViewModel?.image?.sources?.[0]?.url ??
          lm.thumbnail?.sources?.[0]?.url ??
          lm.thumbnail?.thumbnails?.[0]?.url ??
          '';
        const viewsText =
          lm.metadata?.lockupMetadataViewModel?.metadata?.contentImageSecondaryStats?.content ??
          lm.viewCountText?.simpleText;
        const views = parseCount(viewsText);
        results.push({ id, title: String(title), thumbnail: String(thumb), platform: 'youtube', views });
        return;
      }
    }
    for (const k of Object.keys(obj)) walk(obj[k]);
  };
  walk(data);
  return results.slice(0, PAGE_SIZE);
}

// ---------------------------------------------------------------------------
// Nico — scrapes the JSON embedded in the search page HTML.
// ---------------------------------------------------------------------------
export function extractNicoResults(html: string): SearchResult[] {
  const u = html
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
  const re =
    /(sm|nm|so)(\d+)"\s*,\s*"contentType"\s*:\s*"[^"]*"\s*,\s*"title"\s*:\s*"((?:\\.|[^"\\])*)"[\s\S]*?"thumbnail"\s*:\s*\{\s*"url"\s*:\s*"([^"]*)"/g;
  const results: SearchResult[] = [];
  const seen = new Set<string>();
  let mm: RegExpExecArray | null;
  while ((mm = re.exec(u)) !== null) {
    const id = mm[1] + mm[2];
    if (seen.has(id)) continue;
    seen.add(id);
    let title = '';
    try {
      title = JSON.parse('"' + mm[3] + '"');
    } catch {
      title = mm[3];
    }
    const thumbnail = mm[4].replace(/\\\//g, '/');
    results.push({ id, title: String(title), thumbnail, platform: 'nico' });
  }
  return results.slice(0, PAGE_SIZE);
}

// ---------------------------------------------------------------------------
// Nico snapshot search API v2 — keyless, small JSON payload (no HTML scrape).
// Fetched through a CORS proxy; the proxy supplies its own User-Agent, which
// the API requires, so no backend/header-injecting proxy is needed.
// https://snapshot.search.nicovideo.jp/api/v2/snapshot/video/contents/search
// ---------------------------------------------------------------------------
export function extractNicoSnapshotResults(json: unknown): SearchResult[] {
  if (!json || typeof json !== 'object') return [];
  const data = (json as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];
  const results: SearchResult[] = [];
  const seen = new Set<string>();
  for (const item of data) {
    if (!item || typeof item !== 'object') continue;
    const v = item as Record<string, unknown>;
    const id = typeof v.contentId === 'string' ? v.contentId : '';
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const title = typeof v.title === 'string' ? v.title : '';
    const thumb =
      typeof v.thumbnailUrl === 'string' && v.thumbnailUrl
        ? v.thumbnailUrl
        : `https://tn.smilevideo.jp/smile?i=${id}`;
    const views = typeof v.viewCounter === 'number' ? v.viewCounter : undefined;
    let published: number | undefined;
    if (typeof v.startTime === 'string') {
      const t = new Date(v.startTime).getTime();
      if (Number.isFinite(t)) published = t;
    }
    results.push({ id, title: String(title), thumbnail: thumb, platform: 'nico', views, published });
  }
  return results.slice(0, PAGE_SIZE);
}

export function nicoSnapshotUrl(query: string, page = 1): string {
  const offset = (page - 1) * PAGE_SIZE;
  const params = new URLSearchParams({
    q: query,
    targets: 'title,description,tags',
    fields: 'contentId,title,thumbnailUrl,viewCounter,startTime',
    _sort: '-viewCounter',
    _offset: String(offset),
    _limit: String(PAGE_SIZE),
    _context: 'Co-Viewer',
  });
  return `https://snapshot.search.nicovideo.jp/api/v2/snapshot/video/contents/search?${params.toString()}`;
}

// ---------------------------------------------------------------------------
// Invidious — keyless, CORS-enabled JSON API. Fetched DIRECTLY (no proxy),
// so it is far more reliable than scraping YouTube's multi-MB HTML.
// ---------------------------------------------------------------------------
export function extractInvidiousResults(json: unknown): SearchResult[] {
  if (!Array.isArray(json)) return [];
  const results: SearchResult[] = [];
  const seen = new Set<string>();
  for (const item of json) {
    if (!item || typeof item !== 'object') continue;
    const v = item as Record<string, unknown>;
    if (v.type !== 'video') continue;
    const id = typeof v.videoId === 'string' ? v.videoId : '';
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const title = typeof v.title === 'string' ? v.title : '';
    const views = typeof v.viewCount === 'number' ? v.viewCount : undefined;
    let published: number | undefined;
    if (typeof v.published === 'number') {
      // Invidious returns unix seconds; normalize to milliseconds.
      published = v.published > 1e12 ? v.published : v.published * 1000;
    }
    results.push({
      id,
      title: String(title),
      // Build the thumbnail ourselves — avoids depending on instance URLs.
      thumbnail: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
      platform: 'youtube',
      views,
      published,
    });
  }
  return results.slice(0, PAGE_SIZE);
}

export function watchUrl(r: SearchResult): string {
  return r.platform === 'youtube'
    ? `https://www.youtube.com/watch?v=${r.id}`
    : `https://www.nicovideo.jp/watch/${r.id}`;
}

export function embedUrl(r: SearchResult): string {
  return r.platform === 'youtube'
    ? `https://www.youtube.com/embed/${r.id}`
    : `https://embed.nicovideo.jp/watch/${r.id}`;
}

export type SortKey = 'relevance' | 'views' | 'date' | 'title';

// Client-side ordering of already-fetched results (no re-fetch / no API sort).
// 'relevance' returns the input as-is (API order); the rest clone before sorting
// so the caller's array is never mutated.
export function sortResults(results: SearchResult[], sort: SortKey): SearchResult[] {
  if (sort === 'relevance') return results;
  const copy = results.slice();
  switch (sort) {
    case 'views':
      return copy.sort((a, b) => (b.views ?? -1) - (a.views ?? -1));
    case 'date':
      return copy.sort((a, b) => (b.published ?? -1) - (a.published ?? -1));
    case 'title':
      return copy.sort((a, b) => a.title.localeCompare(b.title));
    default:
      return copy;
  }
}

// Invidious instances, fetched directly first then via proxy race.
// 2026-09-01 external finding: official Invidious instances are cors:false
// so direct fetch may fail due to CORS, but the proxy race in fetchYouTube
// covers it. Previously-used mirrors (fdn.fr, puffyan.us, etc.) are now
// dead; we pin 3 known alive mirrors.
const INVIDIOUS_INSTANCES = [
  'https://invidious.flokinet.to',
  'https://invidious.nerdvpn.de',
  'https://yt.chocolatemoo53.com',
];

// CORS proxies used only as fallbacks (Nico snapshot API + YouTube HTML
// scrape). First is optimistic; second is the only stable free fallback;
// third replaces dead proxies that now require API key. Kept as secondary
// fallbacks for rate-limit resilience.
const PROXIES: ((u: string) => string)[] = [
  (u) => `https://proxy.cors.sh/${u}`,
  (u) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
  (u) => `https://cors.eu.org/${encodeURIComponent(u)}`,
];

// AbortController that fires on either the caller's abort signal OR a fixed
// timeout, so a single slow/dead source can't stall the whole search.
function raceSignal(outer?: AbortSignal, timeoutMs = 4000): AbortController {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const onOuterAbort = () => ctrl.abort();
  if (outer) {
    if (outer.aborted) ctrl.abort();
    else outer.addEventListener('abort', onOuterAbort, { once: true });
  }
  ctrl.signal.addEventListener(
    'abort',
    () => {
      clearTimeout(timer);
      if (outer) outer.removeEventListener('abort', onOuterAbort);
    },
    { once: true }
  );
  return ctrl;
}

// Resolve with the first fulfilling promise (Promise.any without requiring the
// ES2021 lib). A late rejection from a losing race is always handled here, so
// no unhandled-rejection warnings.
function firstFulfilled<T>(promises: Promise<T>[]): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const total = promises.length;
    if (total === 0) {
      reject(new Error('no sources'));
      return;
    }
    let pending = total;
    for (const p of promises) {
      Promise.resolve(p).then(
        (v) => resolve(v),
        () => {
          pending--;
          if (pending === 0) reject(new Error('all sources failed'));
        }
      );
    }
  });
}

// Cache successful YouTube results per query so repeat searches are instant
// and we don't re-race instances. TTL-bounded so it can't go permanently stale.
interface CachedResults {
  time: number;
  results: SearchResult[];
}
const YT_CACHE = new Map<string, CachedResults>();
const NICO_CACHE = new Map<string, CachedResults>();
const CACHE_TTL_MS = 5 * 60 * 1000;

function cacheKey(query: string, page: number): string {
  return `${query}::p${page}`;
}

function getCached(query: string, page = 1): SearchResult[] | null {
  const key = cacheKey(query, page);
  const hit = YT_CACHE.get(key);
  if (!hit) return null;
  if (Date.now() - hit.time > CACHE_TTL_MS) {
    YT_CACHE.delete(key);
    return null;
  }
  return hit.results;
}

function setCached(query: string, page: number, results: SearchResult[]): void {
  YT_CACHE.set(cacheKey(query, page), { time: Date.now(), results });
}

// Same cache for Nico snapshot results (separate map so platform keys don't
// collide and the TTL logic stays independent).
function getNicoCached(query: string, page = 1): SearchResult[] | null {
  const key = cacheKey(query, page);
  const hit = NICO_CACHE.get(key);
  if (!hit) return null;
  if (Date.now() - hit.time > CACHE_TTL_MS) {
    NICO_CACHE.delete(key);
    return null;
  }
  return hit.results;
}

function setNicoCached(query: string, page: number, results: SearchResult[]): void {
  NICO_CACHE.set(cacheKey(query, page), { time: Date.now(), results });
}

async function fetchText(
  target: string,
  signal?: AbortSignal,
  timeoutMs = 6000
): Promise<string | null> {
  const attempts = PROXIES.map((make) => {
    const ctrl = raceSignal(signal, timeoutMs);
    return fetch(make(target), { signal: ctrl.signal })
      .then((res) => {
        if (!res.ok) throw new Error('bad status');
        return res.text();
      })
      .then((text) => {
        if (!text || text.length < 100) throw new Error('empty');
        return text;
      });
  });
  try {
    return await firstFulfilled(attempts);
  } catch {
    return null;
  }
}

export type SearchOutcome =
  | { ok: true; results: SearchResult[]; hasMore: boolean }
  | { ok: false; reason: 'empty' | 'network' };

async function fetchYouTube(query: string, signal?: AbortSignal, page = 1): Promise<SearchOutcome> {
  const cached = getCached(query, page);
  if (cached) return { ok: true, results: cached, hasMore: cached.length >= PAGE_SIZE };

  const q = encodeURIComponent(query);
  // Race every Invidious instance in parallel; take the first that returns
  // usable results. Each attempt has its own 4s timeout, so a slow/dead
  // instance is dropped instead of blocking the search.
  const attempts = INVIDIOUS_INSTANCES.map((inst) => {
    const ctrl = raceSignal(signal, 4000);
    return fetch(`${inst}/api/v1/search?q=${q}&type=video&page=${page}`, { signal: ctrl.signal })
      .then((res) => {
        if (!res.ok) throw new Error('bad status');
        return res.json();
      })
      .then((json) => {
        const results = extractInvidiousResults(json);
        if (results.length === 0) throw new Error('empty');
        return results;
      });
  });

  try {
    const results = await firstFulfilled(attempts);
    setCached(query, page, results);
    return { ok: true, results, hasMore: results.length >= PAGE_SIZE };
  } catch {
    // all Invidious instances failed/timed out — try a proxy fallback below
  }

  // Fallback 1: direct Invidious instances may be down or CORS-blocked.
  // Retry through every proxy in parallel; take the first that returns
  // usable results (mirrors the Nico PROXIES.map pattern and keeps the
  // proxy[0]=429 / proxy[1]=200 case resilient, S1 RED).
  try {
    const attempts2 = PROXIES.map((make) => {
      const ctrl = raceSignal(signal, 5000);
      return fetch(make(`${INVIDIOUS_INSTANCES[0]}/api/v1/search?q=${q}&type=video&page=${page}`), { signal: ctrl.signal })
        .then((res) => {
          if (!res.ok) throw new Error('bad status');
          return res.json();
        })
        .then((json) => {
          const results = extractInvidiousResults(json);
          if (results.length === 0) throw new Error('empty');
          return results;
        });
    });
    const results = await firstFulfilled(attempts2);
    setCached(query, page, results);
    return { ok: true, results, hasMore: results.length >= PAGE_SIZE };
  } catch {
    // fall through to HTML scrape
  }

  // Fallback 2: scrape YouTube's search HTML via proxies.
  const text = await fetchText(
    `https://www.youtube.com/results?search_query=${q}`,
    signal
  );
  if (text) {
    const results = extractYouTubeResults(text);
    if (results.length > 0) {
      setCached(query, page, results);
      return { ok: true, results, hasMore: results.length >= PAGE_SIZE };
    }
    return { ok: false, reason: 'empty' };
  }
  return { ok: false, reason: 'network' };
}

async function fetchNico(query: string, signal?: AbortSignal, page = 1): Promise<SearchOutcome> {
  const cached = getNicoCached(query, page);
  if (cached) return { ok: true, results: cached, hasMore: cached.length >= PAGE_SIZE };

  const url = nicoSnapshotUrl(query, page);
  // Race every proxy in parallel; take the first that returns usable JSON.
  // Each attempt has its own 4s timeout, so a slow/dead proxy is dropped
  // instead of blocking the search (mirrors the YouTube Invidious path).
  const attempts = PROXIES.map((make) => {
    const ctrl = raceSignal(signal, 4000);
    return fetch(make(url), { signal: ctrl.signal })
      .then((res) => {
        if (!res.ok) throw new Error('bad status');
        return res.json();
      })
      .then((json) => {
        const results = extractNicoSnapshotResults(json);
        if (results.length === 0) throw new Error('empty');
        return results;
      });
  });

  try {
    const results = await firstFulfilled(attempts);
    setNicoCached(query, page, results);
    return { ok: true, results, hasMore: results.length >= PAGE_SIZE };
  } catch {
    // all proxies failed/timed out — fall through to HTML scrape
  }

  // Fallback: scrape Nico's search HTML via proxies.
  const text = await fetchText(
    `https://www.nicovideo.jp/search/${encodeURIComponent(query)}`,
    signal
  );
  if (text) {
    const results = extractNicoResults(text);
    if (results.length > 0) {
      setNicoCached(query, page, results);
      return { ok: true, results, hasMore: results.length >= PAGE_SIZE };
    }
    return { ok: false, reason: 'empty' };
  }
  return { ok: false, reason: 'network' };
}

export async function fetchSearchResults(
  platform: 'youtube' | 'nico',
  query: string,
  signal?: AbortSignal,
  page = 1
): Promise<SearchOutcome> {
  return platform === 'youtube'
    ? fetchYouTube(query, signal, page)
    : fetchNico(query, signal, page);
}
