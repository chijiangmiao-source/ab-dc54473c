// storage.test.js — 持久化层：并发裁决、幂等、冲突、崩溃恢复、断链冻结
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { LedgerStore, LedgerError } from '../public/storage.js';
import { verifyChain } from '../public/chain.js';
import {
  installWebLocks, createSharedStorage, createSessionStorage,
  PENDING_KEY, RECORDS_KEY
} from './helpers.mjs';

installWebLocks();

let clock;
function makeTab(shared, id) {
  clock = clock || 0;
  return new LedgerStore({
    storage: shared,
    sessionStorage: createSessionStorage(id),
    now: () => 1700000000000 + (++clock)
  });
}

const fields = (opId, patch = {}) => ({
  instrument: 'Co-60', dose: 250, operator: '张三', opId, ...patch
});

function readRecords(shared) {
  return JSON.parse(shared.getItem(RECORDS_KEY) || '[]');
}
function readPending(shared) {
  return JSON.parse(shared.getItem(PENDING_KEY) || '{}');
}

let shared;
beforeEach(async () => {
  clock = 0;
  shared = createSharedStorage();
});

test('串行追加获得连续序号且全链可复算', async () => {
  const tab = makeTab(shared, 't1');
  await tab.init();
  for (let i = 1; i <= 4; i++) {
    const { record, duplicated } = await tab.submit(fields(`op-${i}`));
    assert.equal(record.seq, i);
    assert.equal(duplicated, false);
  }
  const v = await verifyChain(readRecords(shared));
  assert.ok(v.ok);
  assert.equal(v.head.seq, 4);
});

test('多标签页并发：同一操作标识同内容重试只落一条且返回原记录', async () => {
  const tabs = [makeTab(shared, 'a'), makeTab(shared, 'b'), makeTab(shared, 'c')];
  await Promise.all(tabs.map((t) => t.init()));
  const results = await Promise.all(tabs.map((t) => t.submit(fields('same-op'))));
  const seqs = results.map((r) => r.record.seq);
  assert.deepEqual(seqs, [1, 1, 1]);
  assert.deepEqual(results.map((r) => r.duplicated).sort(), [false, true, true]);
  assert.equal(readRecords(shared).length, 1);
  // 迟到重试仍然幂等
  const late = await tabs[0].submit(fields('same-op'));
  assert.equal(late.duplicated, true);
  assert.equal(late.record.seq, 1);
  assert.equal(readRecords(shared).length, 1);
  assert.equal(Object.keys(readPending(shared)).length, 0);
});

test('多标签页并发：不同操作标识串行裁决，序号连续且链完整', async () => {
  const tabs = [makeTab(shared, 'a'), makeTab(shared, 'b'),
    makeTab(shared, 'c'), makeTab(shared, 'd')];
  await Promise.all(tabs.map((t) => t.init()));
  const N = 20;
  const outcomes = await Promise.all(
    Array.from({ length: N }, (_, i) => tabs[i % tabs.length].submit(fields(`op-${i}`)))
  );
  assert.deepEqual(outcomes.map((o) => o.record.seq).sort((a, b) => a - b),
    Array.from({ length: N }, (_, i) => i + 1));
  assert.equal(readRecords(shared).length, N);
  const v = await verifyChain(readRecords(shared));
  assert.ok(v.ok, '并发后链必须完整可复算');
});

test('异参复用稳定拒绝且不改变可信链头', async () => {
  const tab = makeTab(shared, 'a');
  await tab.init();
  const first = await tab.submit(fields('op-x'));
  const headBefore = first.record.digest;

  await assert.rejects(
    () => tab.submit(fields('op-x', { dose: 300 })),
    (err) => err instanceof LedgerError && err.code === 'CONFLICT'
  );
  await assert.rejects(
    () => tab.submit(fields('op-x', { operator: '李四' })),
    (err) => err instanceof LedgerError && err.code === 'CONFLICT'
  );
  const otherTab = makeTab(shared, 'b');
  await otherTab.init();
  await assert.rejects(
    () => otherTab.submit(fields('op-x', { instrument: 'LINAC-2' })),
    (err) => err instanceof LedgerError && err.code === 'CONFLICT'
  );
  assert.equal(readRecords(shared).length, 1);
  const v = await verifyChain(readRecords(shared));
  assert.ok(v.ok);
  assert.equal(v.head.digest, headBefore, '冲突拒绝后链头摘要不变');

  // 冲突标识不影响其它提交继续追加
  const next = await tab.submit(fields('op-y'));
  assert.equal(next.record.seq, 2);
  assert.equal(next.record.prevDigest, headBefore);
});

