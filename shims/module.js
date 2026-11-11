// node:module on a page, written by tools/build-web.mjs: require() finds a wrapped engine by its file name.
import engine0 from "../shared/filler.cjs.js";
import engine1 from "../shared/nostalgex-channel-filter.cjs.js";
import engine2 from "../shared/nostalgex-daily-manifest.cjs.js";
import engine3 from "../shared/seasons.cjs.js";
import engine4 from "../shared/slot-packer.cjs.js";
import engine5 from "../shared/time-filter.cjs.js";
const engines = { "filler.cjs": engine0, "nostalgex-channel-filter.cjs": engine1, "nostalgex-daily-manifest.cjs": engine2, "seasons.cjs": engine3, "slot-packer.cjs": engine4, "time-filter.cjs": engine5 };
export function createRequire() {
  return (spec) => {
    const name = String(spec).split("/").pop();
    if (!(name in engines)) throw new Error(`The page has no module named ${name}.`);
    return engines[name];
  };
}
