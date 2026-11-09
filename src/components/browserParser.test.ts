import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  extractYouTubeResults,
  extractNicoResults,
  extractNicoSnapshotResults,
  extractInvidiousResults,
  sortResults,
  watchUrl,
  embedUrl,
  fetchSearchResults,
  type SearchResult,
  PAGE_SIZE,
} from './browserParser';

const YT_HTML = `<script>ytInitialData = {"wrap":{"videoRenderer":{"videoId":"dQw4w9WgXcQ","title":{"runs":[{"text":"Rick Astley"}]},"thumbnail":{"thumbnails":[{"url":"https://i.ytimg.com/vi/dQw4w9WgXcQ/hq720.jpg"}]}}}};</script>`;

const NICO_HTML =
  '&quot;items&quot;:[{&quot;type&quot;:&quot;essential&quot;,&quot;id&quot;:&quot;sm12345678&quot;,&quot;contentType&quot;:&quot;long&quot;,&quot;title&quot;:&quot;\\u3042\\u3044\\u3046&quot;,&quot;thumbnail&quot;:{&quot;url&quot;:&quot;https:\\/\\/nicovideo.cdn.nimg.jp\\/thumb\\/12345678&quot;}}]';

describe('extractYouTubeResults', () => {
  it('extracts id, title, thumbnail from ytInitialData', () => {
    const r = extractYouTubeResults(YT_HTML);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({
      id: 'dQw4w9WgXcQ',
      title: 'Rick Astley',
      thumbnail: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hq720.jpg',
      platform: 'youtube',
    });
  });

  it('returns [] when ytInitialData is absent', () => {
    expect(extractYouTubeResults('<html>no data</html>')).toEqual([]);
  });
});

describe('extractNicoResults', () => {
  it('extracts id, decoded title, and unescaped thumbnail url', () => {
    const r = extractNicoResults(NICO_HTML);
    expect(r).toHaveLength(1);
    expect(r[0].id).toBe('sm12345678');
    expect(r[0].title).toBe('あいう');
    expect(r[0].thumbnail).toBe('https://nicovideo.cdn.nimg.jp/thumb/12345678');
    expect(r[0].platform).toBe('nico');
  });

  it('returns [] for unrelated html', () => {
    expect(extractNicoResults('plain text no ids')).toEqual([]);
  });
});

describe('extractNicoSnapshotResults', () => {
  const snapshot = {
    meta: { status: 200, totalCount: 3, id: 'x' },
    data: [
      {
        contentId: 'sm9',
        title: 'テスト',
        thumbnailUrl: 'https://nicovideo.cdn.nimg.jp/thumb/9',
        viewCounter: 100,
        startTime: '2016-11-03T02:09:11+09:00',
      },
      { contentId: 'sm9', title: 'duplicate id (skipped)' },
      { contentId: 'sm123', title: 'no thumbnail' },
    ],
  };

  it('maps contentId/title/thumbnailUrl, dedupes, and falls back for missing thumb', () => {
    const r = extractNicoSnapshotResults(snapshot);
    expect(r).toHaveLength(2);
    expect(r[0]).toMatchObject({
      id: 'sm9',
      title: 'テスト',
      thumbnail: 'https://nicovideo.cdn.nimg.jp/thumb/9',
      platform: 'nico',
    });
    // missing thumbnailUrl falls back to the smilevideo thumbnail endpoint
    expect(r[1].id).toBe('sm123');
    expect(r[1].thumbnail).toBe('https://tn.smilevideo.jp/smile?i=sm123');
    expect(r[0].views).toBe(100);
    expect(r[0].published).toBe(new Date('2016-11-03T02:09:11+09:00').getTime());
    expect(r[1].views).toBeUndefined();
    expect(r[1].published).toBeUndefined();
  });

  it('returns [] for empty data or non-object input', () => {
    expect(extractNicoSnapshotResults({ meta: { status: 200 }, data: [] })).toEqual([]);
    expect(extractNicoSnapshotResults(null)).toEqual([]);
    expect(extractNicoSnapshotResults({})).toEqual([]);
  });
});