test('崩溃边界1：待决期间关闭（记录未写入）→ 重新打开后完全无该记录', async () => {
  // 直接构造“写了待决标记、尚未落库即关闭”的残留状态
  shared.setItem(PENDING_KEY, JSON.stringify({
    'dead-tx': { stage: 'prepared', tabId: 'dead', fields: fields('ghost-op') }
  }));
  const tab = makeTab(shared, 'new');
  await tab.init();
  assert.equal(readRecords(shared).length, 0);
  assert.equal(Object.keys(readPending(shared)).length, 0, '残留待决标记被作废清理');

  const r = await tab.submit(fields('real-op'));
  assert.equal(r.record.seq, 1, '无幽灵记录占位，序号从 1 开始');
});

test('崩溃边界2：完整落库后关闭（标记未清）→ 重开保留完整记录', async () => {
  const tab = makeTab(shared, 'a');
  await tab.init();
  const { record } = await tab.submit(fields('committed-op'));
  // 模拟“记录已原子写入、清除标记前关闭”
  const map = readPending(shared);
  map['late-clear'] = { stage: 'prepared', tabId: 'a', fields: fields('committed-op') };
  shared.setItem(PENDING_KEY, JSON.stringify(map));

  const reopened = makeTab(shared, 'b');
  await reopened.init();
  const records = readRecords(shared);
  assert.equal(records.length, 1);
  assert.equal(records[0].opId, 'committed-op');
  assert.equal(records[0].digest, record.digest);
  assert.equal(Object.keys(readPending(shared)).length, 0);
  const v = await verifyChain(records);
  assert.ok(v.ok);
});

test('提交写入顺序：先待决标记，后完整记录，且记录仅一次写入', async () => {
  const order = [];
  const spy = {
    getItem: (k) => shared.getItem(k),
    setItem: (k, v) => { order.push(k); shared.setItem(k, v); }
  };
  const tab = new LedgerStore({
    storage: spy,
    sessionStorage: createSessionStorage('spy'),
    now: () => 1700000000001
  });
  await tab.init();
  order.length = 0;
  await tab.submit(fields('order-op'));
  const firstPending = order.indexOf(PENDING_KEY);
  const firstRecord = order.indexOf(RECORDS_KEY);
  assert.ok(firstPending !== -1 && firstRecord !== -1);
  assert.ok(firstPending < firstRecord, '待决标记必须早于记录写入');
  assert.equal(order.filter((k) => k === RECORDS_KEY).length, 1, '记录整体一次写入');
});

test('断链：篡改中间记录后定位首个坏序号、隔离后缀、冻结追加', async () => {
  const tab = makeTab(shared, 'a');
  await tab.init();
  for (let i = 1; i <= 4; i++) await tab.submit(fields(`op-${i}`));
  const goodHead = readRecords(shared)[1]; // 序号 2

  const tampered = readRecords(shared);
  tampered[2].dose = 9999; // 改序号 3 的业务内容但保留原摘要
  shared.setItem(RECORDS_KEY, JSON.stringify(tampered));

  const reopened = makeTab(shared, 'b');
  await reopened.init();
  const state0 = reopened.state();
  assert.equal(state0.verdict.ok, false);
  assert.equal(state0.broken.firstBadSeq, 3);
  assert.equal(state0.broken.reason, '摘要不符');
  assert.equal(state0.verdict.head.seq, 2);
  assert.equal(state0.verdict.head.digest, goodHead.digest);
  assert.equal(state0.verdict.trusted.length, 2);
  assert.equal(state0.verdict.suffix.length, 2);

  await assert.rejects(
    () => reopened.submit(fields('op-after-break')),
    (err) => err instanceof LedgerError && err.code === 'CHAIN_BROKEN'
  );
  assert.equal(readRecords(shared).length, 4, '冻结后存储不变');

  // 再开标签页结论一致，并仍展示最后可信链头
  const another = makeTab(shared, 'c');
  const state1 = await another.init();
  assert.equal(state1.broken.firstBadSeq, 3);
  assert.equal(state1.verdict.head.digest, goodHead.digest);
  await assert.rejects(() => another.submit(fields('x')), /禁止追加/);
});

test('重开页面可从创世记录复算全链', async () => {
  const tab = makeTab(shared, 'a');
  await tab.init();
  await tab.submit(fields('op-1'));
  await tab.submit(fields('op-2'));
  const before = readRecords(shared);

  const reopened = makeTab(shared, 'z');
  const state = await reopened.init();
  assert.ok(state.verdict.ok);
  assert.equal(state.verdict.head.seq, 2);
  assert.equal(state.verdict.head.digest, before[1].digest);
});
