export const PREVIEW_ROBOTS = 'noindex, nofollow, noarchive, nosnippet';

/** Preview indexing is opt-in so an ordinary production build stays crawlable. */
export function isPreviewBuild(): boolean {
  return process.env.NEXT_PUBLIC_BUILD_MODE === 'preview';
}

export function robotsMetadata(indexable: boolean): {
  index: boolean;
  follow: boolean;
  noarchive?: boolean;
  nosnippet?: boolean;
} {
  if (isPreviewBuild()) {
    return { index: false, follow: false, noarchive: true, nosnippet: true };
  }
  return { index: indexable, follow: true };
}
