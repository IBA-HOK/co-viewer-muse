import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import BrowserPanel from './BrowserPanel';

// Pagination harness: IntersectionObserver mock for infinite scroll sentinel
const mockObserve = vi.fn();
const mockUnobserve = vi.fn();
const mockDisconnect = vi.fn();

vi.stubGlobal(
  'IntersectionObserver',
  vi.fn(
    (
      cb: IntersectionObserverCallback,
      _options?: IntersectionObserverInit,
    ): IntersectionObserver => {
      // expose callback for pagination harness verification
      (globalThis as unknown as { __ioCb: IntersectionObserverCallback }).__ioCb = cb;
      return {
        observe: mockObserve,
        unobserve: mockUnobserve,
        disconnect: mockDisconnect,
        root: null,
        rootMargin: '',
        thresholds: [],
        takeRecords: () => [],
      } as unknown as IntersectionObserver;
    },
  ),
);

function mockFetchSuccess(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve({
        ok: true,
        text: () => Promise.resolve('<html></html>'),
        json: () => Promise.resolve({}),
      } as Response),
    ),
  );
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function jsonResponse(data: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => data,
    text: async () => JSON.stringify(data),
  } as unknown as Response;
}

function invidiousItems(prefix: string, count: number) {
  return Array.from({ length: count }, (_, i) => ({
    type: 'video',
    videoId: `${prefix}-${i}`,
    title: `${prefix} item ${i}`,
    viewCount: i,
    published: 1,
  }));
}

function latestIoCb(): IntersectionObserverCallback {
  return (globalThis as unknown as { __ioCb: IntersectionObserverCallback }).__ioCb;
}

