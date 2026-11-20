/** One place that turns a page path into a link href, so a path with `#`, `?`
 *  or spaces cannot silently break a link in one surface and not another. */
export function encodeWikiPath(path: string): string {
  return encodeURIComponent(path);
}

export function wikiPageHref(path: string): string {
  return `/wiki/page?path=${encodeWikiPath(path)}`;
}
