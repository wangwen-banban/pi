import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { WEB_ACTIVITY_SCHEMA_VERSION } from "../web-activity/registry.ts";
import type { TaskPlan } from "./plan-state.ts";
import type { BackgroundRunSnapshot } from "./runner.ts";

export const BACKGROUND_TASK_SOURCE = "background-tasks";
const MAX_BACKGROUND_WEB_RECORD_BYTES = 256 * 1024;

function ownedByCurrentUser(stat: fs.Stats): boolean {
	return typeof process.getuid !== "function" || stat.uid === process.getuid();
}

function containedBy(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function safeControlledDirectory(stat: fs.Stats): boolean {
	return !stat.isSymbolicLink()
		&& stat.isDirectory()
		&& ownedByCurrentUser(stat)
		&& (stat.mode & 0o022) === 0;
}

async function secureRegistryRoot(
	root: string,
	worktreeRoot: string,
	create: boolean,
): Promise<string | undefined> {
	const resolvedWorktree = path.resolve(worktreeRoot);
	const resolvedRoot = path.resolve(root);
	const relative = path.relative(resolvedWorktree, resolvedRoot);
	if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
	const segments = relative.split(path.sep).filter(Boolean);
	if (segments.length === 0) return undefined;

	// The workspace itself is the trusted anchor. Its system-level ancestors may
	// legitimately contain symlinks (for example /var -> /private/var on macOS).
	const canonicalWorktree = await fs.promises.realpath(resolvedWorktree);
	if (!(await fs.promises.stat(canonicalWorktree)).isDirectory()) return undefined;

	let current = resolvedWorktree;
	let firstMissing = segments.length;
	for (let index = 0; index < segments.length; index += 1) {
		current = path.join(current, segments[index]);
		try {
			const stat = await fs.promises.lstat(current);
			if (!safeControlledDirectory(stat)) return undefined;
			const canonical = await fs.promises.realpath(current);
			const expected = path.join(canonicalWorktree, ...segments.slice(0, index + 1));
			if (canonical !== expected || !containedBy(canonicalWorktree, canonical)) return undefined;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") return undefined;
			firstMissing = index;
			break;
		}
	}
	if (firstMissing < segments.length && !create) return undefined;

	// Only after every existing ancestor has passed lstat/realpath validation do
	// we create missing components, one at a time and without recursive adoption.
	current = path.join(resolvedWorktree, ...segments.slice(0, firstMissing));
	for (let index = firstMissing; index < segments.length; index += 1) {
		current = path.join(current, segments[index]);
		let created = false;
		try {
			await fs.promises.mkdir(current, { mode: 0o700 });
			created = true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") return undefined;
		}
		const stat = await fs.promises.lstat(current);
		if (!safeControlledDirectory(stat)) return undefined;
		if (created && (stat.mode & 0o777) !== 0o700) return undefined;
		const canonical = await fs.promises.realpath(current);
		const expected = path.join(canonicalWorktree, ...segments.slice(0, index + 1));
		if (canonical !== expected || !containedBy(canonicalWorktree, canonical)) return undefined;
	}

	// Re-walk the complete chain after creation so a raced EEXIST or ancestor
	// replacement is never accepted as the private registry root.
	current = resolvedWorktree;
	for (let index = 0; index < segments.length; index += 1) {
		current = path.join(current, segments[index]);
		const stat = await fs.promises.lstat(current);
		if (!safeControlledDirectory(stat)) return undefined;
		if (index === segments.length - 1 && (stat.mode & 0o777) !== 0o700) return undefined;
		const canonical = await fs.promises.realpath(current);
		const expected = path.join(canonicalWorktree, ...segments.slice(0, index + 1));
		if (canonical !== expected || !containedBy(canonicalWorktree, canonical)) return undefined;
	}
	return path.join(canonicalWorktree, ...segments);
}

/** Background-specific writer: no PID temp names and no unsafe file adoption. */
export async function writeBackgroundWebRecord(
	root: string,
	worktreeRoot: string,
	name: "runtime" | "background-tasks",
	record: Record<string, unknown>,
): Promise<boolean> {
	let temporary = "";
	try {
		if (name !== "runtime" && name !== "background-tasks") return false;
		const canonicalRoot = await secureRegistryRoot(root, worktreeRoot, true);
		if (!canonicalRoot) return false;
		const target = path.join(canonicalRoot, `${name}.json`);
		if (!containedBy(canonicalRoot, target)) return false;
		try {
			const existing = await fs.promises.lstat(target);
			if (existing.isSymbolicLink() || !existing.isFile() || !ownedByCurrentUser(existing) || (existing.mode & 0o777) !== 0o600) return false;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
		}
		const content = `${JSON.stringify(record)}\n`;
		if (Buffer.byteLength(content, "utf8") > MAX_BACKGROUND_WEB_RECORD_BYTES) return false;
		if (await secureRegistryRoot(root, worktreeRoot, false) !== canonicalRoot) return false;
		temporary = path.join(canonicalRoot, `.tmp-${randomBytes(24).toString("hex")}`);
		const handle = await fs.promises.open(temporary, "wx", 0o600);
		try {
			await handle.writeFile(content, "utf8");
			await handle.chmod(0o600);
			await handle.sync();
			const stat = await handle.stat();
			if (!stat.isFile() || !ownedByCurrentUser(stat) || (stat.mode & 0o777) !== 0o600) return false;
		} finally {
			await handle.close();
		}
		if (await secureRegistryRoot(root, worktreeRoot, false) !== canonicalRoot) return false;
		await fs.promises.rename(temporary, target);
		temporary = "";
		const directoryHandle = await fs.promises.open(canonicalRoot, fs.constants.O_RDONLY);
		try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
		const finalStat = await fs.promises.lstat(target);
		return !finalStat.isSymbolicLink() && finalStat.isFile() && ownedByCurrentUser(finalStat) && (finalStat.mode & 0o777) === 0o600;
	} catch {
		return false;
	} finally {
		if (temporary) await fs.promises.rm(temporary, { force: true }).catch(() => {});
	}
}

export interface BackgroundWebIdentity {
	sessionId: string;
	runtimeId: string;
	generation: number;
}

export function buildBackgroundRuntimeRecord(
	identity: BackgroundWebIdentity,
	state: "active" | "shutdown",
	summary: { startedAt: number; total: number; active: number },
	now = Date.now(),
): Record<string, unknown> {
	return {
		schemaVersion: WEB_ACTIVITY_SCHEMA_VERSION,
		source: BACKGROUND_TASK_SOURCE,
		sessionId: identity.sessionId,
		runtimeId: identity.runtimeId,
		generation: identity.generation,
		state,
		startedAt: summary.startedAt,
		updatedAt: now,
		...(state === "active" ? { heartbeatAt: now } : {}),
		jobs: { total: summary.total, active: summary.active },
	};
}

/**
 * Public workspace record. Task titles, shell commands and bounded live output
 * remain only in current model/UI messages; PI WEB receives stable ids,
 * lifecycle status and timing metadata.
 */
export function buildBackgroundTasksRecord(
	plan: TaskPlan,
	runs: BackgroundRunSnapshot[],
	identity: BackgroundWebIdentity,
	now = Date.now(),
): Record<string, unknown> {
	return {
		schemaVersion: WEB_ACTIVITY_SCHEMA_VERSION,
		sessionId: identity.sessionId,
		runtimeId: identity.runtimeId,
		generation: identity.generation,
		revision: plan.revision,
		updatedAt: now,
		tasks: plan.tasks.map((task, position) => ({
			id: task.id,
			name: task.id,
			status: task.status,
			position,
			updatedAt: task.updatedAt,
			runId: task.runId,
		})),
		runs: runs.map((run) => ({
			id: run.id,
			taskId: run.taskId,
			name: run.taskId,
			status: run.status,
			stopping: Boolean(run.stopReason && run.status === "running"),
			createdAt: run.createdAt,
			startedAt: run.startedAt,
			finishedAt: run.finishedAt,
			lastOutputAt: run.lastOutputAt,
			lastProgressAt: run.lastProgressAt,
			lastHeartbeatAt: run.lastHeartbeatAt,
			healthStatus: run.healthStatus,
			healthFailure: run.healthFailure,
			healthDeadlineAt: run.healthDeadlineAt,
			timeoutAt: run.timeoutAt,
			exitCode: run.exitCode,
			signal: run.signal,
			terminationReason: run.terminationReason,
		})),
	};
}
