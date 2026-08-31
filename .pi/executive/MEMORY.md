# 项目记忆

## 项目概况
- 个人 Pi 配置仓库，固定 Pi `0.84.1`；个人 `origin/main` 是唯一同步目标。
- 原生 Pi TUI 与 PI WEB 顺序接力，共用 session JSONL，但不能同时作为陈旧 writer。

## 关键路径
- Repo：`/Users/wenwang/.pi/agent`
- Pi 全局包：`/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent`
- PI WEB：`@jmfederico/pi-web@1.202608.1`，sessiond 由 LaunchAgent 管理。

## 用户偏好与硬约束
- 当前只 commit，不 push，push 必须再次明确授权。
- 不触碰并发/运行时改动：尤其 `extensions/btw/*`、`models-store.json`、`settings.json`、`skills/`。
- commit 不署名 AI/model，无 Co-Authored-By、Generated with 或机器人标记。
- 不物理改写真实 session JSONL；历史恢复采用 append-only/tree 语义。
- Plan Mode 采用 Claude 风格平衡策略：多文件、普通复杂任务和测试失败不自动触发；仅用户明确要求、高风险/不可逆操作或需要用户决策的实质战略分叉才进入。批准覆盖同一顶层目标的实现、测试、修复与验收；`ask_user` 只用于真实选择。

## 已确认事实
- 2026-08-16：Codex backtrack 是 active-history 逻辑截断，原始 JSONL 不物理删除；普通 rewind 不回滚工作区文件。
- 2026-08-16：Pi 0.84.1 `SessionManager.branch()` 只改内存 leaf；持久 rewind 需要追加 non-context marker 或 core cursor。
- 2026-08-16：Pi-TUI 已有 historyNext/draft 恢复；当前多行 recalled item 的 ↓ 优先光标移动，用户要求 browse mode 下 ↑/↓ 对称。
- 2026-08-16：smart-subagents 已实现 running duration 定时重绘、30 分钟 hard timeout、5 秒 TERM→KILL、shutdown durable stopped result、signal/double-finalize 防护。
- 2026-08-16：`/rewind` 采用 extension-only：current-branch selector → navigate 到 user parent → append `rewind-cursor` → same-file switch 重建 transcript/context 并恢复 composer。
- 2026-08-16：Pi-TUI history patch 已应用到 0.84.1；history browse mode 下 ↑/↓ 对称，普通多行 draft 行为不变。
- 2026-08-29：Claude Code 核心 CLI 并未以开源许可证发布；官方公开契约将 Plan 定义为用户可切换的权限模式，批准后切换到持续执行模式，而非按文件数或步骤反复审批。
- 2026-08-29：本地 Plan Mode 高频触发根因是 `AGENTS.md` 与扩展 promptGuidelines 的重复宽泛策略，不是状态机定时自动进入。
- 2026-08-29：PR #1 的 health/recovery 方向已兼容集成；durable run 使用严格 session-bound 最小 manifest，不持久化 command/task/cwd/output/path/PID，wake 采用显式 pending→delivery→ack 顺序与至少一次重试。
- 2026-08-29：Background stop/timeout 只有 child `close` 后才确认终态；KILL 后未确认退出必须报告 `termination_unconfirmed`，不能伪装 stopped/timed_out。
- 2026-08-29：Pi 0.84.1 `setWidget` 更新会 delete→set 并改变 Map 顺序；Tasks/Sub Agents 改用共享 aboveEditor stack，固定 Tasks 在上、Sub Agents 在下。
- 2026-08-30：PI WEB 1.202608.1 在 iPhone Safari/Tailscale 打开含大型内嵌图片的 fork session 时，100条首屏可达5.5MB并触发 `TypeError: Load failed`；版本/hash门禁补丁将 client message page size降为20，用户端验证可正常打开。
- 2026-08-30：Plan TUI custom dialog 只替换 editor，working spinner与Activity widget仍会重绘regular TUI；审批期间隐藏working并持有Activity presentation lease，退出后一次恢复，同时render cache必须绑定width。