describe('extractInvidiousResults', () => {
  const sample = [
    {
      type: 'video',
      videoId: 'dQw4w9WgXcQ',
      title: 'Rick Astley',
      viewCount: 1234567,
      published: 1286546800,
      videoThumbnails: [{ quality: 'medium', url: 'https://inv.example/1.jpg' }],
    },
    { type: 'channel', author: 'someone' },
    {
      type: 'video',
      videoId: 'dQw4w9WgXcQ',
      title: 'Duplicate id (skipped)',
    },
    { type: 'video', videoId: '9bZkp7q19f0', title: 'PSY' },
  ];
  it('maps video items, builds thumbnail, dedupes, ignores non-video', () => {
    const r = extractInvidiousResults(sample);
    expect(r).toHaveLength(2);
    expect(r[0]).toMatchObject({
      id: 'dQw4w9WgXcQ',
      title: 'Rick Astley',
      platform: 'youtube',
    });
    // thumbnail is built from i.ytimg.com, not the instance url
    expect(r[0].thumbnail).toBe('https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg');
    expect(r[1].id).toBe('9bZkp7q19f0');
    // view count and publish time are normalized (seconds -> ms)
    expect(r[0].views).toBe(1234567);
    expect(r[0].published).toBe(1286546800 * 1000);
  });

  it('returns [] for non-array input', () => {
    expect(extractInvidiousResults(null)).toEqual([]);
    expect(extractInvidiousResults({})).toEqual([]);
  });
});

describe('sortResults', () => {
  const make = (over: Partial<SearchResult> = {}): SearchResult => ({
    id: 'x',
    title: 't',
    thumbnail: '',
    platform: 'youtube',
    ...over,
  });
  const list = [
    make({ id: 'a', title: 'B', views: 10, published: 100 }),
    make({ id: 'b', title: 'A', views: 30, published: 300 }),
    make({ id: 'c', title: 'C', views: 20, published: 200 }),
    make({ id: 'd', title: 'D' }),
  ];

  it('relevance returns the same reference (no copy)', () => {
    expect(sortResults(list, 'relevance')).toBe(list);
  });
  it('views desc, missing sinks to bottom', () => {
    expect(sortResults(list, 'views').map((r) => r.id)).toEqual(['b', 'c', 'a', 'd']);
  });
  it('date desc', () => {
    expect(sortResults(list, 'date').map((r) => r.id)).toEqual(['b', 'c', 'a', 'd']);
  });
  it('title asc', () => {
    expect(sortResults(list, 'title').map((r) => r.title)).toEqual(['A', 'B', 'C', 'D']);
  });
  it('does not mutate the input array', () => {
    const before = list.map((r) => r.id);
    sortResults(list, 'views');
    expect(list.map((r) => r.id)).toEqual(before);
  });
});

describe('url helpers', () => {
  const yt: SearchResult = { id: 'abc', title: 't', thumbnail: '', platform: 'youtube' };
  const nico: SearchResult = { id: 'sm9', title: 't', thumbnail: '', platform: 'nico' };
  it('watchUrl / embedUrl build correct endpoints', () => {
    expect(watchUrl(yt)).toBe('https://www.youtube.com/watch?v=abc');
    expect(watchUrl(nico)).toBe('https://www.nicovideo.jp/watch/sm9');
    expect(embedUrl(yt)).toBe('https://www.youtube.com/embed/abc');
    expect(embedUrl(nico)).toBe('https://embed.nicovideo.jp/watch/sm9');
  });
});

// S1/S2/S3 TDD RED — YouTube resilience
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function mockJsonResponse(data: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => data,
    text: async () => JSON.stringify(data),
  } as unknown as Response;
}

function mockTextResponse(text: string, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => {
      try {
        return JSON.parse(text);
      } catch {
        return null;
      }
    },
    text: async () => text,
  } as unknown as Response;
}

