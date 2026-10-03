# 数据集清理工具

完整操作说明见 [手动清理运行手册](../../../../docs/runbooks/manual-dataset-cleanup.md)。

入口：`pnpm -C apps/backend datasets:cleanup help`，支持 `scan`、`execute`、`status`、`verify`。

`execute` 发送真实交易，其余命令只读。支持 Calibration/Mainnet、钱包全量扫描、候选模拟、并发 nonce、指数退避、断点恢复、分批 pieces 清理和独立验收。

`candidates.calibration.json` 与 `run-all.mjs` 是此次测试网清理的兼容入口；后续请使用标准 CLI 和每次扫描生成的 manifest。私钥仅通过环境变量传入。`.runtime/` 已忽略，不提交进度和日志。
