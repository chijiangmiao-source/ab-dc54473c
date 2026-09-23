// chain.test.js — 哈希与链规则单元测试
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  sha256Hex, sha256Fallback, canonicalLine, buildRecord,
  verifyChain, GENESIS_DIGEST
} from '../public/chain.js';

const ref = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

test('SHA-256 回退实现与参考实现一致（含空串/中文/emoji）', () => {
  for (const s of ['', 'abc', '辐照剂量 250Gy', '😀'.repeat(100), 'a'.repeat(1000)]) {
    assert.equal(sha256Fallback(s), ref(s));
  }
});

test('异步 sha256Hex 与参考实现一致', async () => {
  assert.equal(await sha256Hex(''), ref(''));
  assert.equal(await sha256Hex('Co-60|250|张三|op-1|1700000000000'),
    ref('Co-60|250|张三|op-1|1700000000000'));
});

test('记录按规范化业务内容+序号+前序摘要计算摘要', async () => {
  const r = await buildRecord(
    { instrument: ' Co-60 ', dose: '250', operator: '张三', opId: 'op-1', timestamp: 1700000000000 },
    1, GENESIS_DIGEST
  );
  assert.equal(r.instrument, 'Co-60');
  assert.equal(r.dose, 250);
  assert.equal(r.prevDigest, GENESIS_DIGEST);
  assert.equal(r.digest, ref('Co-60|250|张三|op-1|1700000000000|1|GENESIS'));
});

test('剂量必须为正整数；字段不能为空或含竖线/控制字符', async () => {
  const base = { instrument: 'X', dose: 1, operator: 'o', opId: 'id', timestamp: 1 };
  await assert.rejects(() => buildRecord({ ...base, dose: 0 }, 1, GENESIS_DIGEST), /正整数/);
  await assert.rejects(() => buildRecord({ ...base, dose: 1.5 }, 1, GENESIS_DIGEST), /正整数/);
  await assert.rejects(() => buildRecord({ ...base, dose: '12abc' }, 1, GENESIS_DIGEST), /正整数/);
  await assert.rejects(() => buildRecord({ ...base, instrument: '  ' }, 1, GENESIS_DIGEST), /仪器/);
  await assert.rejects(() => buildRecord({ ...base, opId: 'a|b' }, 1, GENESIS_DIGEST), /竖线/);
  await assert.rejects(() => buildRecord({ ...base, operator: 'a\nb' }, 1, GENESIS_DIGEST), /控制字符/);
});

async function makeChain(n) {
  const records = [];
  let prev = GENESIS_DIGEST;
  for (let i = 1; i <= n; i++) {
    const r = await buildRecord(
      { instrument: `dev-${i}`, dose: i * 10, operator: `op${i}`, opId: `oid-${i}`, timestamp: 1700000000000 + i },
      i, prev
    );
    records.push(r);
    prev = r.digest;
  }
  return records;
}

test('verifyChain 接受完整链并给出链头', async () => {
  const records = await makeChain(5);
  const v = await verifyChain(records);
  assert.ok(v.ok);
  assert.equal(v.head.seq, 5);
  assert.equal(v.head.digest, records[4].digest);
  assert.deepEqual(v.trusted, records);
});

test('空链的链头为创世', async () => {
  const v = await verifyChain([]);
  assert.ok(v.ok);
  assert.equal(v.head.seq, 0);
  assert.equal(v.head.digest, GENESIS_DIGEST);
});

test('首条即坏：首个坏序号为 1，链头为创世', async () => {
  const records = await makeChain(3);
  records[0].digest = 'deadbeef';
  const v = await verifyChain(records);
  assert.equal(v.ok, false);
  assert.equal(v.firstBadSeq, 1);
  assert.equal(v.head.seq, 0);
  assert.equal(v.head.digest, GENESIS_DIGEST);
  assert.equal(v.suffix.length, 3);
  assert.equal(v.trusted.length, 0);
});

test('中间记录业务内容被改：定位首个坏序号并隔离后缀', async () => {
  const records = await makeChain(4);
  records[1].dose = 999;
  const v = await verifyChain(records);
  assert.equal(v.ok, false);
  assert.equal(v.firstBadSeq, 2);
  assert.equal(v.reason, '摘要不符');
  assert.equal(v.trusted.length, 1);
  assert.equal(v.suffix.length, 3);
  assert.equal(v.head.seq, 1);
  assert.equal(v.head.digest, records[0].digest);
});

test('存储摘要被篡改同样被识别', async () => {
  const records = await makeChain(3);
  records[2].digest = '0'.repeat(64);
  const v = await verifyChain(records);
  assert.equal(v.firstBadSeq, 3);
  assert.equal(v.trusted.length, 2);
  assert.equal(v.suffix[0].seq, 3);
});

test('前序摘要被改（分叉）被识别，且其后全部隔离', async () => {
  const records = await makeChain(3);
  records[1].prevDigest = 'f'.repeat(64);
  const v = await verifyChain(records);
  assert.equal(v.firstBadSeq, 2);
  assert.match(v.reason, /前序摘要/);
  assert.equal(v.suffix.length, 2);
});

test('缺失记录导致序号不连续，定位到缺口处首条', async () => {
  const records = await makeChain(4);
  const spliced = [records[0], records[2], records[3]];
  const v = await verifyChain(spliced);
  assert.equal(v.ok, false);
  assert.equal(v.firstBadSeq, 3);
  assert.equal(v.reason, '序号不连续');
  assert.equal(v.trusted.length, 1);
});

test('从创世记录重算可独立复原链头（仅依赖记录数据）', async () => {
  const records = await makeChain(6);
  const reserialized = JSON.parse(JSON.stringify(records));
  const v = await verifyChain(reserialized);
  assert.ok(v.ok);
  assert.equal(v.head.digest, records[5].digest);
  // 规范化行稳定性
  assert.equal(canonicalLine(records[0]), canonicalLine(reserialized[0]));
});