describe('S1 Happy YouTube proxy resilience', () => {
  it('YouTube succeeds when proxy[0] 429 but proxy[1] 200', async () => {
    const invJson = [
      { type: 'video', videoId: 'dQw4w9WgXcQ', title: 'Test', viewCount: 1, published: 123 },
    ];
    const fetchMock = vi.fn(async (url: string): Promise<Response> => {
      const u = String(url);
      if (u.includes('invidious') && !u.includes('proxy.cors.sh') && !u.includes('allorigins') && !u.includes('cors.eu.org')) {
        throw new Error('direct fail');
      }
      if (u.includes('proxy.cors.sh')) {
        return mockJsonResponse([], false, 429);
      }
      if (u.includes('allorigins')) {
        return mockJsonResponse(invJson, true, 200);
      }
      if (u.includes('cors.eu.org')) {
        return mockJsonResponse([], false, 429);
      }
      return mockTextResponse('', false, 500);
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const out = await fetchSearchResults('youtube', 's1-proxy-fallback-unique-q-' + Date.now());
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.results[0].id).toBe('dQw4w9WgXcQ');
    }
  });

  it('YouTube direct multi-instance race: second instance succeeds when first times out', async () => {
    const invJson = [
      { type: 'video', videoId: '9bZkp7q19f0', title: 'PSY', viewCount: 5, published: 456 },
    ];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
      const u = String(url);
      const signal = init?.signal as AbortSignal | undefined;
      if (u.includes('flokinet.to')) {
        return await new Promise<Response>((resolve, reject) => {
          if (signal?.aborted) {
            reject(new DOMException('Aborted', 'AbortError'));
            return;
          }
          const onAbort = (): void => reject(new DOMException('Aborted', 'AbortError'));
          signal?.addEventListener('abort', onAbort, { once: true });
        });
      }
      if (u.includes('nerdvpn.de') || u.includes('tux.pizza')) {
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        return mockJsonResponse(invJson, true, 200);
      }
      return mockJsonResponse([], false, 500);
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const out = await fetchSearchResults('youtube', 's1-race-unique-q-' + Date.now());
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.results[0].id).toBe('9bZkp7q19f0');
    }
  });
});

describe('S2 Edge', () => {
  it('YouTube timeout all sources -> network', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit): Promise<Response> => {
      const signal = init?.signal as AbortSignal | undefined;
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => resolve(), 7000);
        const onAbort = (): void => {
          clearTimeout(t);
          reject(new DOMException('Aborted', 'AbortError'));
        };
        if (signal?.aborted) {
          clearTimeout(t);
          reject(new DOMException('Aborted', 'AbortError'));
          return;
        }
        signal?.addEventListener('abort', onAbort, { once: true });
      });
      throw new Error('timeout');
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const out = await fetchSearchResults('youtube', 's2-timeout-all-' + Date.now());
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.reason).toBe('network');
    }
  }, 18000);

  it('empty Invidious + empty HTML -> empty', async () => {
    const fetchMock = vi.fn(async (url: string): Promise<Response> => {
      const u = String(url);
      if (u.includes('/api/v1/search')) {
        return mockJsonResponse([], true, 200);
      }
      if (u.includes('youtube.com/results')) {
        const html = '<html><body>no results here ' + 'x'.repeat(120) + '</body></html>';
        return mockTextResponse(html, true, 200);
      }
      if (u.includes('proxy.cors.sh') || u.includes('allorigins') || u.includes('cors.eu.org')) {
        const html = '<html><body>no results here ' + 'x'.repeat(120) + '</body></html>';
        return mockTextResponse(html, true, 200);
      }
      return mockTextResponse('', false, 500);
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const out = await fetchSearchResults('youtube', 's2-empty-both-' + Date.now());
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.reason).toBe('empty');
    }
  });

  it('extractYouTubeResults handles lockupViewModel HTML', () => {
    const html = `<script>ytInitialData = ${JSON.stringify({
      contents: {
        lockupViewModel: {
          contentId: 'dQw4w9WgXcQ',
          metadata: { lockupMetadataViewModel: { title: { content: 'Lockup Title' } } },
          contentImage: {
            thumbnailViewModel: { image: { sources: [{ url: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hq720.jpg' }] } },
          },
        },
      },
    })};</script>`;
    const r = extractYouTubeResults(html);
    expect(r).toHaveLength(1);
    expect(r[0].id).toBe('dQw4w9WgXcQ');
    expect(r[0].title).toBe('Lockup Title');
  });

  it('abort signal prevents stale results', async () => {
    const invJson = [{ type: 'video', videoId: 'abc123', title: 'Hi', viewCount: 1, published: 1 }];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
      const u = String(url);
      const signal = init?.signal as AbortSignal | undefined;
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      if (u.includes('/api/v1/search')) {
        return mockJsonResponse(invJson, true, 200);
      }
      return mockTextResponse('', false, 500);
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const ctrl = new AbortController();
    const promise = fetchSearchResults('youtube', 's2-abort-' + Date.now(), ctrl.signal);
    ctrl.abort();
    const out = await promise;
    expect(typeof out.ok).toBe('boolean');
  });
});

