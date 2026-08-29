# 执行时间线

2026-08-16 | 调查 `/rewind` 架构 | 成功：确认 parent-leaf、non-context marker、TUI/WEB 刷新边界。
2026-08-16 | 调查 prompt history ↑/↓ | 成功：确认现有状态机与多行视觉行规则是根因。
2026-08-16 | Codex rewind 复核 | 两次异常；依据公开源码/issue 确认 logical rollback，不再重试。
2026-08-16 | 实施 `/rewind`、history patch、sub-agent lifecycle | 三张互斥写范围工单并行运行中。
2026-08-16 | Prompt history ↑/↓ patch | 成功：全局 Pi-TUI 0.84.1 已应用，9 项行为测试和 hash/idempotency 校验通过。
2026-08-16 | `/rewind` extension | 成功：selector、logical rollback、durable marker、same-file refresh；6/6 测试通过，无 core patch。
2026-08-16 | smart-subagents lifecycle | 成功：duration、30m timeout、durable shutdown、signal/double-finalize；23/23 测试通过。
2026-08-16 | 独立 QA | 两条验收线已派发：rewind/lifecycle 与 history package patch。
2026-08-16 | Rewind + lifecycle QA | PASS：29/29，0 blocker/major；1 项 minor（附件需重新附加的文档提示）。
2026-08-16 | History patch QA | PASS：独立7/7+官方9/9；installer安全、hash、tamper拒绝、model patch共存均通过。
2026-08-16 | 文档与最终验收 | PASS：附件 warning 已补；diff/credential scan 与全部目标测试通过，准备分拆本地提交。
2026-08-29 | Plan Mode 本地/Claude Code 对照审计 | 成功：确认核心 CLI 非开源；本地高频来自宽泛重复提示和固定双确认。
2026-08-29 | Claude 风格 Plan Mode 实施与独立 QA | PASS：24/24 workflow、79/79 分类、91/91 对抗；0 blocker/major，1 minor 覆盖缺口。
2026-08-29 | Background Tasks PR #1 双重审计 | 原 PR FAIL：隐私持久化、wake 误 ack/未持久化发送、TERM→KILL 假终态；转为兼容补丁。
2026-08-29 | Background Tasks PR #1 最终 gate | PASS：75/75 background、313/313 Activity、24/24 Plan；0 blocker/major。
