import { readFileSync } from "node:fs";

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

const base = 1_700_000_000_000;
const cases = [
  [undefined, null],
  [base / 1000, "now"],
  [base / 1000 + 20, "1m"],
  [base / 1000 + 65 * 60, "1h 5m"],
  [base / 1000 + 2 * 86_400 + 3 * 3600, "2d 3h"],
];
let failed = false;
for (const [at, expected] of cases) {
  const actual = formatResetCountdown(at, base);
  const ok = actual === expected;
  console.log(`${ok ? "✓" : "✗"} ${String(at)} -> ${String(actual)} (expected ${String(expected)})`);
  if (!ok) failed = true;
}

try {
  const cache = JSON.parse(readFileSync("/Users/wenwang/.pi/agent/cache/codex-weekly-usage.json", "utf8"));
  console.log(`current display: CODEX WEEK ${Math.round(cache.remainingPercent)}% RESET ${formatResetCountdown(cache.resetsAt)}`);
} catch {
  console.log("current display: cache unavailable");
}
process.exit(failed ? 1 : 0);
