# 辐照实验见证台账

面向多标签页补录场景的防篡改见证台账：哈希链、并发幂等、崩溃原子性与断链隔离。
零第三方运行时依赖，仅需 Node.js ≥ 20。

## 运行

```bash
# 本地
npm start                 # 默认 http://0.0.0.0:8080
HOST=127.0.0.1 PORT=9000 npm start

# Compose（宿主端口可配置）
HOST_PORT=9000 docker compose up --build web
```

- 页面：`/`
- 健康检查：`GET /healthz` → `200 {"status":"ok"}`

## 单次校验服务 verify

复算并发幂等、异参冲突、断链边界，并执行代码测试、构建检查与 HTTP 冒烟，
全部通过以退出码 0 结束，任一失败以非零退出码结束：

```bash
# 本地
npm test                  # 仅代码测试（22 个用例）
npm run verify            # 构建检查 + 代码测试 + 场景复算 + HTTP 冒烟

# Compose（名为 verify 的单次服务）
docker compose build
docker compose run --rm verify
```

## 数据与信任模型

### 记录与摘要

```
记录 = { seq, instrument, dose, operator, opId, timestamp, prevDigest, digest }
规范化内容 = instrument|dose|operator|opId|timestamp     （字段 trim、剂量正整数化）
规范化行   = 规范化内容|seq|prevDigest
digest     = SHA-256(规范化行)
首条记录的 prevDigest = "GENESIS"
```

字段禁止竖线与控制字符，规范化规则在浏览器与 Node 测试间共享（`public/chain.js`）。
页面与校验均从创世记录起逐条复算，不缓存任何信任结论。

### 多标签页串行裁决（`public/storage.js`）

- 所有提交经由跨标签页排他锁（Web Locks `navigator.locks`）串行裁决；
- 锁内先复算全链，再做幂等/冲突判定，最后追加；
- 提交结果通过 `BroadcastChannel`（`storage` 事件兜底）同步到其它标签页。

### 幂等与冲突

- 同一 `opId` + 相同规范化业务内容（仪器/整数剂量/操作人）→ 返回原记录，不新增；
- 同一 `opId` + 不同内容 → 稳定拒绝（`CONFLICT`），可信链头不变；
- 拒绝不产生任何待决或追加，后续正常提交不受影响。

### 崩溃原子性（刷新 / 中途关页）

每个序号只经历一次完整的 `localStorage` 数组写入：

1. 写待决标记 `witness.pending.v1`（本标签页“尚未落库”状态，页面可见）；
2. 计算摘要；
3. 将完整新记录随整个数组一次写入 `witness.records.v1`；
4. 清除待决标记。

重新打开时，在排他锁内清除上一页面会话残留的待决标记：
- 若崩溃发生在步骤 3 之前 → 无记录、序号不被占用（完全无记录）；
- 若发生在步骤 3 之后 → 记录已完整存在（仅清标记）。
因此任何中断后都只留下完整记录或完全无记录。

### 断链检测、定位与隔离

每次读取都从创世记录复算，发现首个不满足
“序号连续 + prevDigest 相接 + digest 重算一致”的位置即：

- 报告 `firstBadSeq` 与原因（序号不连续 / 前序摘要不符 / 摘要不符 / 无法规范化）；
- 将该记录及其后全部作为**后缀隔离**并单独展示；
- 保留并展示**最后一个可信链头**（空链时为创世）；
- 提交入口冻结，任何追加尝试返回 `CHAIN_BROKEN` 且不触达存储。

## 目录结构

```
public/chain.js    规范化、SHA-256（crypto.subtle，含纯 JS 回退）、建块、复算
public/storage.js  串行裁决、幂等/冲突、待决崩溃恢复、断链冻结
public/app.js      页面渲染与交互
public/index.html  台账页面
server/index.js    静态服务 + /healthz（HOST/PORT 可配置）
scripts/verify.mjs 单次校验流程（构建检查/代码测试/场景复算/HTTP 冒烟）
test/              node:test 单元测试（22 个）
docker-compose.yml web（常驻）+ verify（单次，按退出码结束）
```
