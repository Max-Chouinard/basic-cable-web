// node:fs on a page. The library reader imports it for the editor's cache file, which no page
// reads or writes: the page keeps its library in IndexedDB (web/src/store.js).
function none(name) {
  return () => {
    throw new Error(`${name} is not available on a page.`);
  };
}
export const existsSync = () => false;
export const readFileSync = none("readFileSync");
export const writeFileSync = none("writeFileSync");
export const mkdirSync = none("mkdirSync");
export const renameSync = none("renameSync");
export const rmSync = none("rmSync");
