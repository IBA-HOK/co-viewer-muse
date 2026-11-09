import { describe, expect, it } from 'vitest';
import { classifyNicoError, type NicoError } from './nicoErrors';

const EXTERNAL_TITLE = 'この動画は外部再生に対応していません';
const GATED_TITLE = 'この動画は再生できません（削除・非公開・限定公開の可能性）';

describe('classifyNicoError', () => {
  it('maps externally_unwatchable to the embedding-disabled message', () => {
    const err: NicoError = classifyNicoError('externally_unwatchable');
    expect(err.code).toBe('externally_unwatchable');
    expect(err.title).toBe(EXTERNAL_TITLE);
    expect(err.detail).toContain('プレミアム');
  });

  it('maps possibly_deleted_video to the access-gated catch-all message', () => {
    const err: NicoError = classifyNicoError('possibly_deleted_video');
    expect(err.code).toBe('possibly_deleted_video');
    expect(err.title).toBe(GATED_TITLE);
    expect(err.detail).toContain('ニコニコ');
  });

  it('treats any unknown string code as the access-gated catch-all', () => {
    const err: NicoError = classifyNicoError('some_unknown_code');
    expect(err.code).toBe('some_unknown_code');
    expect(err.title).toBe(GATED_TITLE);
  });

  it('treats missing / non-string codes as the access-gated catch-all with empty code', () => {
    expect(classifyNicoError(undefined).code).toBe('');
    expect(classifyNicoError(null).code).toBe('');
    expect(classifyNicoError(42).code).toBe('');
    expect(classifyNicoError('').code).toBe('');
  });

  it('keeps the two branches visually and semantically distinct (regression guard)', () => {
    expect(EXTERNAL_TITLE).not.toBe(GATED_TITLE);
  });
});
