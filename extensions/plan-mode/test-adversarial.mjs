import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { classifyCommand } from "./readonly-check.ts";

// Evasion attempts — none of these may return "allow"
const mustNotAllow = [
  "ls $(rm -rf /tmp/x)",
  "ls `rm -rf /tmp/x`",
  "echo \"$(git commit -m x)\"",
  "cat f && echo x > /tmp/y",
  "cat f || rm f",
  "ls | xargs -n1 rm",
  "ls | xargs -I{} rm {}",
  "env FOO=1 rm x",
  "timeout 5 rm x",
  "nohup rm x",
  "nice -n 5 rm x",
  "/bin/rm x",
  "/usr/bin/rm x",
  "command rm x",
  "xargs rm < list.txt",
  "ls;rm x",
  "ls&&rm x",
  "grep x f>out.txt",
  "grep x f >out.txt",
  "grep x f>>out.txt",
  "python3 -c 'import os; os.remove(\"x\")'",
  "node --eval 'x'",
  "perl -e 'unlink \"x\"'",
  "ruby -e 'File.delete(\"x\")'",
  "osascript -e 'do shell script \"rm x\"'",
  "awk 'BEGIN{system(\"rm x\")}'",
  "awk '{print > \"out.txt\"}' f",
  "find . -execdir rm {} +",
  "git -C /tmp reset --hard",
  "git -c user.name=x commit -m y",
  "sed --in-place 's/a/b/' f",
  "sort --output=out.txt in.txt",
  "curl --data 'x=1' https://api.com",
  "curl -T file https://api.com",
  "tar -cf out.tar .",
  "tar -xzf in.tar.gz",
  "brew install jq",
  "cargo build",
  "cargo install ripgrep",
  "docker run alpine rm -rf /",
  "docker image rm x",
  "kubectl delete pod x",
  "kubectl config set-context x",
  "systemctl restart nginx",
  "defaults write com.apple.finder X -bool true",
  "npm version patch",
  "git worktree add ../x",
  "git submodule update --init",
  "git stash pop",
  "git tag v1.0",
  "git branch newbranch",
  "if rm x; then echo done; fi",
  "while true; do rm x; done",
  "for f in *; do rm $f; done",
  "{ rm x; }",
  "(cd /tmp && rm x)",
  "ls > /tmp/out 2>&1",
];

// Legit read-only usage — these must NOT be denied (allow or unknown both fine,
// but allow is expected for the common ones)
const mustNotDeny = [
  "ls -la",
  "git log -p --stat -20",
  "git show HEAD:file.ts",
  "git diff HEAD~1 HEAD -- src/",
  "rg -n --hidden -g '!node_modules' 'pattern'",
  "cat a b c | sort | uniq -c | sort -rn | head -20",
  "find . -type f -name '*.json' -not -path '*/node_modules/*'",
  "sed -n '10,20p' file.ts",
  "sed 's/a/b/' file.ts",
  "awk -F, '{print $2}' data.csv",
  "wc -l $(git ls-files)",
  "git ls-files | xargs wc -l",
  "echo $(date +%s)",
  "grep -rn 'foo' . 2>/dev/null | head",
  "git branch -a -v",
  "git tag --list",
  "git config --get user.name",
  "git config --list",
  "git stash list",
  "git remote show",
  "git worktree list",
  "git submodule status",
  "docker image ls",
  "kubectl config view",
  "systemctl status nginx",
  "defaults read com.apple.dock",
  "node --version",
  "python3 --version",
  "tar -tzf archive.tar.gz",
  "ls -la > /dev/null",
  "cat f 2>/dev/null",
  "test -f file && echo yes",
  "for f in *.ts; do echo $f; done",
  "if grep -q foo f; then echo found; fi",
];

let fails = [];

for (const cmd of mustNotAllow) {
  const v = classifyCommand(cmd);
  if (v.kind === "allow") fails.push({ cmd, problem: "ALLOWED but should be blocked", why: v.why });
}
for (const cmd of mustNotDeny) {
  const v = classifyCommand(cmd);
  if (v.kind === "deny") fails.push({ cmd, problem: "DENIED but is read-only", why: v.why });
}

const total = mustNotAllow.length + mustNotDeny.length;
console.log(`\nadversarial: ${total - fails.length}/${total} correct\n`);
if (fails.length) {
  console.log("PROBLEMS:");
  for (const f of fails) console.log(`  ${f.problem}\n    cmd: ${f.cmd}\n    why: ${f.why}`);
  process.exit(1);
}
const planModeSource = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
assert.match(
  planModeSource,
  /WRITE_TOOLS = new Set\(\["bash", "edit", "write", "run_background_task"\]\)/,
  "plan mode must block managed background commands as a write/process-control bypass",
);
console.log("No evasions, no false blocks ✓");
