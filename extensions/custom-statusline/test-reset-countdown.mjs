import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function formatResetCountdown(resetsAt, nowMs = Date.now()) {
  if (!resetsAt) return null;
  const seconds = Math.max(0, Math.floor(resetsAt - nowMs / 1000));
  if (seconds === 0) return "now";
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${Math.max(1, minutes)}m`;
}

const providerCacheFiles = {
  "openai-codex": "codex-weekly-usage.json",
  "openai-codex-second": "codex-weekly-usage-second.json",
};

function readCodexQuota(baseDir, provider) {
  const file = providerCacheFiles[provider];
  if (!file) return { remaining: null };
  try {
    const data = JSON.parse(readFileSync(join(baseDir, file), "utf8"));
    return {
      remaining: typeof data.remainingPercent === "number" && Number.isFinite(data.remainingPercent)
        ? Math.max(0, Math.min(100, data.remainingPercent))
        : null,
      resetsAt: typeof data.resetsAt === "number" && Number.isFinite(data.resetsAt)
        ? data.resetsAt
        : undefined,
    };
  } catch {
    return { remaining: null };
  }
}

const base = 1_700_000_000_000;
const countdownCases = [
  [undefined, null],
  [base / 1000, "now"],
  [base / 1000 + 20, "1m"],
  [base / 1000 + 65 * 60, "1h 5m"],
  [base / 1000 + 2 * 86_400 + 3 * 3600, "2d 3h"],
];
let failed = false;
for (const [at, expected] of countdownCases) {
  const actual = formatResetCountdown(at, base);
  const ok = actual === expected;
  console.log(`${ok ? "✓" : "✗"} ${String(at)} -> ${String(actual)} (expected ${String(expected)})`);
  if (!ok) failed = true;
}

const tempDir = mkdtempSync(join(tmpdir(), "codex-quota-test-"));
try {
  writeFileSync(join(tempDir, providerCacheFiles["openai-codex"]), JSON.stringify({ remainingPercent: 12, resetsAt: base / 1000 + 65 * 60 }));
  writeFileSync(join(tempDir, providerCacheFiles["openai-codex-second"]), JSON.stringify({ remainingPercent: 87, resetsAt: base / 1000 + 2 * 86_400 + 3 * 3600 }));

  const first = readCodexQuota(tempDir, "openai-codex");
  const second = readCodexQuota(tempDir, "openai-codex-second");
  const third = readCodexQuota(tempDir, "not-codex");
  const checks = [
    [first.remaining === 12, `first provider remaining=${first.remaining}`],
    [second.remaining === 87, `second provider remaining=${second.remaining}`],
    [formatResetCountdown(first.resetsAt, base) === "1h 5m", `first provider reset=${formatResetCountdown(first.resetsAt, base)}`],
    [formatResetCountdown(second.resetsAt, base) === "2d 3h", `second provider reset=${formatResetCountdown(second.resetsAt, base)}`],
    [third.remaining === null, `non-codex provider remaining=${third.remaining}`],
  ];
  for (const [ok, label] of checks) {
    console.log(`${ok ? "✓" : "✗"} ${label}`);
    if (!ok) failed = true;
  }
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}

const weeklySource = readFileSync("/Users/wenwang/.pi/agent/extensions/weekly-usage-status/index.ts", "utf8");
const helperSource = readFileSync("/Users/wenwang/.pi/agent/extensions/weekly-usage-status/codex-provider.ts", "utf8");
const statusSource = readFileSync("/Users/wenwang/.pi/agent/extensions/custom-statusline/index.ts", "utf8");
const sourceChecks = [
  [helperSource.includes('"openai-codex-second": "codex-weekly-usage-second.json"'), "helper maps second cache file"],
  [helperSource.includes('"openai-codex-second"'), "helper knows second provider id"],
  [weeklySource.includes('"--provider", provider'), "weekly status passes provider to bearer token command"],
  [weeklySource.includes("getCodexProviderId"), "weekly status resolves codex providers"],
  [statusSource.includes("getCodexProviderId(provider)"), "status line resolves codex providers"],
  [statusSource.includes("getCodexCachePath"), "status line uses provider cache path helper"],
];
for (const [ok, label] of sourceChecks) {
  console.log(`${ok ? "✓" : "✗"} ${label}`);
  if (!ok) failed = true;
}

process.exit(failed ? 1 : 0);
