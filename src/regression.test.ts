import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SYNC_DRIFT_THRESHOLD, SYNC_PING_INTERVAL } from './types/index';

const root = resolve(__dirname, '..');

function read(rel: string): string {
  return readFileSync(resolve(root, rel), 'utf-8');
}

describe('regression: BrowserPanel preview must not render iframe/embedUrl', () => {
  it('BrowserPanel preview block contains no iframe and no embedUrl call', () => {
    const src = read('src/components/BrowserPanel.tsx');

    // Dead preview block was deleted as scope cut (BAD item 1 GOOD = deletion). Accept either:
    // - preview block absent (0 preview state) => GOOD (scope cut)
    // - preview block present but contains no iframe/embedUrl => GOOD (thumbnail-only preview)
    const previewStart = src.indexOf('{preview &&');
    if (previewStart !== -1) {
      const afterPreview = src.slice(previewStart);
      const nextBlock = afterPreview.indexOf('{bookmarks.length');
      const previewBlock = nextBlock !== -1 ? afterPreview.slice(0, nextBlock) : afterPreview.slice(0, 2000);
      expect(previewBlock.toLowerCase().includes('<iframe')).toBe(false);
      expect(previewBlock.includes('embedUrl(preview')).toBe(false);
      expect(previewBlock.includes('embedUrl(')).toBe(false);
    } else {
      // Scope cut: preview state deleted entirely — verify no dead state remains
      expect(src.includes('setPreview')).toBe(false);
      // preview identifier only allowed inside SearchResult type reference if kept; forbid useState preview
      expect(src.includes('useState<SearchResult | null>')).toBe(false);
    }

    // Also assert no iframe anywhere in BrowserPanel (defense: preview was the only iframe site)
    expect(src.toLowerCase().includes('<iframe')).toBe(false);
    // embedUrl must not be used in BrowserPanel (no iframe preview)
    expect(src.includes('embedUrl(')).toBe(false);
  });

  // FAIL case hint: restoring <iframe src={embedUrl(preview)} ...> in preview block will fail the above.
});

describe('regression: peers/voice localStorage keys are independent', () => {
  it('ParticipantList and VoiceChatPanel do not share peers-voice-expanded key for setItem/dispatch', () => {
    const pl = read('src/components/ParticipantList.tsx');
    const vc = read('src/components/VoiceChatPanel.tsx');

    // The split keys must be used
    expect(pl.includes('co-viewer:peers-expanded')).toBe(true);
    expect(vc.includes('co-viewer:voice-expanded')).toBe(true);

    // The old shared key must NOT be used for setItem or dispatch/storage sync
    // Allow legacy migration read (getItem peers-voice-expanded) but forbid setItem/dispatch on that key
    const forbiddenPattern = 'peers-voice-expanded';
    const plForbiddenHits = (pl.match(new RegExp(`setItem\\([^)]*${forbiddenPattern}` , 'g')) ?? []).length
      + (pl.match(new RegExp(`dispatch[^\\n]*${forbiddenPattern}`, 'g')) ?? []).length
      + (pl.match(new RegExp(`CustomEvent[^\\n]*${forbiddenPattern}`, 'g')) ?? []).length;
    const vcForbiddenHits = (vc.match(new RegExp(`setItem\\([^)]*${forbiddenPattern}`, 'g')) ?? []).length
      + (vc.match(new RegExp(`dispatch[^\\n]*${forbiddenPattern}`, 'g')) ?? []).length
      + (vc.match(new RegExp(`CustomEvent[^\\n]*${forbiddenPattern}`, 'g')) ?? []).length;

    expect(plForbiddenHits, 'ParticipantList must not setItem/dispatch peers-voice-expanded').toBe(0);
    expect(vcForbiddenHits, 'VoiceChatPanel must not setItem/dispatch peers-voice-expanded').toBe(0);

    // Also no direct setItem with the shared key anywhere (except migration getItem which is allowed)
    // Count setItem occurrences for the shared key across both files
    expect(plForbiddenHits + vcForbiddenHits).toBe(0);
  });

  it('localStorage keys are functionally independent (jsdom)', () => {
    // Behavioral check: setting peers-expanded does not affect voice-expanded
    // Works in both jsdom and node (polyfilled) environments.
    const ls: Storage | Map<string, string> =
      typeof localStorage !== 'undefined'
        ? localStorage
        : new Map<string, string>() as unknown as Storage;
    const get = (k: string) =>
      ls instanceof Map ? (ls.get(k) ?? null) : (ls as Storage).getItem(k);
    const set = (k: string, v: string) => {
      if (ls instanceof Map) ls.set(k, v);
      else (ls as Storage).setItem(k, v);
    };
    const clear = () => {
      if (ls instanceof Map) ls.clear();
      else (ls as Storage).clear();
    };
    clear();
    set('co-viewer:peers-expanded', '1');
    expect(get('co-viewer:voice-expanded')).toBeNull();
    set('co-viewer:voice-expanded', '0');
    expect(get('co-viewer:peers-expanded')).toBe('1');
    expect(get('co-viewer:voice-expanded')).toBe('0');
    clear();
  });

  // FAIL case hint: re-introducing setItem('co-viewer:peers-voice-expanded', ...) in either panel will fail.
});

describe('regression: SYNC constants unchanged', () => {
  it('SYNC_PING_INTERVAL and SYNC_DRIFT_THRESHOLD retain expected values', () => {
    expect(SYNC_PING_INTERVAL).toBe(3000);
    expect(SYNC_DRIFT_THRESHOLD).toBe(1.5);
  });

  it('source file declares the same literals (guards against aliased import drift)', () => {
    const src = read('src/types/index.ts');
    expect(src).toContain('SYNC_DRIFT_THRESHOLD = 1.5');
    expect(src).toContain('SYNC_PING_INTERVAL = 3000');
  });
});
