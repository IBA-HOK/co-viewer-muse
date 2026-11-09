import { describe, expect, it } from 'vitest';
import { buildNicoEmbedSrc } from './hooks/useNiconicoPlayer';

describe('buildNicoEmbedSrc', () => {
  it('includes jsapi, playerId, referer and from params', () => {
    const src = buildNicoEmbedSrc('sm9', 'nico-abc', 'http://192.168.1.10:8000/');
    expect(src).toContain('embed.nicovideo.jp/watch/sm9');
    expect(src).toContain('jsapi=1');
    expect(src).toContain('playerId=nico-abc');
    expect(src).toContain('referer=' + encodeURIComponent('http://192.168.1.10:8000/'));
    expect(src).toContain('from=0');
  });

  it('url-encodes the referer so it cannot leak extra query params', () => {
    const src = buildNicoEmbedSrc('sm9', 'p1', 'http://a.b/?x=1&y=2');
    // The raw '&' from the referer must be encoded, not parsed as a separate param.
    expect(src).not.toContain('y=2');
    expect(src).toContain(encodeURIComponent('http://a.b/?x=1&y=2'));
  });
});
