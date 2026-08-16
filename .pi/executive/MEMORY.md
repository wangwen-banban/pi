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

## 已确认事实
- 2026-08-16：Codex backtrack 是 active-history 逻辑截断，原始 JSONL 不物理删除；普通 rewind 不回滚工作区文件。
- 2026-08-16：Pi 0.84.1 `SessionManager.branch()` 只改内存 leaf；持久 rewind 需要追加 non-context marker 或 core cursor。
- 2026-08-16：Pi-TUI 已有 historyNext/draft 恢复；当前多行 recalled item 的 ↓ 优先光标移动，用户要求 browse mode 下 ↑/↓ 对称。
- 2026-08-16：smart-subagents 已实现 running duration 定时重绘、30 分钟 hard timeout、5 秒 TERM→KILL、shutdown durable stopped result、signal/double-finalize 防护。
- 2026-08-16：`/rewind` 采用 extension-only：current-branch selector → navigate 到 user parent → append `rewind-cursor` → same-file switch 重建 transcript/context 并恢复 composer。
- 2026-08-16：Pi-TUI history patch 已应用到 0.84.1；history browse mode 下 ↑/↓ 对称，普通多行 draft 行为不变。
