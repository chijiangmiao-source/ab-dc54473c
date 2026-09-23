// verify.mjs — 单次校验服务：
//   1) 构建检查（全部 JS 语法通过、模块可加载）
//   2) 代码测试（node --test）
//   3) 场景复算：并发幂等、异参冲突、断链边界、崩溃原子性
//   4) HTTP 冒烟：/healthz 与页面资源
// 任一步失败即以非零退出码结束。
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readdirSync, statSync } from 'node:fs';
import http from 'node:http';
import assert from 'node:assert/strict';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;
function step(name) {
  process.stdout.write(`\n=== ${name} ===\n`);
}
function ok(msg) { process.stdout.write(`  ✔ ${msg}\n`); }
function fail(msg) { failures++; process.stderr.write(`  ✘ ${msg}\n`); }

function run(cmd, args) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd: ROOT, stdio: 'inherit', env: process.env });
    p.on('exit', (code) => resolve(code));
  });
}

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (name.endsWith('.js') || name.endsWith('.mjs')) out.push(p);
  }
  return out;
}

async function buildCheck() {
  step('构建检查：语法与模块加载');
  const files = [...walk(join(ROOT, 'public')), ...walk(join(ROOT, 'server'))];
  for (const f of files) {
    const code = await run(process.execPath, ['--check', f]);
    if (code !== 0) { fail(`语法错误：${f}`); return false; }
  }
  ok(`已检查 ${files.length} 个 JS 文件`);
  // 浏览器模块在 Node 下可直接加载（无 DOM 顶层依赖）
  await import('../public/chain.js');
  await import('../public/storage.js');
  ok('核心模块可加载');
  return true;
}

async function unitTests() {
  step('代码测试：node --test');
  const code = await run(process.execPath, ['--test', 'test/']);
  if (code !== 0) { fail('单元测试失败'); return false; }
  ok('单元测试全部通过');
  return true;
}

// ---- 场景复算（与测试环境一致的最小浏览器模拟） ----
function installWebLocks() {
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
function createSharedStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    _map: map
  };
}
function session(id) {
  const m = new Map([['witness.tabId', id]]);
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)) };
}

async function scenarioRecompute() {
  step('场景复算：并发幂等 / 异参冲突 / 断链边界 / 崩溃原子性');
  installWebLocks();
  const { LedgerStore, LedgerError } = await import('../public/storage.js');
  const { verifyChain, GENESIS_DIGEST } = await import('../public/chain.js');
  const RECORDS_KEY = 'witness.records.v1';
  const PENDING_KEY = 'witness.pending.v1';
  let t = 0;
  const mkTab = (shared, id) => new LedgerStore({
    storage: shared, sessionStorage: session(id), now: () => 1700000000000 + (++t)
  });
  const f = (opId, patch = {}) => ({
    instrument: 'Co-60', dose: 250, operator: '张三', opId, ...patch
  });
  const read = (s) => JSON.parse(s.getItem(RECORDS_KEY) || '[]');

  try {
    // A. 并发幂等：三标签页同操作标识同内容
    let shared = createSharedStorage();
    const tabs = [mkTab(shared, 'a'), mkTab(shared, 'b'), mkTab(shared, 'c')];
    await Promise.all(tabs.map((x) => x.init()));
    const rs = await Promise.all(tabs.map((x) => x.submit(f('idem-1'))));
    assert.equal(read(shared).length, 1);
    assert.deepEqual(rs.map((r) => r.record.seq), [1, 1, 1]);
    assert.equal(rs.filter((r) => r.duplicated).length, 2);
    ok('并发幂等：同标识同内容仅落一条，重试返回原记录');

    // B. 异参冲突：稳定拒绝，链头不变，链仍可追加
    const headBefore = read(shared)[0].digest;
    await assert.rejects(() => tabs[0].submit(f('idem-1', { dose: 300 })),
      (e) => e instanceof LedgerError && e.code === 'CONFLICT');
    await assert.rejects(() => tabs[1].submit(f('idem-1', { operator: '李四' })),
      (e) => e instanceof LedgerError && e.code === 'CONFLICT');
    assert.equal(read(shared)[0].digest, headBefore);
    const next = await tabs[2].submit(f('idem-2'));
    assert.equal(next.record.seq, 2);
    assert.equal(next.record.prevDigest, headBefore);
    assert.ok((await verifyChain(read(shared))).ok);
    ok('异参冲突：复用被拒绝，可信链头不变，后续追加正常');

    // C. 断链边界：篡改序号 2 内容
    for (const oid of ['b1', 'b2', 'b3', 'b4']) {
      await tabs[0].submit(f(oid));
    }
    const tampered = read(shared);
    const trustedHead = tampered[0]; // 序号 1 为最后可信记录
    tampered[1].dose = 888; // 序号 2 内容被改、摘要未变
    shared.setItem(RECORDS_KEY, JSON.stringify(tampered));
    const witness = mkTab(shared, 'd');
    const st = await witness.init();
    assert.equal(st.verdict.ok, false);
    assert.equal(st.broken.firstBadSeq, 2);
    assert.equal(st.verdict.head.digest, trustedHead.digest);
    assert.equal(st.verdict.trusted.length, 1);
    assert.equal(st.verdict.suffix.length, 5);
    await assert.rejects(() => witness.submit(f('after')),
      (e) => e instanceof LedgerError && e.code === 'CHAIN_BROKEN');
    assert.equal(read(shared).length, 6, '冻结后记录数不变');
    ok('断链边界：定位首个坏序号 2、隔离后缀、禁止追加并保留最后可信链头');

    // 从创世复算全链（干净库），确认仅靠记录数据即可复原
    const clean = createSharedStorage();
    const ctab = mkTab(clean, 'x');
    await ctab.init();
    const r1 = await ctab.submit(f('g1'));
    assert.equal(r1.record.prevDigest, GENESIS_DIGEST);
    await ctab.submit(f('g2'));
    const v = await verifyChain(read(clean));
    assert.ok(v.ok);
    assert.equal(v.head.seq, 2);
    ok('从创世记录复算全链成功');

    // D. 崩溃原子性：两个崩溃点
    const s1 = createSharedStorage();
    s1.setItem(PENDING_KEY, JSON.stringify({
      tx: { stage: 'prepared', tabId: 'dead', fields: f('ghost') }
    }));
    const reopen1 = mkTab(s1, 'new');
    await reopen1.init();
    assert.equal(read(s1).length, 0);
    assert.equal(s1.getItem(PENDING_KEY), null);
    const first = await reopen1.submit(f('real'));
    assert.equal(first.record.seq, 1);
    ok('崩溃点A：待决未落库 → 完全无记录，序号不被占用');

    const s2 = createSharedStorage();
    const tab2 = mkTab(s2, 'm');
    await tab2.init();
    const { record } = await tab2.submit(f('committed'));
    s2.setItem(PENDING_KEY, JSON.stringify({
      tx: { stage: 'prepared', tabId: 'm', fields: f('committed') }
    }));
    const reopen2 = mkTab(s2, 'n');
    await reopen2.init();
    const recs = read(s2);
    assert.equal(recs.length, 1);
    assert.equal(recs[0].digest, record.digest);
    assert.ok((await verifyChain(recs)).ok);
    ok('崩溃点B：完整落库后关闭 → 完整记录保留，链可复算');
  } catch (e) {
    fail(`场景复算失败：${e.stack || e.message}`);
    return false;
  }
  return true;
}

