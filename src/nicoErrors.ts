/**
 * Niconico embed error classification.
 *
 * The official embed player (`embed.nicovideo.jp`, jsapi=1) reports failures
 * through a single `error` postMessage event whose `data.code` is one of only
 * two documented values:
 *   - `externally_unwatchable`: the uploader disabled embedding, or the video is
 *     premium / channel-member / PPV only — the embed can never play it.
 *   - `possibly_deleted_video`: a LOSSY catch-all. It fires for videos that are
 *     deleted, set to private (非公開), members-only, age/sensitive-gated, or
 *     region-locked. The embed cannot distinguish these, so we describe the
 *     whole family rather than claiming a specific cause.
 *
 * We surface two distinct, actionable messages so a guest understands that the
 * co-viewer relays only playback *control* (not the video bytes) and that the
 * block originates from Niconico's own access rules.
 */
export interface NicoError {
  /** Raw code reported by the embed; empty string when none was provided. */
  code: string;
  /** Short headline shown in the overlay. */
  title: string;
  /** Explanatory detail shown beneath the headline. */
  detail: string;
}

const EXTERNALLY_UNWATCHABLE = 'externally_unwatchable';

export function classifyNicoError(rawCode: unknown): NicoError {
  const code = typeof rawCode === 'string' ? rawCode : '';

  if (code === EXTERNALLY_UNWATCHABLE) {
    return {
      code,
      title: 'この動画は外部再生に対応していません',
      detail:
        '投稿者が外部プレーヤーでの再生を許可していないか、プレミアム・チャンネル会員・有料(PPV)限定の動画です。ニコニコで直接開くと視聴できる場合があります。',
    };
  }

  // Possibly deleted/private/members-only/age/region — indistinguishable on the embed.
  return {
    code,
    title: 'この動画は再生できません（削除・非公開・限定公開の可能性）',
    detail:
      '削除されたか、非公開・限定公開に設定されている可能性があります。このアプリは操作信号のみを同期するため、視聴制限のある動画はゲスト側でも再生できません。ニコニコで直接開いて視聴できるか確認してください。',
  };
}
