import type { Platform } from './types';

const PROXIES: ((u: string) => string)[] = [
  (u) => `https://proxy.cors.sh/${u}`,
  (u) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
  (u) => `https://corsproxy.io/?${encodeURIComponent(u)}`,
];

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

function firstFulfilled<T>(promises: Promise<T>[]): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let pending = promises.length;
    if (pending === 0) {
      reject(new Error('no sources'));
      return;
    }
    for (const p of promises) {
      Promise.resolve(p).then(
        (v) => resolve(v),
        () => {
          pending--;
          if (pending === 0) reject(new Error('all failed'));
        }
      );
    }
  });
}

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function decodeXmlEntities(s: string): string {
  return decodeHtmlEntities(s)
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

const TITLE_CACHE = new Map<string, { time: number; title: string }>();
const CACHE_TTL = 10 * 60 * 1000;

function getCached(key: string): string | null {
  const hit = TITLE_CACHE.get(key);
  if (!hit) return null;
  if (Date.now() - hit.time > CACHE_TTL) {
    TITLE_CACHE.delete(key);
    return null;
  }
  return hit.title;
}

function setCached(key: string, title: string): void {
  TITLE_CACHE.set(key, { time: Date.now(), title });
}

async function fetchJsonViaProxies(url: string, signal?: AbortSignal): Promise<unknown> {
  const attempts = PROXIES.map((make) => {
    const ctrl = raceSignal(signal, 4000);
    return fetch(make(url), { signal: ctrl.signal })
      .then((res) => {
        if (!res.ok) throw new Error('bad status');
        return res.json();
      });
  });
  // also try direct fetch (for CORS-enabled endpoints)
  attempts.push(
    (() => {
      const ctrl = raceSignal(signal, 3500);
      return fetch(url, { signal: ctrl.signal }).then((res) => {
        if (!res.ok) throw new Error('bad status');
        return res.json();
      });
    })()
  );
  return firstFulfilled(attempts);
}

async function fetchTextViaProxies(url: string, signal?: AbortSignal): Promise<string> {
  const attempts = PROXIES.map((make) => {
    const ctrl = raceSignal(signal, 4500);
    return fetch(make(url), { signal: ctrl.signal })
      .then((res) => {
        if (!res.ok) throw new Error('bad status');
        return res.text();
      })
      .then((t) => {
        if (!t || t.length < 50) throw new Error('empty');
        return t;
      });
  });
  return firstFulfilled(attempts);
}

async function fetchYouTubeTitle(videoId: string, signal?: AbortSignal): Promise<string | null> {
  const cacheKey = `youtube:${videoId}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;

  // 1) youtube oembed (direct + proxies)
  const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(watchUrl)}&format=json`;
  try {
    const json = (await fetchJsonViaProxies(oembedUrl, signal)) as { title?: string };
    if (json && typeof json.title === 'string' && json.title.length > 0) {
      const title = json.title.trim();
      setCached(cacheKey, title);
      return title;
    }
  } catch {}

  // 2) noembed fallback (CORS-enabled, aggregates youtube)
  try {
    const json = (await fetchJsonViaProxies(`https://noembed.com/embed?url=${encodeURIComponent(watchUrl)}`, signal)) as { title?: string };
    if (json && typeof json.title === 'string' && json.title.length > 0) {
      const title = json.title.trim();
      setCached(cacheKey, title);
      return title;
    }
  } catch {}

  // 3) invidious video JSON
  try {
    const json = (await fetchJsonViaProxies(`https://invidious.flokinet.to/api/v1/videos/${videoId}`, signal)) as { title?: string };
    if (json && typeof json.title === 'string' && json.title.length > 0) {
      const title = json.title.trim();
      setCached(cacheKey, title);
      return title;
    }
  } catch {}

  // 4) scrape watch page og:title via proxies (last resort)
  try {
    const html = await fetchTextViaProxies(watchUrl, signal);
    const m = html.match(/<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']+)["']/i)
      || html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (m && m[1]) {
      const title = decodeHtmlEntities(m[1].trim()).replace(/\s*-\s*YouTube\s*$/i, '').trim();
      if (title) {
        setCached(cacheKey, title);
        return title;
      }
    }
  } catch {}

  return null;
}

async function fetchNicoTitle(videoId: string, signal?: AbortSignal): Promise<string | null> {
  const cacheKey = `niconico:${videoId}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  // 1) snapshot API single-id search (most reliable, same infra as BrowserPanel)
  const snapshotUrl = `https://snapshot.search.nicovideo.jp/api/v2/snapshot/video/contents/search?${new URLSearchParams({
    q: '',
    targets: 'title',
    fields: 'contentId,title',
    _sort: '-viewCounter',
    _limit: '1',
    _context: 'Co-Viewer-title',
    [`filters[contentId][0]`]: videoId,
  }).toString()}`;
  try {
    const json = (await fetchJsonViaProxies(snapshotUrl, signal)) as { data?: { contentId?: string; title?: string }[] };
    const item = json?.data?.[0];
    if (item && item.contentId === videoId && typeof item.title === 'string' && item.title.length > 0) {
      const title = item.title.trim();
      setCached(cacheKey, title);
      return title;
    }
  } catch {}

  // 2) getthumbinfo XML via proxies
  const thumbinfoUrl = `https://ext.nicovideo.jp/api/getthumbinfo/${videoId}`;
  try {
    const xml = await fetchTextViaProxies(thumbinfoUrl, signal);
    const m = xml.match(/<title>([\s\S]*?)<\/title>/);
    if (m && m[1]) {
      const title = decodeXmlEntities(m[1].trim());
      if (title && !/404|not found/i.test(title)) {
        setCached(cacheKey, title);
        return title;
      }
    }
  } catch {}

  // 3) watch page HTML og:title / <title>
  const watchUrl = `https://www.nicovideo.jp/watch/${videoId}`;
  try {
    const html = await fetchTextViaProxies(watchUrl, signal);
    const decoded = html.replace(/&quot;/g, '"');
    const og = decoded.match(/<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']+)["']/i);
    if (og && og[1]) {
      const title = decodeHtmlEntities(og[1].trim());
      if (title) {
        setCached(cacheKey, title);
        return title;
      }
    }
    const t = decoded.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (t && t[1]) {
      const title = decodeHtmlEntities(t[1].trim()).replace(/\s*-\s*ニコニコ動画\s*$/i, '').trim();
      if (title) {
        setCached(cacheKey, title);
        return title;
      }
    }
  } catch {}

  return null;
}

export async function fetchTitle(platform: Platform, videoId: string): Promise<string | null> {
  try {
    const signal = undefined;
    if (platform === 'youtube') return await fetchYouTubeTitle(videoId, signal);
    return await fetchNicoTitle(videoId, signal);
  } catch {
    return null;
  }
}
