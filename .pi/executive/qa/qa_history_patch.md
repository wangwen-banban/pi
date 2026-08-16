# QA: Pi-TUI history-navigation 0.84.1

- **结果：PASS**；无 blocker/major；minor 风险见下。
- **版本/target：** coding-agent `0.84.1`; pi-tui `0.84.1`。
- **真实 realpath：** `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-tui/dist/components/editor.js`
- **SHA-256：** stock `a384c140d84e5352605250fab0e1284add133dbdda1e986419c4a0778ffa0853`; patched/current `5a765439ec4f415d9a9720d6651ddd693333ee2f6899be6efaca63eb6b2c7aaf`。
- **Patch scope：** 单一 `editor.js`、2 hunks；只改 historyIndex browsing 状态机；无供应链/无关文件改动；reverse dry-run PASS。
- **行为：** 独立测试 `7/7 PASS`；提供的 test script `9/9 PASS`。
- 覆盖普通多行视觉 ↑/↓、未编辑 browse、旧/新切换、越过最新恢复 draft、最旧边界、编辑退出 browse、显式 actions、大粘贴 marker。
- **Installer：** `/tmp` stock fixture first-run PASS；second-run/idempotent PASS；`--check` PASS；tampered refusal 且目标不变 PASS；unknown version refusal PASS；带空格路径 PASS。
- `bash -n`、editor/model-selector `node --check` PASS；apply/test 脚本安全流程 PASS（temp staging + same-dir atomic mv + hash pinning）。
- **共存：** history `--check`=0、model-selector `--check`=0；目标路径不同，两个 patched SHA 均匹配。
- **全局状态：** 仅执行 history/model `--check` 与只读语法检查，未重新写全局包；当前两 patch 均已安装。
- **Repo 状态：** QA 未触碰 btw/settings/models/skills；初始已有改动与结束状态一致。
- **Minor 风险：** installer 的 `stat -f` 分支面向 BSD/macOS；Linux GNU `stat` 兼容性未在本机验证。其余未发现问题。
- **重启：** 需要重启当前 Pi 进程以加载已修改的 editor/model-selector 模块。
- **QA 文件/临时 fixture：** 仅写入 `/tmp/pi-history-qa*` 与本报告；无 repo/global package 修改。
