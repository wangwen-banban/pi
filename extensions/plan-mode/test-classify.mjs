import { classifyCommand } from "./readonly-check.ts";

const cases = [
  // [command, expectedKind]
  ["ls ~/.pi/agent/extensions/", "allow"],
  ["rg -n 'btw' ~/.pi/agent", "allow"],
  ["git log --oneline -5", "allow"],
  ["cat a.json | jq .name", "allow"],
  ["hexdump -C f | head", "allow"],
  ["find . -name '*.ts'", "allow"],
  ["find . -type f | xargs grep foo", "allow"],
  ["git status && git diff", "allow"],
  ["echo hi", "allow"],
  ["cat pkg.json | jq '.scripts'", "allow"],
  ["FOO=bar ls", "allow"],
  ["git -C /tmp/x log", "allow"],
  ["git branch", "allow"],
  ["git branch -a", "allow"],
  ["git remote -v", "allow"],
  ["npm ls", "allow"],
  ["docker ps", "allow"],
  ["ps aux | grep node", "allow"],
  ["wc -l < file.txt", "allow"],
  ["for f in *.ts; do cat $f; done", "allow"],
  ["stat -f '%z' file", "allow"],
  ["tar -tf archive.tar", "allow"],
  ["sort file.txt | uniq -c", "allow"],
  ["awk '{print $1}' file", "allow"],
  ["cat f > /dev/null", "allow"],
  ["grep foo f 2>/dev/null", "allow"],
  ["ls; pwd; whoami", "allow"],
  ["echo `git rev-parse HEAD`", "allow"],
  ["git diff $(git merge-base HEAD main)", "allow"],
  ["defaults read com.apple.finder", "allow"],

  // deny
  ["echo hi > /tmp/x", "deny"],
  ["echo hi >> /tmp/x", "deny"],
  ["node -e 'require(\"fs\").writeFileSync(\"x\",\"y\")'", "deny"],
  ["python -c 'print(1)'", "deny"],
  ["git commit -m x", "deny"],
  ["git push", "deny"],
  ["git add .", "deny"],
  ["git checkout main", "deny"],
  ["npm install", "deny"],
  ["npm run build", "deny"],
  ["pip install requests", "deny"],
  ["echo $(rm -rf /tmp/x)", "deny"],
  ["find . -name '*.log' | xargs rm", "deny"],
  ["find . -delete", "deny"],
  ["find . -exec rm {} ;", "deny"],
  ["rm -rf /tmp/foo", "deny"],
  ["sudo ls", "deny"],
  ["mv a b", "deny"],
  ["cp a b", "deny"],
  ["chmod +x script.sh", "deny"],
  ["mkdir foo", "deny"],
  ["touch newfile", "deny"],
  ["sed -i 's/a/b/' file", "deny"],
  ["sed -i.bak 's/a/b/' file", "deny"],
  ["perl -i -pe 's/a/b/' file", "deny"],
  ["cat f | tee out.txt", "deny"],
  ["curl -o out.html https://x.com", "deny"],
  ["curl -X POST https://x.com", "deny"],
  ["wget https://x.com/f.zip", "deny"],
  ["ls && rm -rf /tmp/x", "deny"],
  ["git status; git commit -m x", "deny"],
  ["vim file.txt", "deny"],
  ["kill 1234", "deny"],
  ["eval 'rm -rf /'", "deny"],
  ["bash -c 'rm x'", "deny"],
  ["sort -o out.txt in.txt", "deny"],
  ["dd if=/dev/zero of=/tmp/x", "deny"],
  ["git stash", "deny"],
  ["git config user.name foo", "deny"],
  ["tar -xf archive.tar", "deny"],
  ["ln -s a b", "deny"],
  ["git branch -d feature", "deny"],
  ["unzip archive.zip", "deny"],

  // unknown (AI judge territory)
  ["python script.py", "unknown"],
  ["node app.js", "unknown"],
  ["curl https://api.example.com", "unknown"],
  ["someunknowntool --flag", "unknown"],
  ["./configure", "unknown"],
  ["make", "unknown"],
];

let pass = 0, fail = 0;
const failures = [];
for (const [cmd, expected] of cases) {
  const v = classifyCommand(cmd);
  if (v.kind === expected) {
    pass++;
  } else {
    fail++;
    failures.push({ cmd, expected, got: v.kind, why: v.why });
  }
}

console.log(`\nPASS ${pass}/${cases.length}   FAIL ${fail}\n`);
if (failures.length) {
  console.log("FAILURES:");
  for (const f of failures) {
    console.log(`  [${f.expected} → got ${f.got}]  ${f.cmd}`);
    console.log(`      reason: ${f.why}`);
  }
  process.exit(1);
} else {
  console.log("All cases passed ✓");
}
