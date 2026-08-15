import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCodexCachePath } from "../weekly-usage-status/codex-provider.ts";
import { formatResetCountdown, readSubscriptionQuota, SUBSCRIPTION_PROVIDERS } from "./quota.ts";

const agentDir = mkdtempSync(join(tmpdir(), "pi-quota-"));
try {
	mkdirSync(join(agentDir, "cache"), { recursive: true });
	writeFileSync(
		getCodexCachePath(agentDir, "openai-codex"),
		JSON.stringify({ remainingPercent: 76.4, resetsAt: 1_700_000_100 }),
	);
	writeFileSync(
		getCodexCachePath(agentDir, "openai-codex-second"),
		JSON.stringify({ remainingPercent: 98, resetsAt: 1_700_000_200 }),
	);

	// Both Codex accounts share one label; the balance follows the active provider.
	assert.equal(SUBSCRIPTION_PROVIDERS["openai-codex"].label, "CODEX WEEK");
	assert.equal(SUBSCRIPTION_PROVIDERS["openai-codex-second"].label, "CODEX WEEK");

	const first = readSubscriptionQuota(agentDir, "openai-codex");
	assert.ok(first);
	assert.equal(first.remaining, 76.4);
	assert.equal(first.resetsAt, 1_700_000_100);

	const second = readSubscriptionQuota(agentDir, "openai-codex-second");
	assert.ok(second);
	assert.equal(second.remaining, 98);
	assert.equal(second.resetsAt, 1_700_000_200);
	console.log("✓ both Codex accounts share label 'CODEX WEEK' and read their own cache");

	// Third-party API / pay-per-use providers render no quota bar at all.
	assert.equal(readSubscriptionQuota(agentDir, "claude-relay"), undefined);
	assert.equal(readSubscriptionQuota(agentDir, "claude-relay-alibaba"), undefined);
	assert.equal(readSubscriptionQuota(agentDir, "big-data-claude"), undefined);
	assert.equal(
		SUBSCRIPTION_PROVIDERS["opencode-go"],
		undefined,
		"opencode-go waits for an official usage API (anomalyco/opencode#31084)",
	);
	console.log("✓ non-subscription providers (API/pay-per-use, opencode-go) yield no quota");

	// Corrupt cache degrades to unknown remaining instead of crashing the footer.
	writeFileSync(getCodexCachePath(agentDir, "openai-codex-second"), "not-json{");
	assert.deepEqual(readSubscriptionQuota(agentDir, "openai-codex-second"), { remaining: null });
	console.log("✓ corrupt cache degrades to { remaining: null }");

	// Reset countdown formatting matches the existing weekly-usage formatter.
	assert.equal(formatResetCountdown(undefined), null);
	assert.equal(formatResetCountdown(1_700_000_000 / 1000, 1_700_000_000), "now");
	assert.equal(formatResetCountdown(1_700_000_000 / 1000 + 65 * 60, 1_700_000_000), "1h 5m");
	assert.equal(formatResetCountdown(1_700_000_000 / 1000 + 2 * 86_400 + 3 * 3600, 1_700_000_000), "2d 3h");
	console.log("✓ reset countdown formatting");
} finally {
	rmSync(agentDir, { recursive: true, force: true });
}

const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
assert.match(source, /SUBSCRIPTION_PROVIDERS\[providerId\]/);
assert.match(source, /readSubscriptionQuota\(AGENT_DIR, providerId\)/);
assert.match(source, /secondSegments\.join\("   "\)/);
assert.doesNotMatch(source, /function readCodexQuota/);
assert.doesNotMatch(source, /function formatResetCountdown/);
console.log("✓ statusline renders quota only for registered subscription providers");
