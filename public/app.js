// app.js — 页面交互
import { LedgerStore, LedgerError } from './storage.js';
import { GENESIS_DIGEST } from './chain.js';

const $ = (id) => document.getElementById(id);

const store = new LedgerStore();

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function shortDigest(d) {
  return d === GENESIS_DIGEST ? 'GENESIS' : d.slice(0, 12) + '…';
}

function rowHtml(r, suffix = false) {
  if (r.corrupted) {
    return `
    <tr${suffix ? ' class="suffix"' : ''}>
      <td class="seq">${esc(r.seq)}</td>
      <td colspan="6">⚠ 该位置的持久化数据无法解析（JSON 损坏）</td>
    </tr>`;
  }
  return `
    <tr${suffix ? ' class="suffix"' : ''}>
      <td class="seq">${esc(r.seq)}</td>
      <td>${esc(r.instrument)}</td>
      <td>${esc(r.dose)}</td>
      <td>${esc(r.operator)}</td>
      <td>${esc(r.opId)}</td>
      <td class="digest"><div class="trunc" title="${esc(r.prevDigest)}">${esc(shortDigest(r.prevDigest))}</div></td>
      <td class="digest"><div class="trunc" title="${esc(r.digest)}">${esc(shortDigest(r.digest))}</div></td>
    </tr>`;
}

function render(state) {
  const { records, verdict, broken, pending } = state;

  // 断链提示：定位首个坏序号并展示最后可信链头
  const banners = $('banners');
  if (broken) {
    banners.innerHTML = `
      <div class="banner bad">
        <strong>检测到链损坏：首个坏序号为 ${esc(broken.firstBadSeq)}（${esc(broken.reason)}）。</strong><br/>
        自该记录起的后缀已隔离，提交功能已冻结；最后一个可信链头为
        序号 ${esc(broken.head.seq)}（${esc(broken.head.seq === 0 ? 'GENESIS' : shortDigest(broken.head.digest))}）。
      </div>`;
    $('submitBtn').disabled = true;
    $('formCard').style.opacity = '.7';
  } else {
    banners.innerHTML = '';
    $('submitBtn').disabled = false;
    $('formCard').style.opacity = '1';
  }

  $('headBox').textContent = verdict.ok
    ? `seq=${verdict.head.seq}  digest=${verdict.head.digest}`
    : `seq=${verdict.head.seq}  digest=${verdict.head.digest}  （最后可信链头）`;

  const body = $('chainBody');
  body.innerHTML = verdict.trusted.map((r) => rowHtml(r)).join('');
  $('emptyHint').hidden = verdict.trusted.length !== 0;

  const suffixCard = $('suffixCard');
  if (!verdict.ok && verdict.suffix.length) {
    suffixCard.hidden = false;
    $('suffixBody').innerHTML = verdict.suffix.map((r) => rowHtml(r, true)).
      join('');
  } else {
    suffixCard.hidden = true;
    $('suffixBody').innerHTML = '';
  }

  // 本标签页尚未落库的状态
  const pbox = $('pendingBox');
  if (pending.length) {
    pbox.textContent = `本标签页待决（尚未落库）：${pending
      .map((p) => `${p.instrument}/${p.dose}Gy/${p.operator} [${p.opId}]`)
      .join('；')}`;
  } else {
    pbox.textContent = '';
  }
}

store.addEventListener('snapshot', (e) => render(e.detail));

async function boot() {
  try {
    await store.init();
    render(store.state());
  } catch (e) {
    $('banners').innerHTML = `<div class="browser bad">初始化失败：${esc(e.message)}</div>`;
  }
}

$('ledgerForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('submitBtn');
  const msg = $('formMsg');
  btn.disabled = true;
  msg.className = 'msg';
  msg.textContent = '裁决中…';
  try {
    const { record, duplicated } = await store.submit({
      instrument: e.target.instrument.value,
      dose: e.target.dose.value,
      operator: e.target.operator.value,
      opId: e.target.opId.value
    });
    msg.className = 'msg ok';
    msg.textContent = duplicated
      ? `幂等命中：返回原记录（序号 ${record.seq}），未新增记录。`
      : `已落库：连续序号 ${record.seq}，摘要 ${record.digest.slice(0, 16)}…`;
    if (!duplicated) e.target.reset();
    render(store.state());
  } catch (err) {
    msg.className = 'msg err';
    if (err instanceof LedgerError) {
      msg.textContent = err.message;
    } else {
      msg.textContent = `提交被拒绝：${err.message}`;
    }
    render(store.state());
  } finally {
    btn.disabled = Boolean(store.state().broken);
  }
});

boot();