// ---- HTTP 冒烟 ----
function get(port, path) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('timeout')));
  });
}

async function smoke() {
  step('HTTP 冒烟：启动服务并探测端点');
  const port = 8099;
  const server = spawn(process.execPath, [join(ROOT, 'server', 'index.js')], {
    cwd: ROOT,
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port) },
    stdio: ['ignore', 'pipe', 'inherit']
  });
  await new Promise((r) => setTimeout(r, 600));
  let passed = true;
  try {
    const h = await get(port, '/healthz');
    assert.equal(h.status, 200);
    assert.match(h.headers['content-type'], /application\/json/);
    assert.deepEqual(JSON.parse(h.body), { status: 'ok' });
    ok('GET /healthz → 200 {"status":"ok"}');

    const home = await get(port, '/');
    assert.equal(home.status, 200);
    assert.match(home.headers['content-type'], /text\/html/);
    assert.match(home.body, /辐照实验见证台账/);
    assert.match(home.body, /app\.js/);
    ok('GET / → 200 台账页面');

    const app = await get(port, '/app.js');
    assert.equal(app.status, 200);
    assert.match(app.headers['content-type'], /javascript/);
    assert.match(app.body, /LedgerStore/);
    ok('GET /app.js → 200 页面脚本');

    const chain = await get(port, '/chain.js');
    assert.equal(chain.status, 200);
    assert.match(chain.body, /verifyChain/);
    ok('GET /chain.js → 200 链模块');

    const nf = await get(port, '/../package.json');
    assert.ok(nf.status === 403 || nf.status === 404, `越界访问应被拒绝，实际 ${nf.status}`);
    ok('目录穿越访问被拒绝');

    const nf2 = await get(port, '/no-such-path');
    assert.equal(nf2.status, 404);
    ok('未知路径 → 404');
  } catch (e) {
    fail(`HTTP 冒烟失败：${e.message}`);
    passed = false;
  } finally {
    server.kill('SIGTERM');
    await new Promise((r) => server.on('exit', r));
  }
  return passed;
}

const results = [];
results.push(await buildCheck());
results.push(await unitTests());
results.push(await scenarioRecompute());
results.push(await smoke());

process.stdout.write('\n========================================\n');
if (results.every(Boolean) && failures === 0) {
  process.stdout.write('verify 通过：构建检查、代码测试、场景复算与 HTTP 冒烟全部成功\n');
  process.exit(0);
}
process.stderr.write(`verify 失败（${failures} 个错误）\n`);
process.exit(1);
