// node:crypto on a page. The engines import createHash for the editor's lineup version, which no
// page asks for.
export function createHash() {
  throw new Error("createHash is not available on a page.");
}
