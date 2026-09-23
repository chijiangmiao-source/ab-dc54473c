// helpers.mjs — 测试用浏览器环境模拟（共享 localStorage、跨标签页 Web Locks）

// 全局限名互斥队列，模拟浏览器 navigator.locks 跨标签页串行裁决。
export function installWebLocks() {
  const queues = new Map();
  globalThis.navigator = globalThis.navigator || {};
  globalThis.navigator.locks = {
    request(name, fn) {
      const prev = queues.get(name) || Promise.resolve();
      const release = prev.then(() => fn(), () => fn());
      queues.set(name, release.then(() => {}, () => {}));
      return release;
    }
  };
}

// 多个标签页共享的 localStorage 语义存储。
export function createSharedStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    _dump: () => new Map(map)
  };
}

export function createSessionStorage(id) {
  const map = new Map();
  if (id) map.set('witness.tabId', id);
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); }
  };
}

export const PENDING_KEY = 'witness.pending.v1';
export const RECORDS_KEY = 'witness.records.v1';
