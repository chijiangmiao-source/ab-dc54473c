// storage.js — 浏览器本地持久化层
//
// 职责：
//   1. 多标签页并发提交在浏览器本地串行裁决（Web Locks 排他锁，本地队列兜底）；
//   2. 提交采用“待决标记 → 追加记录 → 清除标记”的崩溃安全流程，
//      刷新或中途关页后只可能留下完整记录或完全无该记录；
//   3. 每次读取都从创世记录复算全链，发现坏块即隔离后缀、冻结追加；
//   4. 提交成功后通过 BroadcastChannel（及 storage 事件兜底）通知其它标签页。

import { buildRecord, businessKey, verifyChain, GENESIS_DIGEST } from './chain.js';

const LS_RECORDS = 'witness.records.v1';
const LS_PENDING = 'witness.pending.v1';
const CHANNEL = 'witness-ledger-v1';
const LOCK = 'witness-ledger-tx-v1';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function tabId(ss) {
  let id = ss?.getItem('witness.tabId');
  if (!id) {
    id = `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    ss?.setItem('witness.tabId', id);
  }
  return id;
}

export class LedgerError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export class LedgerStore extends EventTarget {
  constructor({
    storage = globalThis.localStorage,
    sessionStorage: sess = globalThis.sessionStorage,
    now = () => Date.now()
  } = {}) {
    super();
    this.storage = storage;
    this.sessionStorage = sess;
    this.now = now;
    this.tabId = tabId(this.sessionStorage);
    this.localQueue = Promise.resolve();
    this.snapshot = {
      records: [],
      verdict: { ok: true, trusted: [], suffix: [], head: { seq: 0, digest: GENESIS_DIGEST } }
    };

    // 跨标签页通知仅在真实浏览器窗口中启用（Node 下不创建，避免事件循环挂起）。
    if (typeof globalThis.window !== 'undefined' &&
        typeof globalThis.BroadcastChannel === 'function') {
      this.channel = new globalThis.BroadcastChannel(CHANNEL);
      this.channel.onmessage = () => { this.refresh(); };
    }
    if (typeof globalThis.window !== 'undefined' &&
        typeof globalThis.addEventListener === 'function') {
      globalThis.addEventListener('storage', (e) => {
        if (e.key === LS_RECORDS || e.key === LS_PENDING) this.refresh();
      });
    }
  }

  // ---- 原始存储访问 ----
  _readRecordsRaw() {
    try {
      const raw = this.storage.getItem(LS_RECORDS);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      // JSON 损坏视同断链：交给上层复算定位（无法定位则整体隔离）。
      return [{ seq: 1, corrupted: true }];
    }
  }

  _writeRecords(records) {
    this.storage.setItem(LS_RECORDS, JSON.stringify(records));
  }

  _readPendingMap() {
    try {
      return JSON.parse(this.storage.getItem(LS_PENDING) || '{}') || {};
    } catch {
      return {};
    }
  }

  _writePendingMap(map) {
    this.storage.setItem(LS_PENDING, JSON.stringify(map));
  }

  _myPending() {
    const map = this._readPendingMap();
    return Object.values(map).filter((p) => p.tabId === this.tabId);
  }

  // 清理上一轮残留的待决标记：到达 init 时此前的页面会话均已结束。
  // 记录已落库则仅删标记；未落库则该尝试作废——任何崩溃点之后
  // 都只可能留下完整记录或完全无记录。
  _recoverPending() {
    if (this.storage.getItem(LS_PENDING)) this.storage.removeItem(LS_PENDING);
  }

  async refresh() {
    const records = this._readRecordsRaw();
    const verdict = await verifyChain(records);
    this.snapshot = { records, verdict };
    this.dispatchEvent(new CustomEvent('snapshot', { detail: this.state() }));
    return this.snapshot;
  }

  async init() {
    await this._exclusive(async () => this._recoverPending());
    await this.refresh();
    return this.state();
  }

  state() {
    const { records, verdict } = this.snapshot;
    return {
      records,
      verdict,
      broken: verdict.ok
        ? null
        : {
            firstBadSeq: verdict.firstBadSeq,
            reason: verdict.reason,
            head: verdict.head,
            suffix: verdict.suffix
          },
      pending: this._myPending().map((p) => p.fields)
    };
  }

  // ---- 串行裁决 ----
  async _exclusive(fn) {
    const run = () => fn();
    if (typeof navigator !== 'undefined' && navigator.locks?.request) {
      return navigator.locks.request(LOCK, run);
    }
    // 兜底：同一页面上下文内排队（现代浏览器均支持 Web Locks）。
    const next = this.localQueue.then(run, run);
    this.localQueue = next.catch(() => {});
    return next;
  }

  // 提交（重复点击/迟到提交安全）。
  // 返回 { record, duplicated }；异参复用抛 CONFLICT，链损坏抛 CHAIN_BROKEN。
  async submit(input) {
    const fields = {
      instrument: input.instrument,
      dose: input.dose,
      operator: input.operator,
      opId: input.opId
    };
    const normalizedKey = businessKey(fields); // 提前校验字段合法性

    return this._exclusive(async () => {
      this._recoverPending();
      const records = this._readRecordsRaw();
      const verdict = await verifyChain(records);
      if (!verdict.ok) {
        throw new LedgerError(
          'CHAIN_BROKEN',
          `链已于序号 ${verdict.firstBadSeq} 处断裂（${verdict.reason}），已禁止追加`
        );
      }

      // 幂等：同一操作标识按规范化业务内容判定。
      const existing = records.find((r) => r.opId === fields.opId.trim());
      if (existing) {
        if (businessKey(existing) === normalizedKey) {
          return { record: existing, duplicated: true };
        }
        throw new LedgerError(
          'CONFLICT',
          `操作标识已用于不同内容（原序号 ${existing.seq}），已拒绝且链头不变`
        );
      }

      // 1) 写入待决标记（本标签页尚未落库的状态，对崩溃恢复可见）。
      const txId = `${this.tabId}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
      const prepared = { stage: 'prepared', tabId: this.tabId, fields: { ...fields } };
      const map = this._readPendingMap();
      map[txId] = prepared;
      this._writePendingMap(map);
      this.dispatchEvent(new CustomEvent('snapshot', { detail: this.state() }));

      // 2) 计算摘要（异步）。此步关闭标签页只会留下待决标记，重启即作废。
      const seq = records.length + 1;
      const record = await buildRecord(
        { ...fields, timestamp: this.now() },
        seq,
        verdict.head.digest
      );

      // 3) 单次 localStorage 写入原子追加完整记录。
      this._writeRecords(records.concat(record));
      // 4) 记录已完整落库后再清除待决标记。
      delete map[txId];
      this._writePendingMap(map);

      await this.refresh();
      this._notifyOthers();
      return { record, duplicated: false };
    });
  }

  _notifyOthers() {
    try { this.channel?.postMessage({ type: 'committed', at: this.now() }); } catch { /* 忽略 */ }
  }
}
