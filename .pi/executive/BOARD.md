# 任务看板（更新时间：2026-08-29）

## 进行中
- （无）

## 等待中
- （无）

## 已完成
- [x] `/rewind` Pi 架构调查 — extension API、leaf 持久化与 UI 刷新边界已确认。
- [x] History 导航审计 — 根因在 Pi-TUI editor 视觉行边界规则。
- [x] Prompt history ↑/↓ — 版本化 Pi-TUI 0.84.1 patch 已应用，9 项行为测试通过；重启 Pi 生效。
- [x] `/rewind` extension — selector + logical rollback + durable marker + same-file transcript refresh；6 项测试通过。
- [x] Sub-agent lifecycle — duration refresh、30m hard timeout、durable shutdown、signal/double-finalize；23 项测试通过。
- [x] Rewind + lifecycle 独立 QA — PASS：29/29，0 blocker/major；1 项附件文档 minor 待补。
- [x] History patch 独立 QA — PASS：独立 7/7 + 官方 9/9；installer/hash/tamper/patch共存通过。
- [x] 文档收口 — 根 README、附件重新附加警告与 patch bootstrap 已更新。
- [x] 最终验收 — diff/credential scan、rewind 6/6、smart 23/23、history 9/9、两个 package patch check 全过。
- [x] Claude 风格 Plan Mode — 收窄自动触发、取消固定双确认、enter sequential、inactive exit 无 UI；独立 QA PASS，0 blocker/major。
- [x] Background Tasks PR #1 — 保留 health/recovery，修复 durable 隐私、wake ack/retry、symlink 与 TERM→KILL 真实性；最终 gate 0 blocker/major。
- [x] Activity widget 稳定顺序 — 共享 stack 固定 Tasks→Sub Agents；独立 QA 156/156，0 blocker/major/minor。

## 失败/搁置
- [ ] `codex_rewind_semantics` — runtime 中断，仅留 context.md。
- [ ] `codex_rewind_retry` — 40 分钟无进展，已 SIGTERM，result=failed exit 143；不做第三次重试。