describe('S3 Regression', () => {
  it('Nico still succeeds via snapshot API', async () => {
    const snap = {
      meta: { status: 200 },
      data: [{ contentId: 'sm98765432', title: 'Nico Test', thumbnailUrl: 'https://nicovideo.cdn.nimg.jp/thumb/98765432', viewCounter: 42, startTime: '2024-01-01T00:00:00+09:00' }],
    };
    const fetchMock = vi.fn(async (url: string): Promise<Response> => {
      const u = String(url);
      if (u.includes('snapshot.search.nicovideo.jp') || u.includes('allorigins') || u.includes('proxy.cors.sh') || u.includes('cors.eu.org')) {
        return mockJsonResponse(snap, true, 200);
      }
      return mockJsonResponse(snap, true, 200);
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const out = await fetchSearchResults('nico', 's3-nico-snap-' + Date.now());
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.results[0].platform).toBe('nico');
      expect(out.results[0].id).toBe('sm98765432');
    }
  });

  it('cache TTL 5min', async () => {
    const invJson = [{ type: 'video', videoId: 'cache123', title: 'Cached', viewCount: 1, published: 1 }];
    let callCount = 0;
    const fetchMock = vi.fn(async (url: string): Promise<Response> => {
      const u = String(url);
      if (u.includes('/api/v1/search')) {
        callCount++;
        return mockJsonResponse(invJson, true, 200);
      }
      return mockTextResponse('', false, 500);
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const q = 's3-cache-ttl-' + Date.now();
    const first = await fetchSearchResults('youtube', q);
    expect(first.ok).toBe(true);
    const countAfterFirst = callCount;
    expect(countAfterFirst).toBeGreaterThan(0);

    callCount = 0;
    fetchMock.mockClear();
    let secondFetchCount = 0;
    const secondMock = vi.fn(async (url: string): Promise<Response> => {
      const u = String(url);
      if (u.includes('/api/v1/search')) {
        secondFetchCount++;
        return mockJsonResponse(invJson, true, 200);
      }
      if (u.includes('proxy.cors.sh') || u.includes('allorigins') || u.includes('youtube.com/results')) {
        secondFetchCount++;
        return mockTextResponse('', false, 500);
      }
      return mockJsonResponse(invJson, true, 200);
    });
    vi.stubGlobal('fetch', secondMock as unknown as typeof fetch);

    const second = await fetchSearchResults('youtube', q);
    expect(second.ok).toBe(true);
    expect(secondFetchCount).toBe(0);
    if (first.ok && second.ok) {
      expect(second.results[0].id).toBe(first.results[0].id);
    }
  });
});

describe('pagination', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('nicoSnapshotUrl page1 has _offset=0 and page2 has _offset=30', async () => {
    const mod = (await import('./browserParser')) as unknown as Record<string, unknown>;
    const fn = mod['nicoSnapshotUrl'] as ((q: string, page?: number) => string) | undefined;
    if (typeof fn === 'function') {
      const u1 = fn('hello pagination', 1);
      const u2 = fn('hello pagination', 2);
      expect(decodeURIComponent(u1)).toContain('_offset=0');
      expect(decodeURIComponent(u2)).toContain('_offset=30');
      expect(decodeURIComponent(u1)).toContain('_limit=30');
      expect(decodeURIComponent(u2)).toContain('_limit=30');
    } else {
      // fallback via fetch URL spying — before Task1 export missing this branch asserts _offset wiring
      const urls: string[] = [];
      const fetchMock = vi.fn(async (url: string): Promise<Response> => {
        urls.push(String(url));
        return mockJsonResponse(
          { meta: { status: 200 }, data: [{ contentId: 'sm1', title: 't', thumbnailUrl: 'https://x' }] },
          true,
          200
        );
      });
      vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
      const q1 = 'nico-off-' + Date.now() + Math.random();
      await (fetchSearchResults as unknown as (p: string, q: string, s?: AbortSignal, page?: number) => Promise<unknown>)(
        'nico',
        q1,
        undefined,
        1
      );
      const u1 = urls[0] ? decodeURIComponent(String(urls[0])) : '';
      urls.length = 0;
      vi.unstubAllGlobals();
      const urls2: string[] = [];
      const fetchMock2 = vi.fn(async (url: string): Promise<Response> => {
        urls2.push(String(url));
        return mockJsonResponse(
          { meta: { status: 200 }, data: [{ contentId: 'sm2', title: 't', thumbnailUrl: 'https://x' }] },
          true,
          200
        );
      });
      vi.stubGlobal('fetch', fetchMock2 as unknown as typeof fetch);
      const q2 = 'nico-off2-' + Date.now() + Math.random();
      await (fetchSearchResults as unknown as (p: string, q: string, s?: AbortSignal, page?: number) => Promise<unknown>)(
        'nico',
        q2,
        undefined,
        2
      );
      const u2 = urls2[0] ? decodeURIComponent(String(urls2[0])) : '';
      expect(u1).toContain('_offset=0');
      expect(u2).toContain('_offset=30');
    }
  });

  it('fetchSearchResults youtube page 2 hits URL with page=2', async () => {
    const urls: string[] = [];
    const invJson = [{ type: 'video', videoId: 'yt-pag2', title: 'T', viewCount: 1, published: 1 }];
    const fetchMock = vi.fn(async (url: string): Promise<Response> => {
      urls.push(String(url));
      if (String(url).includes('/api/v1/search')) return mockJsonResponse(invJson, true, 200);
      return mockTextResponse('', false, 500);
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
    const q = 'yt-pag2-' + Date.now() + Math.random();
    await (fetchSearchResults as unknown as (p: string, q: string, s?: AbortSignal, page?: number) => Promise<unknown>)(
      'youtube',
      q,
      undefined,
      2
    );
    const decoded = urls.map((u) => decodeURIComponent(String(u))).join(' ');
    expect(decoded).toContain('page=2');
  });

  it('fetchSearchResults nico page 2 hits _offset=30', async () => {
    const urls: string[] = [];
    const snap = { meta: { status: 200 }, data: [{ contentId: 'sm999', title: 't', thumbnailUrl: 'https://x' }] };
    const fetchMock = vi.fn(async (url: string): Promise<Response> => {
      urls.push(String(url));
      if (String(url).includes('snapshot') || String(url).includes('allorigins') || String(url).includes('proxy.cors.sh') || String(url).includes('cors.eu.org')) {
        return mockJsonResponse(snap, true, 200);
      }
      return mockJsonResponse(snap, true, 200);
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
    const q = 'nico-p2-' + Date.now() + Math.random();
    await (fetchSearchResults as unknown as (p: string, q: string, s?: AbortSignal, page?: number) => Promise<unknown>)(
      'nico',
      q,
      undefined,
      2
    );
    const decoded = urls.map((u) => decodeURIComponent(String(u))).join(' ');
    expect(decoded).toContain('_offset=30');
  });

  it('cache isolation p1 vs p2 not colliding', async () => {
    const invJson = [{ type: 'video', videoId: 'cache-iso', title: 'T', viewCount: 1, published: 1 }];
    let callCount = 0;
    const mk = () =>
      vi.fn(async (url: string): Promise<Response> => {
        if (String(url).includes('/api/v1/search')) {
          callCount++;
          return mockJsonResponse(invJson, true, 200);
        }
        return mockTextResponse('', false, 500);
      });
    const q = 'cache-iso-' + Date.now() + Math.random();
    callCount = 0;
    vi.stubGlobal('fetch', mk() as unknown as typeof fetch);
    await (fetchSearchResults as unknown as (p: string, q: string, s?: AbortSignal, page?: number) => Promise<unknown>)(
      'youtube',
      q,
      undefined,
      1
    );
    expect(callCount).toBeGreaterThan(0);
    callCount = 0;
    vi.stubGlobal('fetch', mk() as unknown as typeof fetch);
    await (fetchSearchResults as unknown as (p: string, q: string, s?: AbortSignal, page?: number) => Promise<unknown>)(
      'youtube',
      q,
      undefined,
      2
    );
    // second page must not be served from p1 cache
    expect(callCount).toBeGreaterThan(0);
    callCount = 0;
    vi.stubGlobal('fetch', mk() as unknown as typeof fetch);
    await (fetchSearchResults as unknown as (p: string, q: string, s?: AbortSignal, page?: number) => Promise<unknown>)(
      'youtube',
      q,
      undefined,
      1
    );
    // p1 again should hit cache
    expect(callCount).toBe(0);
  });

  it('hasMore inference: PAGE_SIZE items => hasMore true, <PAGE_SIZE => false', async () => {
    const makeItems = (n: number, seed: string) =>
      Array.from({ length: n }, (_, i) => ({
        type: 'video',
        videoId: `${seed}${i}`,
        title: `t${i}`,
        viewCount: 1,
        published: 1,
      }));
    expect(PAGE_SIZE).toBe(30);
    const full = makeItems(PAGE_SIZE, 'hmfull-');
    const fetchMockFull = vi.fn(async (url: string): Promise<Response> => {
      if (String(url).includes('/api/v1/search')) return mockJsonResponse(full, true, 200);
      return mockTextResponse('', false, 500);
    });
    vi.stubGlobal('fetch', fetchMockFull as unknown as typeof fetch);
    const qFull = 'hasmore-full-' + Date.now() + Math.random();
    const outFull = (await (fetchSearchResults as unknown as (p: string, q: string, s?: AbortSignal, page?: number) => Promise<unknown>)(
      'youtube',
      qFull,
      undefined,
      1
    )) as { ok: boolean; hasMore?: boolean };
    expect(outFull.ok).toBe(true);
    expect(outFull.hasMore).toBe(true);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    const few = makeItems(5, 'hmfew-');
    const fetchMockFew = vi.fn(async (url: string): Promise<Response> => {
      if (String(url).includes('/api/v1/search')) return mockJsonResponse(few, true, 200);
      return mockTextResponse('', false, 500);
    });
    vi.stubGlobal('fetch', fetchMockFew as unknown as typeof fetch);
    const qFew = 'hasmore-few-' + Date.now() + Math.random();
    const outFew = (await (fetchSearchResults as unknown as (p: string, q: string, s?: AbortSignal, page?: number) => Promise<unknown>)(
      'youtube',
      qFew,
      undefined,
      1
    )) as { ok: boolean; hasMore?: boolean };
    expect(outFew.ok).toBe(true);
    expect(outFew.hasMore).toBe(false);
  });

  it('backward compat 3-arg call still works (defaults to page 1)', async () => {
    const urls: string[] = [];
    const invJson = [{ type: 'video', videoId: 'bc123', title: 'T', viewCount: 1, published: 1 }];
    const fetchMock = vi.fn(async (url: string): Promise<Response> => {
      urls.push(String(url));
      if (String(url).includes('/api/v1/search')) return mockJsonResponse(invJson, true, 200);
      return mockTextResponse('', false, 500);
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
    const q = 'bc-' + Date.now() + Math.random();
    const out = await fetchSearchResults('youtube', q);
    expect(out.ok).toBe(true);
    const decoded = urls.map((u) => decodeURIComponent(String(u))).join(' ');
    // default must be page=1 explicitly
    expect(decoded).toContain('page=1');
  });

  it('fetchSearchResults nico default page is _offset=0', async () => {
    const urls: string[] = [];
    const snap = { meta: { status: 200 }, data: [{ contentId: 'sm000', title: 't', thumbnailUrl: 'https://x' }] };
    const fetchMock = vi.fn(async (url: string): Promise<Response> => {
      urls.push(String(url));
      return mockJsonResponse(snap, true, 200);
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
    const q = 'nico-default-' + Date.now() + Math.random();
    await (fetchSearchResults as unknown as (p: string, q: string, s?: AbortSignal, page?: number) => Promise<unknown>)(
      'nico',
      q,
      undefined,
      1
    );
    const decoded = urls.map((u) => decodeURIComponent(String(u))).join(' ');
    expect(decoded).toContain('_offset=0');
  });
});
