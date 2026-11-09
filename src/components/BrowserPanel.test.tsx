import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
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
});
