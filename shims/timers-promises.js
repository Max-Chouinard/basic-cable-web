// node:timers/promises on a page: the setTimeout the link-code poll waits with, signal included.
export function setTimeout(ms, value, { signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = globalThis.setTimeout(() => {
      signal?.removeEventListener("abort", stop);
      resolve(value);
    }, ms);
    function stop() {
      globalThis.clearTimeout(timer);
      reject(signal.reason);
    }
    signal?.addEventListener("abort", stop, { once: true });
  });
}
