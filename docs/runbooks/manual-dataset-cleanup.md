# 数据集手动清理工具

入口：`pnpm -C apps/backend datasets:cleanup`。需 Node.js 22+，先在仓库根目录安装依赖 `pnpm install`。本工具扫描**指定 payer 钱包**的数据集，不会遍历整个网络所有人的数据集。

## 1. 扫描：只读，不需要私钥

在仓库根目录运行；每次扫描使用新输出目录：

```sh
pnpm -C apps/backend datasets:cleanup scan \
  --network calibration \
  --payer 0x305025d07c1dee47f25a4990179eff2becddca0b \
  --out ../../cleanup-runs/calibration-20261003
```

主网将 `--network` 改为 `mainnet` 并使用另外的输出目录。输出包含 `inventory.json`、`summary.json`、`candidates.csv`、`manifest.json`。

扫描固定区块的完整 FWSS 钱包列表，避免翻页过程中有删除导致漏项。读取 PDP live、最后证明、leafCount、终止 epoch、rail 状态，并对每个候选用非服务商地址执行 `eth_call` 模拟删除。

候选类型：

| category | 含义 |
|---|---|
| finalized_deletable | 已终止、锁定期和活动窗口已过、rail 已 finalized |
| fully_settled_deletable | 已终止、锁定期和活动窗口已过、rail 完全结算但尚未 finalized |
| abandoned_deletable | 未终止，但满足 PDP 和 FWSS 的超时弃置条件；删除模拟成功 |
| cleanup_pending | 上次清单中的数据集已从 FWSS 列表消失，但 pieces 尚未清理完成 |

`abandoned_deletable` **允许其他钱包调用**。`pdpEndEpoch=0` 本身不能判断是否允许删除；工具还检查活动窗口，并通过精确删除模拟验证 FWSS 的弃置条件。这类候选仍需结合 Dealbot 保留槽位判断业务上是否应删除，默认执行会排除它们。

已终止但锁定期/活动窗口未过、未结算的 rail、模拟拒绝和读取失败都保留在 inventory 中，不会加入执行清单。`scanComplete=false`、退出码 2 表示有读取未知项，不能把候选数量当作全量结果。

对于上次删除后未完成 pieces 清理的历史数据集，新扫描需添加：

```sh
--previous-manifest ../../cleanup-runs/上次目录/manifest.json
```

它只补查同网络、同 payer 的旧候选，不能从链上当前列表找回所有历史删除记录。

## 2. 核验清单，再执行

钱包需要本网络的 FIL/tFIL 支付 gas，不需要 session key。私钥仅从环境变量读取，不写入清单、日志、进度文件。以下输入方式适用于 zsh，不把私钥写入 shell history：

```sh
read -rs 'MANUAL_CLEANUP_PRIVATE_KEY?Temporary private key: '; echo
export MANUAL_CLEANUP_PRIVATE_KEY

pnpm -C apps/backend datasets:cleanup execute \
  --input ../../cleanup-runs/calibration-20261003/manifest.json \
  --concurrency 8

unset MANUAL_CLEANUP_PRIVATE_KEY
```

`execute` 会真实发送交易，默认处理清单中全部已终止候选。首次可加 `--limit 3`，再去掉 limit 重跑同一命令继续。纳入未终止的弃置候选需明确添加 `--include-abandoned`；**不包含自动 terminateService 操作**。

主网执行必须明确提供 `--network mainnet`，并指向主网 manifest。主网支付的是真实 FIL，本文主网验证仅进行了只读调用。

如需只读模拟和 gas 估算，直接运行底层执行器，不带 `--execute`：

```sh
node apps/backend/scripts/manual-cleanup/cleanup.mjs \
  --input cleanup-runs/calibration-20261003/manifest.json --limit 3
```

指定实际操作钱包可添加 `--wallet-address ADDRESS`；与环境变量私钥对应地址不一致时会拒绝执行。RPC 可通过 `MANUAL_CLEANUP_RPC_URL` 指定，工具验证 chain ID。不要把含密钥的 RPC 地址放在命令行中。

## 3. 并发、重试和断点

默认 8 个数据集并行；同钱包签名和广播按 nonce 排队，确认并发进行。同一数据集必须确认删除后才发送 cleanupPieces，并持续清理到 live=false、且不再处于 cleanup mode。多笔交易可以进入同一高度。

默认每次最多清理 50 个 pieces，gas 估算超过上限时自动缩小批次；交易 gas 在估算基础上增加 20%，默认上限 3,000,000,000。可用 `--batch-size`、`--max-gas` 调整。`--delay-ms` 默认 200，是所有调度 RPC 共享的间隔；回执查询也使用该限速和重试。`--concurrency` 上限为 12，`--confirmations` 默认 1，可按确认深度要求增加。

`state.json` 默认在 manifest 旁边，绑定网络、payer、签名钱包和完整 manifest hash。每笔签名交易在广播前原子保存，包含 raw transaction、nonce、hash。恢复时先按 nonce 重新广播/核验所有保存的交易，再签新交易。**不要修改 manifest、删除 state，或同时使用该钱包发送其他交易。**

临时 RPC 错误指数退避；执行入口自动重启并恢复。同一错误连续五次且没有确认进展，或遇到合约拒绝等确定性错误时停止，保留进度，不会假报完成。修复后重跑同一命令。不会自动替换卡住交易的 gas 费用。

Ctrl-C 停止新提交，等待在途交易处理后退出。程序正常退出会释放锁。进程被强制杀死或机器重启后，先确认相关进程已经不在运行，再删除遗留的 state/supervisor/wallet 锁；保留 state。该工具在本机运行，电脑需保持联网、不休眠。后台运行可重定向 stdout/stderr 保存执行日志，但私钥必须通过进程环境传入。

## 4. 查看进度与验收

```sh
pnpm -C apps/backend datasets:cleanup status \
  --state ../../cleanup-runs/calibration-20261003/state.json

pnpm -C apps/backend datasets:cleanup verify \
  --input ../../cleanup-runs/calibration-20261003/manifest.json \
  --state ../../cleanup-runs/calibration-20261003/state.json
```

执行入口正常结束后会自动运行 verify。独立验收不需要私钥，读取最新链上状态，输出 `verification.json`，包含每个 ID 的 live、cleanup mode、状态和本次交易记录。仅当**清单全部 ID** 都清理完成、且 state 没有待确认交易时 `accepted=true`、退出码 0；部分批次、默认排除弃置候选或还有未知项时退出码 2。这表示未完成整份清单，并不代表已成功的交易失败。

链上清理不会直接更新 Dealbot 数据库。使用 state 中的成功交易和完成 ID 核对数据库的 cleaned_up 标记，保留历史记录。押金返还给最终完成清理的钱包；历史无押金数据集可能没有返还，净余额还受 gas 和其他交易影响。

## 测试

```sh
node --test apps/backend/scripts/manual-cleanup/common.test.mjs \
  apps/backend/scripts/manual-cleanup/journal.test.mjs
```
