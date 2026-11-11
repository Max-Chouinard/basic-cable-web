// node:path on a page: dirname alone, for the editor's cache file helper, which no page calls.
export function dirname(path) {
  const text = String(path).replace(/[\\/]+$/, "");
  const at = Math.max(text.lastIndexOf("/"), text.lastIndexOf("\\"));
  return at <= 0 ? "." : text.slice(0, at);
}
