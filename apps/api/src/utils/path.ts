/**
 * Extracts pathname and strips trailing slashes without allocating arrays from split('?')
 * or running regular expressions.
 */
export function getNormalizedPath(url: string): string {
  if (!url) {
    return '/';
  }
  const queryIndex = url.indexOf('?');
  const path = queryIndex === -1 ? url : url.slice(0, queryIndex);
  let end = path.length;
  while (end > 1 && path.charCodeAt(end - 1) === 47 /* '/' */) {
    end--;
  }
  return end === path.length ? path || '/' : path.slice(0, end) || '/';
}
