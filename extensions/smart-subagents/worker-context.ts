import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { cacheDecision, requestEvidence } from "./native-fork.ts";

/** Trusted bootstrap only: no tools are added and no parent connection/state is reused. */
export default function workerContext(pi: ExtensionAPI): void {
	const metadataPath = process.env.PI_SUBAGENT_FORK_META;
	if (!metadataPath) return;
	let metadata: any;
	const fd = fs.openSync(metadataPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
	try {
		const stat = fs.fstatSync(fd);
		if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > 2 * 1024 * 1024) throw new Error("Invalid private fork metadata");
		metadata = JSON.parse(fs.readFileSync(fd, "utf8"));
	} finally { fs.closeSync(fd); }
	if (metadata.version !== 1 || !["read-only", "workspace-write"].includes(metadata.permission) ||
		typeof metadata.parentSessionId !== "string" || !Array.isArray(metadata.writeScope)) throw new Error("Invalid fork metadata schema");
	const reportPath = path.join(path.dirname(metadataPath), `${path.basename(metadataPath)}.report`);
	let requests = 0;
	const cacheModes = { parent: 0, siblings: 0, independent: 0 };
	pi.on("tool_call", (event) => {
		const allowed = metadata.permission === "read-only"
			? ["read", "grep", "find", "ls", "web_search"]
			: ["read", "grep", "find", "ls", "web_search", "bash", "edit", "write"];
		if (!allowed.includes(event.toolName)) return { block: true, reason: "Tool is outside this delegated worker's current permission. Inherited history is not authorization." };
	});
	pi.on("before_provider_request", (event, ctx) => {
		const current = requestEvidence(event.payload, ctx.model);
		if (!current) return;
		const result = cacheDecision(current, metadata.evidence, metadata.parentSessionId,
			metadata.prefixIntact === true, metadata.shareCompatibleCache === true);
		requests++; cacheModes[result.mode]++;
		// Bounded diagnostics only: no keys, prompts, history, credentials or token contents.
		try {
			const report = JSON.stringify({ requests, cacheModes, lastMode: result.mode, reason: result.reason });
			const reportFd = fs.openSync(reportPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW, 0o600);
			try { fs.writeFileSync(reportFd, report); } finally { fs.closeSync(reportFd); }
		} catch { /* Observability must not break or retry model requests. */ }
		if (result.key) return { ...(event.payload as Record<string, unknown>), prompt_cache_key: result.key };
	});
}