describe('BrowserPanel harness', () => {
  beforeEach(() => {
    if (window.localStorage) window.localStorage.clear();
    mockObserve.mockClear();
    mockUnobserve.mockClear();
    mockDisconnect.mockClear();
    mockFetchSuccess();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    // re-install IntersectionObserver mock after restore
    vi.stubGlobal(
      'IntersectionObserver',
      vi.fn(
        (
          cb: IntersectionObserverCallback,
        ): IntersectionObserver => {
          (globalThis as unknown as { __ioCb: IntersectionObserverCallback }).__ioCb = cb;
          return {
            observe: mockObserve,
            unobserve: mockUnobserve,
            disconnect: mockDisconnect,
            root: null,
            rootMargin: '',
            thresholds: [],
            takeRecords: () => [],
          } as unknown as IntersectionObserver;
        },
      ),
    );
    mockFetchSuccess();
  });

  it('renders BROWSER heading and collapsed IDLE state', () => {
    render(<BrowserPanel onAddToQueue={vi.fn()} />);
    expect(screen.getByText('BROWSER')).toBeTruthy();
    // collapsed shows IDLE
    expect(screen.getAllByText('IDLE').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('+ OPEN')).toBeTruthy();
  });

  it('toggles expanded state and shows search input', () => {
    render(<BrowserPanel onAddToQueue={vi.fn()} />);
    const btn = screen.getByText('+ OPEN');
    fireEvent.click(btn);
    expect(screen.getByPlaceholderText('URL / ID or SEARCH KEYWORD')).toBeTruthy();
    expect(screen.getByText('— CLOSE')).toBeTruthy();
  });

  it('engine toggle switches between YOUTUBE and NICO', () => {
    render(<BrowserPanel onAddToQueue={vi.fn()} />);
    fireEvent.click(screen.getByText('+ OPEN'));
    const nicoBtn = screen.getByText('NICO');
    fireEvent.click(nicoBtn);
    // after toggling to nico, button should still exist
    expect(screen.getByText('NICO')).toBeTruthy();
    expect(screen.getByText('YOUTUBE')).toBeTruthy();
    fireEvent.click(screen.getByText('YOUTUBE'));
    expect(screen.getByText('YOUTUBE')).toBeTruthy();
  });

  it('input change updates value and Enter triggers search', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve({
        ok: true,
        text: () => Promise.resolve(''),
        json: () => Promise.resolve({}),
      } as Response),
    );
    vi.stubGlobal('fetch', fetchMock);
    render(<BrowserPanel onAddToQueue={vi.fn()} />);
    fireEvent.click(screen.getByText('+ OPEN'));
    const input = screen.getByPlaceholderText('URL / ID or SEARCH KEYWORD') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'hello world' } });
    expect(input.value).toBe('hello world');
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
  });

  it('runSearch with direct URL calls onAddToQueue immediately', () => {
    const onAdd = vi.fn();
    render(<BrowserPanel onAddToQueue={onAdd} />);
    fireEvent.click(screen.getByText('+ OPEN'));
    const input = screen.getByPlaceholderText('URL / ID or SEARCH KEYWORD') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' } });
    const btn = screen.getByText('LOAD / SEARCH');
    fireEvent.click(btn);
    expect(onAdd).toHaveBeenCalledWith('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  });

  it('LOAD / SEARCH button triggers fetch for keyword query', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve({
        ok: true,
        text: () => Promise.resolve('no results'),
        json: () => Promise.resolve({}),
      } as Response),
    );
    vi.stubGlobal('fetch', fetchMock);
    render(<BrowserPanel onAddToQueue={vi.fn()} />);
    fireEvent.click(screen.getByText('+ OPEN'));
    const input = screen.getByPlaceholderText('URL / ID or SEARCH KEYWORD') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'test keyword' } });
    fireEvent.click(screen.getByText('LOAD / SEARCH'));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
  });

  it('IntersectionObserver is available for pagination sentinel', () => {
    render(<BrowserPanel onAddToQueue={vi.fn()} />);
    expect(globalThis.IntersectionObserver).toBeDefined();
    // verify mock was constructed with correct signature
    expect(vi.mocked(globalThis.IntersectionObserver)).toBeDefined();
  });

  it('stops pagination when loadMore returns only duplicate results', async () => {
    const makeItems = () =>
      Array.from({ length: 30 }, (_, i) => ({
        type: 'video',
        videoId: `dup-${i}`,
        title: `dup item ${i}`,
        viewCount: 1,
        published: 1,
      }));
    const page2Requests: string[] = [];
    const fetchMock = vi.fn(async (url: string): Promise<Response> => {
      const u = String(url);
      if (u.includes('/api/v1/search')) {
        if (u.includes('page=2')) page2Requests.push(u);
        return {
          ok: true,
          status: 200,
          json: async () => makeItems(),
          text: async () => JSON.stringify(makeItems()),
        } as unknown as Response;
      }
      return {
        ok: false,
        status: 500,
        json: async () => null,
        text: async () => '',
      } as unknown as Response;
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    class ConstructorIO {
      constructor(cb: IntersectionObserverCallback) {
        (globalThis as unknown as { __ioCb: IntersectionObserverCallback }).__ioCb = cb;
      }
      observe = mockObserve;
      unobserve = mockUnobserve;
      disconnect = mockDisconnect;
      root = null;
      rootMargin = '';
      thresholds = [];
      takeRecords = () => [];
    }
    vi.stubGlobal('IntersectionObserver', ConstructorIO);

    render(<BrowserPanel onAddToQueue={vi.fn()} />);
    fireEvent.click(screen.getByText('+ OPEN'));
    const input = screen.getByPlaceholderText('URL / ID or SEARCH KEYWORD') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'duplicate only page' } });
    fireEvent.click(screen.getByText('LOAD / SEARCH'));

    await waitFor(() => expect(screen.getByText('dup item 0')).toBeTruthy());
    await waitFor(() =>
      expect(
        (globalThis as unknown as { __ioCb?: IntersectionObserverCallback }).__ioCb
      ).toBeTypeOf('function')
    );
    const ioCb = (globalThis as unknown as { __ioCb: IntersectionObserverCallback }).__ioCb;

    // Sentinel intersects -> request page 2, which contains only duplicates.
    await act(async () => {
      ioCb([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
    });
    await waitFor(() => expect(page2Requests.length).toBeGreaterThan(0));
    await waitFor(() => expect(screen.getByText('— END —')).toBeTruthy());
    const page2CallsAfterLoad = page2Requests.length;

    // A stale observer callback must not issue another request.
    await act(async () => {
      ioCb([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(page2Requests.length).toBe(page2CallsAfterLoad);
  });

  it('cancels a pending keyword search when a URL is submitted', async () => {
    const onAdd = vi.fn();
    const pending = deferred<Response>();
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('pending-url-race')) return pending.promise;
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    render(<BrowserPanel onAddToQueue={onAdd} />);
    fireEvent.click(screen.getByText('+ OPEN'));
    const input = screen.getByPlaceholderText('URL / ID or SEARCH KEYWORD') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'pending-url-race' } });
    fireEvent.click(screen.getByText('LOAD / SEARCH'));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(screen.getByText('SEARCHING…')).toBeTruthy();

    const directUrl = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
    fireEvent.change(input, { target: { value: directUrl } });
    // The search button is disabled while loading, so submit via Enter just
    // like a user can still do during an in-flight keyword search.
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onAdd).toHaveBeenCalledWith(directUrl);
    expect(screen.queryByText('SEARCHING…')).toBeNull();
    expect(screen.getByText('LOAD / SEARCH')).toBeTruthy();

    // The abandoned keyword search resolves late; it must not repopulate the
    // list or restore its loading label.
    await act(async () => {
      pending.resolve(jsonResponse(invidiousItems('stale-url', 1)));
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    expect(screen.queryByText('stale-url item 0')).toBeNull();
    expect(screen.queryByText('SEARCHING…')).toBeNull();
  });

  it('ignores a pending YOUTUBE response after switching to NICO', async () => {
    const pending = deferred<Response>();
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('engine-switch-race')) return pending.promise;
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    render(<BrowserPanel onAddToQueue={vi.fn()} />);
    fireEvent.click(screen.getByText('+ OPEN'));
    const input = screen.getByPlaceholderText('URL / ID or SEARCH KEYWORD') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'engine-switch-race' } });
    fireEvent.click(screen.getByText('LOAD / SEARCH'));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(screen.getByText('SEARCHING…')).toBeTruthy();

    fireEvent.click(screen.getByText('NICO'));
    expect(screen.queryByText('SEARCHING…')).toBeNull();

    await act(async () => {
      pending.resolve(jsonResponse(invidiousItems('stale-engine', 1)));
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    expect(screen.queryByText('stale-engine item 0')).toBeNull();
    expect(screen.queryByText('SEARCHING…')).toBeNull();
  });

  it('keeps a newer loadMore/loading state when an old loadMore resolves late', async () => {
    const oldPage2 = deferred<Response>();
    const newSearch = deferred<Response>();
    const newPage2 = deferred<Response>();
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('q=loadmore-race')) {
        return url.includes('page=2')
          ? oldPage2.promise
          : Promise.resolve(jsonResponse(invidiousItems('initial', 30)));
      }
      if (url.includes('q=fresh-query-long')) {
        return url.includes('page=2') ? newPage2.promise : newSearch.promise;
      }
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    class ConstructorIO {
      constructor(cb: IntersectionObserverCallback) {
        (globalThis as unknown as { __ioCb: IntersectionObserverCallback }).__ioCb = cb;
      }
      observe = mockObserve;
      unobserve = mockUnobserve;
      disconnect = mockDisconnect;
      root = null;
      rootMargin = '';
      thresholds = [];
      takeRecords = () => [];
    }
    vi.stubGlobal('IntersectionObserver', ConstructorIO);

    const page2Calls = (query: string) =>
      fetchMock.mock.calls.filter(([input]) => {
        const url = String(input);
        return url.includes(`q=${query}`) && url.includes('page=2');
      }).length;

    render(<BrowserPanel onAddToQueue={vi.fn()} />);
    fireEvent.click(screen.getByText('+ OPEN'));
    const input = screen.getByPlaceholderText('URL / ID or SEARCH KEYWORD') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'loadmore-race' } });
    fireEvent.click(screen.getByText('LOAD / SEARCH'));

    await waitFor(() => expect(screen.getByText('initial item 0')).toBeTruthy());
    await waitFor(() => expect(latestIoCb()).toBeTypeOf('function'));

    // Start loadMore and leave its page-2 response pending.
    await act(async () => {
      latestIoCb()(
        [{ isIntersecting: true } as IntersectionObserverEntry],
        {} as IntersectionObserver
      );
    });
    await waitFor(() => expect(page2Calls('loadmore-race')).toBeGreaterThan(0));
    expect(screen.getByText('LOADING…')).toBeTruthy();

    // Start a fresh keyword search while the old loadMore is still pending.
    fireEvent.change(input, { target: { value: 'fresh-query-long' } });
    fireEvent.click(screen.getByText('LOAD / SEARCH'));
    expect(screen.getByText('SEARCHING…')).toBeTruthy();

    await act(async () => {
      newSearch.resolve(jsonResponse(invidiousItems('fresh', 30)));
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    await waitFor(() => expect(screen.getByText('fresh item 0')).toBeTruthy());

    // Begin the fresh search's own loadMore and leave it pending.
    await act(async () => {
      latestIoCb()(
        [{ isIntersecting: true } as IntersectionObserverEntry],
        {} as IntersectionObserver
      );
    });
    await waitFor(() => expect(page2Calls('fresh-query-long')).toBeGreaterThan(0));
    expect(screen.getByText('LOADING…')).toBeTruthy();
    const freshPage2Calls = page2Calls('fresh-query-long');

    // The stale request settles after the new one is already loading. Its
    // finally must not clear loadingMore/loadingLockRef or append its results.
    await act(async () => {
      oldPage2.resolve(jsonResponse(invidiousItems('stale-loadmore', 1)));
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    expect(screen.queryByText('stale-loadmore item 0')).toBeNull();
    expect(screen.getByText('LOADING…')).toBeTruthy();

    // The loading lock is still held, so the observer cannot start another
    // page-2 request.
    await act(async () => {
      latestIoCb()(
        [{ isIntersecting: true } as IntersectionObserverEntry],
        {} as IntersectionObserver
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(page2Calls('fresh-query-long')).toBe(freshPage2Calls);
  });
});
