/**
 * Build a niconico thumbnail URL from a video ID.
 *
 * The legacy `tn.smilevideo.jp` host no longer serves images. The CDN endpoint
 * takes the numeric part of the ID twice (path/file). IDs such as `sm9`,
 * `nm0012` and `so12345` therefore map to `.../thumbnails/9/9`,
 * `.../thumbnails/12/12` and `.../thumbnails/12345/12345`.
 *
 * Returns an empty string when no numeric ID can be extracted so callers can
 * keep showing their existing placeholder instead of requesting a bogus URL.
 */
export function nicoThumbnailUrl(videoId: string): string {
  const match = /^(?:sm|nm|so)(\d+)$/.exec(videoId);
  if (!match) return '';
  const numericId = match[1].replace(/^0+/, '') || '0';
  return `https://nicovideo.cdn.nimg.jp/thumbnails/${numericId}/${numericId}`;
}
