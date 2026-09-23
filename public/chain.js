// chain.js — 纯函数：见证台账哈希链核心（Node 与浏览器共享）
//
// 记录结构：
//   { seq, instrument, dose, operator, opId, timestamp, prevDigest, digest }
// 摘要规则：SHA-256(规范化业务内容 + 序号 + 前序摘要)，
// 规范化后的输入为确定性 UTF-8 文本，见 canonicalLine。

const GENESIS_DIGEST = 'GENESIS';

const textEncoder = new TextEncoder();

const hasSubtle = typeof globalThis.crypto?.subtle?.digest === 'function';

export function sha256Hex(message) {
  if (hasSubtle) {
    return globalThis.crypto.subtle
      .digest('SHA-256', textEncoder.encode(message))
      .then((buf) => toHex(buf));
  }
  // 非安全上下文（如 file://）下 crypto.subtle 不可用，使用确定性回退实现。
  return Promise.resolve(sha256Fallback(message));
}

function toHex(buffer) {
  const view = new Uint8Array(buffer);
  let out = '';
  for (let i = 0; i < view.length; i++) out += view[i].toString(16).padStart(2, '0');
  return out;
}

// ---- 确定性 SHA-256（RFC 6234），供非安全上下文使用；与 crypto.subtle 结果一致 ----
// 基于公有领域算法实现，输入按 UTF-8 编码。
function sha256Fallback(message) {
  const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ]);

  const bytes = utf8Bytes(message);
  const bitLen = bytes.length * 8;
  const withPad = ((bytes.length + 9 + 63) >> 6) << 6;
  const buf = new Uint8Array(withPad);
  buf.set(bytes);
  buf[bytes.length] = 0x80;
  const dv = new DataView(buf.buffer);
  // 长度按 64 位大端写入；本台账输入远小于 2^32 位，高 32 位为 0。
  dv.setUint32(withPad - 4, bitLen >>> 0);
  dv.setUint32(withPad - 8, Math.floor(bitLen / 0x100000000));

  const H = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
  ]);
  const W = new Uint32Array(64);

  function rotr(x, n) { return (x >>> n) | (x << (32 - n)); }

  for (let block = 0; block < withPad; block += 64) {
    for (let i = 0; i < 16; i++) W[i] = dv.getUint32(block + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(W[i - 15], 7) ^ rotr(W[i - 15], 18) ^ (W[i - 15] >>> 3);
      const s1 = rotr(W[i - 2], 17) ^ rotr(W[i - 2], 19) ^ (W[i - 2] >>> 10);
      W[i] = (W[i - 16] + s0 + W[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = H;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[i] + W[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0;
      d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b) >>> 0; H[2] = (H[2] + c) >>> 0;
    H[3] = (H[3] + d) >>> 0; H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0;
    H[6] = (H[6] + g) >>> 0; H[7] = (H[7] + h) >>> 0;
  }

  let hex = '';
  for (let i = 0; i < 8; i++) hex += H[i].toString(16).padStart(8, '0');
  return hex;
}

function utf8Bytes(str) {
  const out = [];
  for (let i = 0; i < str.length; i++) {
    let code = str.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < str.length) {
      const next = str.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
        i++;
      }
    }
    if (code < 0x80) out.push(code);
    else if (code < 0x800) out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    else if (code < 0x10000) out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    else out.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 0x3f), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
  }
  return new Uint8Array(out);
}

// 规范化业务字段：trim 后禁止控制字符与换行，避免注入伪造规范化行。
function normField(value, label) {
  const s = String(value ?? '').trim();
  if (!s) throw new Error(`${label}不能为空`);
  if (/[\x00-\x1f\x7f]/.test(s)) throw new Error(`${label}含非法控制字符`);
  if (s.includes('|')) throw new Error(`${label}不能含竖线字符`);
  return s;
}

// 规范化业务内容（不含序号与链字段），稳定可复算。
export function canonicalContent({ instrument, dose, operator, opId, timestamp }) {
  const inst = normField(instrument, '仪器');
  const op = normField(operator, '操作人');
  const oid = normField(opId, '操作标识');
  const doseInt = Number.isInteger(dose) ? dose : Number(String(dose).trim());
  if (!Number.isInteger(doseInt) || doseInt <= 0) throw new Error('剂量必须为正整数');
  const ts = Number.isInteger(timestamp) ? timestamp : Number(timestamp);
  if (!Number.isInteger(ts) || ts <= 0) throw new Error('时间戳非法');
  return `${inst}|${doseInt}|${op}|${oid}|${ts}`;
}

// 参与哈希的规范化行：业务内容 | seq | prevDigest
export function canonicalLine(record) {
  return `${canonicalContent(record)}|${record.seq}|${record.prevDigest}`;
}

export async function digestFor(record) {
  return sha256Hex(canonicalLine(record));
}

// 依据业务字段构造完整记录（字段在此完成规范化与整型化）。
export async function buildRecord(fields, seq, prevDigest) {
  const instrument = normField(fields.instrument, '仪器');
  const operator = normField(fields.operator, '操作人');
  const opId = normField(fields.opId, '操作标识');
  const dose = Number.isInteger(fields.dose)
    ? fields.dose
    : Number(String(fields.dose).trim());
  if (!Number.isInteger(dose) || dose <= 0) throw new Error('剂量必须为正整数');
  const timestamp = Number.isInteger(fields.timestamp)
    ? fields.timestamp
    : Number(fields.timestamp);
  if (!Number.isInteger(timestamp) || timestamp <= 0) throw new Error('时间戳非法');

  const record = { seq, instrument, dose, operator, opId, timestamp, prevDigest };
  record.digest = await digestFor(record);
  return record;
}

// 用户可录入的业务身份（不含时间戳等系统元数据），用于幂等/冲突判定。
export function businessKey(fields) {
  return `${normField(fields.instrument, '仪器')}|${(
    Number.isInteger(fields.dose) ? fields.dose : Number(String(fields.dose).trim())
  )}|${normField(fields.operator, '操作人')}`;
}

// 从创世记录起逐条复算全链。
// 返回 { ok, firstBadSeq?, reason?, trusted, suffix, head }
// head 为最后一个可信记录；空链时为 { seq:0, digest:GENESIS }。
export async function verifyChain(records) {
  const genesisHead = { seq: 0, digest: GENESIS_DIGEST };
  let prevDigest = GENESIS_DIGEST;
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    const fail = (reason) => ({
      ok: false,
      firstBadSeq: r.seq,
      reason,
      trusted: records.slice(0, i),
      suffix: records.slice(i),
      head: i === 0 ? genesisHead : records[i - 1]
    });
    if (r.seq !== i + 1) return fail('序号不连续');
    if (r.prevDigest !== prevDigest) return fail('前序摘要不符');
    let digest;
    try {
      digest = await digestFor(r);
    } catch {
      return fail('记录内容无法规范化');
    }
    if (r.digest !== digest) return fail('摘要不符');
    prevDigest = r.digest;
  }
  return {
    ok: true,
    trusted: records.slice(),
    suffix: [],
    head: records.length === 0 ? genesisHead : records[records.length - 1]
  };
}

export { GENESIS_DIGEST, normField, sha256Fallback, utf8Bytes };
