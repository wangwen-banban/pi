import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type {
	BackgroundRunSnapshot,
	BackgroundRunStatus,
	BackgroundStopReason,
	BackgroundTerminationReason,
} from "./runner.ts";
import type {
	BackgroundHealthFailureCode,
	BackgroundHealthStatus,
} from "./health-policy.ts";

export const BACKGROUND_RUN_RECORD_VERSION = 3;
export const TERMINAL_RUN_MANIFEST_FILE = "result.json";
export const MAX_TERMINAL_MANIFEST_BYTES = 16 * 1024;
export const MAX_TERMINAL_MANIFEST_AGE_MS = 30 * 24 * 60 * 60 * 1000;
export const MAX_TERMINAL_MANIFEST_FUTURE_SKEW_MS = 5 * 60 * 1000;
export const MAX_TERMINAL_RUN_DURATION_MS = 7 * 24 * 60 * 60 * 1000 + 10 * 60 * 1000;

export const SAFE_RUN_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/;
export const SAFE_TASK_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
export const SAFE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

const TERMINAL_STATUSES = new Set<BackgroundRunStatus>(["completed", "failed", "stopped"]);
const STOP_REASONS = new Set<BackgroundStopReason>(["user", "shutdown", "timeout", "health_policy"]);
const TERMINATION_REASONS = new Set<BackgroundTerminationReason>([
	"completed",
	"exit_nonzero",
	"signal",
	"spawn_error",
	"timed_out",
	"health_policy_failed",
	"monitor_restarted",
	"recovery_blocked",
	"persistence_failed",
	"termination_unconfirmed",
	"explicit_stop",
	"session_shutdown",
]);
const HEALTH_STATUSES = new Set<BackgroundHealthStatus>(["awaiting", "healthy", "unavailable"]);
const HEALTH_FAILURES = new Set<BackgroundHealthFailureCode>([
	"startup_timeout",
	"heartbeat_timeout",
	"unavailable_timeout",
	"stale_progress",
	"protocol_error",
]);
const SIGNAL = /^SIG[A-Z0-9]{1,16}$/;

export interface TerminalRunManifest {
	version: typeof BACKGROUND_RUN_RECORD_VERSION;
	sessionId: string;
	runId: string;
	taskId: string;
	status: Exclude<BackgroundRunStatus, "running">;
	createdAt: number;
	startedAt: number;
	finishedAt: number;
	timeoutAt: number;
	terminationReason: BackgroundTerminationReason;
	stopReason?: BackgroundStopReason;
	exitCode?: number;
	signal?: string;
	terminationEscalated?: true;
	signalDeliveryFailed?: true;
	healthStatus?: BackgroundHealthStatus;
	healthFailure?: BackgroundHealthFailureCode;
	healthDeadlineAt?: number;
	lastHeartbeatAt?: number;
	lastProgressAt?: number;
	unavailableSince?: number;
}

export type TerminalManifestFailureCode =
	| "invalid_identity"
	| "missing"
	| "unsafe_path"
	| "bad_mode"
	| "too_large"
	| "invalid_json"
	| "invalid_schema"
	| "mismatch"
	| "stale"
	| "io_error";

export type TerminalManifestReadResult =
	| { ok: true; manifest: TerminalRunManifest; runDir: string }
	| { ok: false; code: TerminalManifestFailureCode };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(raw: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
	return Object.keys(raw).every((key) => allowed.has(key));
}

function timestamp(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function optionalTimestamp(value: unknown): value is number | undefined {
	return value === undefined || timestamp(value);
}

function ownedByCurrentUser(stat: fs.Stats): boolean {
	return typeof process.getuid !== "function" || stat.uid === process.getuid();
}

function modeIs(stat: fs.Stats, mode: number): boolean {
	return (stat.mode & 0o777) === mode;
}

function containedBy(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function lstatDirectory(directory: string, mode: number): Promise<fs.Stats> {
	const stat = await fs.promises.lstat(directory);
	if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("unsafe directory");
	if (!ownedByCurrentUser(stat) || !modeIs(stat, mode)) throw new Error("unsafe directory mode");
	return stat;
}

async function createOrValidatePrivateDirectory(directory: string): Promise<void> {
	try {
		await fs.promises.mkdir(directory, { mode: 0o700 });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	}
	await lstatDirectory(directory, 0o700);
}

async function canonicalPrivateRoot(runsDir: string, create: boolean): Promise<string> {
	const root = path.resolve(runsDir);
	if (create) {
		try {
			await fs.promises.mkdir(root, { recursive: true, mode: 0o700 });
		} catch {
			throw new Error("could not create private run root");
		}
	}
	await lstatDirectory(root, 0o700);
	return fs.promises.realpath(root);
}

function assertSafeIdentity(sessionId: string, runId: string, taskId?: string): void {
	if (!SAFE_SESSION_ID.test(sessionId)) throw new Error("invalid session identity");
	if (!SAFE_RUN_ID.test(runId)) throw new Error("invalid run identity");
	if (taskId !== undefined && !SAFE_TASK_ID.test(taskId)) throw new Error("invalid task identity");
}

/** Create a new, empty run directory without following a caller-controlled link. */
export async function prepareSecureRunDirectory(runsDir: string, sessionId: string, runId: string, taskId: string): Promise<string> {
	assertSafeIdentity(sessionId, runId, taskId);
	const root = await canonicalPrivateRoot(runsDir, true);
	const sessionDir = path.join(root, sessionId);
	if (!containedBy(root, sessionDir)) throw new Error("unsafe session directory");
	await createOrValidatePrivateDirectory(sessionDir);
	const canonicalSession = await fs.promises.realpath(sessionDir);
	if (!containedBy(root, canonicalSession)) throw new Error("unsafe session directory");

	const runDir = path.join(canonicalSession, runId);
	try {
		await fs.promises.mkdir(runDir, { mode: 0o700 });
	} catch {
		// Run ids are random and single-use. Existing entries are never adopted.
		throw new Error("run directory already exists or could not be created");
	}
	await lstatDirectory(runDir, 0o700);
	const canonicalRun = await fs.promises.realpath(runDir);
	if (!containedBy(canonicalSession, canonicalRun) || canonicalRun !== runDir) {
		throw new Error("unsafe run directory");
	}
	return canonicalRun;
}

const MANIFEST_KEYS = new Set([
	"version",
	"sessionId",
	"runId",
	"taskId",
	"status",
	"createdAt",
	"startedAt",
	"finishedAt",
	"timeoutAt",
	"terminationReason",
	"stopReason",
	"exitCode",
	"signal",
	"terminationEscalated",
	"signalDeliveryFailed",
	"healthStatus",
	"healthFailure",
	"healthDeadlineAt",
	"lastHeartbeatAt",
	"lastProgressAt",
	"unavailableSince",
]);

function coherentClassification(manifest: TerminalRunManifest): boolean {
	const hasHealthMetadata = manifest.healthFailure !== undefined
		|| manifest.healthDeadlineAt !== undefined
		|| manifest.lastHeartbeatAt !== undefined
		|| manifest.lastProgressAt !== undefined
		|| manifest.unavailableSince !== undefined;
	if (manifest.healthStatus === undefined && hasHealthMetadata) return false;
	if ((manifest.healthStatus === "unavailable") !== (manifest.unavailableSince !== undefined)) return false;
	if (manifest.healthStatus === "awaiting"
		&& (manifest.lastHeartbeatAt !== undefined || manifest.lastProgressAt !== undefined || manifest.unavailableSince !== undefined)) return false;
	if ((manifest.healthStatus === "healthy" || manifest.healthStatus === "unavailable") && manifest.lastHeartbeatAt === undefined) return false;
	if (manifest.healthFailure === "startup_timeout" && manifest.healthStatus !== "awaiting") return false;
	if (manifest.healthFailure === "unavailable_timeout" && manifest.healthStatus !== "unavailable") return false;
	if (manifest.healthFailure === "stale_progress" && manifest.healthStatus !== "healthy") return false;
	if (manifest.healthFailure === "heartbeat_timeout" && manifest.healthStatus === "awaiting") return false;
	if (manifest.exitCode !== undefined && manifest.signal !== undefined) return false;
	if (manifest.stopReason === undefined
		&& (manifest.terminationEscalated !== undefined || manifest.signalDeliveryFailed !== undefined)) return false;

	const noStopClassification = manifest.stopReason === undefined
		&& manifest.terminationEscalated === undefined
		&& manifest.signalDeliveryFailed === undefined;
	const noProcessOutcome = manifest.exitCode === undefined && manifest.signal === undefined;
	const noHealthFailure = manifest.healthFailure === undefined;
	const stoppedBy = (stopReason: "user" | "shutdown"): boolean => manifest.status === "stopped"
		&& manifest.stopReason === stopReason
		&& noHealthFailure;

	switch (manifest.terminationReason) {
		case "completed":
			return manifest.status === "completed"
				&& manifest.exitCode === 0
				&& manifest.signal === undefined
				&& noStopClassification
				&& noHealthFailure;
		case "explicit_stop":
			return stoppedBy("user");
		case "session_shutdown":
			return stoppedBy("shutdown");
		case "exit_nonzero":
			return manifest.status === "failed"
				&& manifest.exitCode !== undefined
				&& manifest.exitCode !== 0
				&& manifest.signal === undefined
				&& noStopClassification
				&& noHealthFailure;
		case "signal":
			return manifest.status === "failed"
				&& manifest.signal !== undefined
				&& manifest.exitCode === undefined
				&& noStopClassification
				&& noHealthFailure;
		case "spawn_error":
			return manifest.status === "failed"
				&& manifest.exitCode === 1
				&& manifest.signal === undefined
				&& noStopClassification
				&& noHealthFailure;
		case "timed_out":
			return manifest.status === "failed"
				&& manifest.stopReason === "timeout"
				&& noHealthFailure;
		case "health_policy_failed":
			return manifest.status === "failed"
				&& manifest.stopReason === "health_policy"
				&& manifest.healthFailure !== undefined;
		case "monitor_restarted":
		case "recovery_blocked":
			return manifest.status === "failed"
				&& noStopClassification
				&& noProcessOutcome
				&& manifest.healthStatus === undefined;
		case "termination_unconfirmed":
			return manifest.status === "failed"
				&& manifest.stopReason !== undefined
				&& manifest.terminationEscalated === true
				&& manifest.exitCode === undefined
				&& (manifest.signal === undefined || manifest.signal === "SIGKILL")
				&& (manifest.signal !== undefined || manifest.signalDeliveryFailed === true)
				&& (manifest.stopReason === "health_policy"
					? manifest.healthFailure !== undefined
					: noHealthFailure);
		case "persistence_failed":
			if (manifest.status !== "failed") return false;
			if (manifest.stopReason === "health_policy") return manifest.healthFailure !== undefined;
			if (manifest.stopReason === "timeout" || manifest.stopReason === "user" || manifest.stopReason === "shutdown") {
				return noHealthFailure;
			}
			return noStopClassification && noHealthFailure;
	}
}

/** Strictly parse the privacy-minimal v3 terminal schema. Legacy/full snapshots are rejected. */
export function parseTerminalRunManifest(
	value: unknown,
	expected: { sessionId: string; runId: string; taskId: string; now?: number },
): TerminalManifestReadResult {
	if (!SAFE_SESSION_ID.test(expected.sessionId) || !SAFE_RUN_ID.test(expected.runId) || !SAFE_TASK_ID.test(expected.taskId)) {
		return { ok: false, code: "invalid_identity" };
	}
	if (!isRecord(value) || !exactKeys(value, MANIFEST_KEYS) || value.version !== BACKGROUND_RUN_RECORD_VERSION) {
		return { ok: false, code: "invalid_schema" };
	}
	if (value.sessionId !== expected.sessionId || value.runId !== expected.runId || value.taskId !== expected.taskId) {
		return { ok: false, code: "mismatch" };
	}
	if (typeof value.status !== "string" || !TERMINAL_STATUSES.has(value.status as BackgroundRunStatus)) {
		return { ok: false, code: "invalid_schema" };
	}
	if (typeof value.terminationReason !== "string" || !TERMINATION_REASONS.has(value.terminationReason as BackgroundTerminationReason)) {
		return { ok: false, code: "invalid_schema" };
	}
	for (const field of ["createdAt", "startedAt", "finishedAt", "timeoutAt"] as const) {
		if (!timestamp(value[field])) return { ok: false, code: "invalid_schema" };
	}
	if (value.stopReason !== undefined && (typeof value.stopReason !== "string" || !STOP_REASONS.has(value.stopReason as BackgroundStopReason))) {
		return { ok: false, code: "invalid_schema" };
	}
	if (value.exitCode !== undefined && (!Number.isSafeInteger(value.exitCode) || typeof value.exitCode !== "number" || value.exitCode < 0)) {
		return { ok: false, code: "invalid_schema" };
	}
	if (value.signal !== undefined && (typeof value.signal !== "string" || !SIGNAL.test(value.signal))) {
		return { ok: false, code: "invalid_schema" };
	}
	if (value.terminationEscalated !== undefined && value.terminationEscalated !== true) return { ok: false, code: "invalid_schema" };
	if (value.signalDeliveryFailed !== undefined && value.signalDeliveryFailed !== true) return { ok: false, code: "invalid_schema" };
	if (value.healthStatus !== undefined && (typeof value.healthStatus !== "string" || !HEALTH_STATUSES.has(value.healthStatus as BackgroundHealthStatus))) {
		return { ok: false, code: "invalid_schema" };
	}
	if (value.healthFailure !== undefined && (typeof value.healthFailure !== "string" || !HEALTH_FAILURES.has(value.healthFailure as BackgroundHealthFailureCode))) {
		return { ok: false, code: "invalid_schema" };
	}
	for (const field of ["healthDeadlineAt", "lastHeartbeatAt", "lastProgressAt", "unavailableSince"] as const) {
		if (!optionalTimestamp(value[field])) return { ok: false, code: "invalid_schema" };
	}

	const manifest: TerminalRunManifest = {
		version: BACKGROUND_RUN_RECORD_VERSION,
		sessionId: value.sessionId as string,
		runId: value.runId as string,
		taskId: value.taskId as string,
		status: value.status as TerminalRunManifest["status"],
		createdAt: value.createdAt as number,
		startedAt: value.startedAt as number,
		finishedAt: value.finishedAt as number,
		timeoutAt: value.timeoutAt as number,
		terminationReason: value.terminationReason as BackgroundTerminationReason,
		...(value.stopReason === undefined ? {} : { stopReason: value.stopReason as BackgroundStopReason }),
		...(value.exitCode === undefined ? {} : { exitCode: value.exitCode as number }),
		...(value.signal === undefined ? {} : { signal: value.signal as string }),
		...(value.terminationEscalated === true ? { terminationEscalated: true as const } : {}),
		...(value.signalDeliveryFailed === true ? { signalDeliveryFailed: true as const } : {}),
		...(value.healthStatus === undefined ? {} : { healthStatus: value.healthStatus as BackgroundHealthStatus }),
		...(value.healthFailure === undefined ? {} : { healthFailure: value.healthFailure as BackgroundHealthFailureCode }),
		...(value.healthDeadlineAt === undefined ? {} : { healthDeadlineAt: value.healthDeadlineAt as number }),
		...(value.lastHeartbeatAt === undefined ? {} : { lastHeartbeatAt: value.lastHeartbeatAt as number }),
		...(value.lastProgressAt === undefined ? {} : { lastProgressAt: value.lastProgressAt as number }),
		...(value.unavailableSince === undefined ? {} : { unavailableSince: value.unavailableSince as number }),
	};
	if (manifest.createdAt > manifest.startedAt
		|| manifest.startedAt > manifest.finishedAt
		|| manifest.startedAt - manifest.createdAt > 10 * 60 * 1000
		|| manifest.timeoutAt < manifest.startedAt
		|| manifest.timeoutAt - manifest.startedAt > MAX_TERMINAL_RUN_DURATION_MS
		|| manifest.finishedAt - manifest.startedAt > MAX_TERMINAL_RUN_DURATION_MS) {
		return { ok: false, code: "invalid_schema" };
	}
	for (const observed of [manifest.lastHeartbeatAt, manifest.lastProgressAt, manifest.unavailableSince]) {
		if (observed !== undefined && (observed < manifest.startedAt || observed > manifest.finishedAt)) {
			return { ok: false, code: "invalid_schema" };
		}
	}
	if (manifest.healthDeadlineAt !== undefined) {
		const latestPlausibleDeadline = Math.max(manifest.timeoutAt, manifest.finishedAt) + 7 * 24 * 60 * 60 * 1000;
		if (manifest.healthDeadlineAt < manifest.startedAt || manifest.healthDeadlineAt > latestPlausibleDeadline) {
			return { ok: false, code: "invalid_schema" };
		}
	}
	if (!coherentClassification(manifest)) return { ok: false, code: "invalid_schema" };
	const now = expected.now ?? Date.now();
	if (!timestamp(now)) return { ok: false, code: "invalid_schema" };
	if (manifest.finishedAt > now + MAX_TERMINAL_MANIFEST_FUTURE_SKEW_MS || now - manifest.finishedAt > MAX_TERMINAL_MANIFEST_AGE_MS) {
		return { ok: false, code: "stale" };
	}
	return { ok: true, manifest, runDir: "" };
}

export function terminalManifestFromSnapshot(snapshot: BackgroundRunSnapshot, sessionId: string): TerminalRunManifest {
	if (snapshot.status === "running" || snapshot.finishedAt === undefined || snapshot.terminationReason === undefined) {
		throw new Error("terminal snapshot required");
	}
	const candidate: TerminalRunManifest = {
		version: BACKGROUND_RUN_RECORD_VERSION,
		sessionId,
		runId: snapshot.id,
		taskId: snapshot.taskId,
		status: snapshot.status,
		createdAt: snapshot.createdAt,
		startedAt: snapshot.startedAt,
		finishedAt: snapshot.finishedAt,
		timeoutAt: snapshot.timeoutAt,
		terminationReason: snapshot.terminationReason,
		...(snapshot.stopReason === undefined ? {} : { stopReason: snapshot.stopReason }),
		...(snapshot.exitCode === undefined ? {} : { exitCode: snapshot.exitCode }),
		...(snapshot.signal === undefined ? {} : { signal: snapshot.signal }),
		...(snapshot.terminationEscalated ? { terminationEscalated: true as const } : {}),
		...(snapshot.signalDeliveryFailed ? { signalDeliveryFailed: true as const } : {}),
		...(snapshot.healthStatus === undefined ? {} : { healthStatus: snapshot.healthStatus }),
		...(snapshot.healthFailure === undefined ? {} : { healthFailure: snapshot.healthFailure }),
		...(snapshot.healthDeadlineAt === undefined ? {} : { healthDeadlineAt: snapshot.healthDeadlineAt }),
		...(snapshot.lastHeartbeatAt === undefined ? {} : { lastHeartbeatAt: snapshot.lastHeartbeatAt }),
		...(snapshot.lastProgressAt === undefined ? {} : { lastProgressAt: snapshot.lastProgressAt }),
		...(snapshot.unavailableSince === undefined ? {} : { unavailableSince: snapshot.unavailableSince }),
	};
	const parsed = parseTerminalRunManifest(candidate, {
		sessionId,
		runId: snapshot.id,
		taskId: snapshot.taskId,
		now: Math.max(Date.now(), candidate.finishedAt),
	});
	if (!parsed.ok) throw new Error("terminal snapshot violates durable schema");
	return candidate;
}

export function snapshotFromTerminalManifest(manifest: TerminalRunManifest, cwd = ""): BackgroundRunSnapshot {
	return {
		recordVersion: BACKGROUND_RUN_RECORD_VERSION,
		id: manifest.runId,
		taskId: manifest.taskId,
		name: manifest.taskId,
		status: manifest.status,
		cwd,
		createdAt: manifest.createdAt,
		startedAt: manifest.startedAt,
		finishedAt: manifest.finishedAt,
		timeoutAt: manifest.timeoutAt,
		terminationReason: manifest.terminationReason,
		...(manifest.stopReason === undefined ? {} : { stopReason: manifest.stopReason }),
		...(manifest.exitCode === undefined ? {} : { exitCode: manifest.exitCode }),
		...(manifest.signal === undefined ? {} : { signal: manifest.signal }),
		...(manifest.terminationEscalated ? { terminationEscalated: true, timeoutEscalated: manifest.stopReason === "timeout" } : {}),
		...(manifest.signalDeliveryFailed ? { signalDeliveryFailed: true } : {}),
		...(manifest.healthStatus === undefined ? {} : { healthStatus: manifest.healthStatus }),
		...(manifest.healthFailure === undefined ? {} : { healthFailure: manifest.healthFailure }),
		...(manifest.healthDeadlineAt === undefined ? {} : { healthDeadlineAt: manifest.healthDeadlineAt }),
		...(manifest.lastHeartbeatAt === undefined ? {} : { lastHeartbeatAt: manifest.lastHeartbeatAt }),
		...(manifest.lastProgressAt === undefined ? {} : { lastProgressAt: manifest.lastProgressAt }),
		...(manifest.unavailableSince === undefined ? {} : { unavailableSince: manifest.unavailableSince }),
		stdoutTail: "",
		stderrTail: "",
		logTruncated: false,
		manifestPersisted: manifest.terminationReason !== "persistence_failed",
	};
}

async function syncDirectory(directory: string): Promise<void> {
	const handle = await fs.promises.open(directory, fs.constants.O_RDONLY);
	try { await handle.sync(); } finally { await handle.close(); }
}

/** Publish a complete manifest atomically via an exclusive hard link. */
export async function writeTerminalRunManifest(runDir: string, manifest: TerminalRunManifest): Promise<string> {
	const canonicalRun = await fs.promises.realpath(runDir);
	if (canonicalRun !== runDir) throw new Error("unsafe run directory");
	await lstatDirectory(runDir, 0o700);
	const parsed = parseTerminalRunManifest(manifest, {
		sessionId: manifest.sessionId,
		runId: manifest.runId,
		taskId: manifest.taskId,
		now: Math.max(Date.now(), manifest.finishedAt),
	});
	if (!parsed.ok) throw new Error("invalid terminal manifest");
	const target = path.join(runDir, TERMINAL_RUN_MANIFEST_FILE);
	try {
		await fs.promises.lstat(target);
		throw new Error("terminal manifest already exists");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	const temporary = path.join(runDir, `.tmp-${randomBytes(24).toString("hex")}`);
	let handle: fs.promises.FileHandle | undefined;
	try {
		handle = await fs.promises.open(temporary, "wx", 0o600);
		await handle.writeFile(`${JSON.stringify(manifest)}\n`, "utf8");
		await handle.chmod(0o600);
		await handle.sync();
		const stat = await handle.stat();
		if (!stat.isFile() || !ownedByCurrentUser(stat) || !modeIs(stat, 0o600)) throw new Error("unsafe temporary manifest");
		await handle.close();
		handle = undefined;
		await fs.promises.link(temporary, target);
		await fs.promises.unlink(temporary);
		await syncDirectory(runDir);
		const finalStat = await fs.promises.lstat(target);
		if (finalStat.isSymbolicLink() || !finalStat.isFile() || !ownedByCurrentUser(finalStat) || !modeIs(finalStat, 0o600)) {
			throw new Error("unsafe terminal manifest");
		}
		return target;
	} catch (error) {
		await handle?.close().catch(() => {});
		await fs.promises.rm(temporary, { force: true }).catch(() => {});
		throw error;
	}
}

async function locateSecureRunDirectory(runsDir: string, sessionId: string, runId: string): Promise<string> {
	assertSafeIdentity(sessionId, runId);
	const root = await canonicalPrivateRoot(runsDir, false);
	const sessionDir = path.join(root, sessionId);
	await lstatDirectory(sessionDir, 0o700);
	const canonicalSession = await fs.promises.realpath(sessionDir);
	if (!containedBy(root, canonicalSession) || canonicalSession !== sessionDir) throw new Error("unsafe session directory");
	const runDir = path.join(canonicalSession, runId);
	await lstatDirectory(runDir, 0o700);
	const canonicalRun = await fs.promises.realpath(runDir);
	if (!containedBy(canonicalSession, canonicalRun) || canonicalRun !== runDir) throw new Error("unsafe run directory");
	return canonicalRun;
}

/** Read without following symlinks and bind the record to session/run/task. */
export async function readTerminalRunManifest(
	runsDir: string,
	expected: { sessionId: string; runId: string; taskId: string; now?: number },
): Promise<TerminalManifestReadResult> {
	if (!SAFE_SESSION_ID.test(expected.sessionId) || !SAFE_RUN_ID.test(expected.runId) || !SAFE_TASK_ID.test(expected.taskId)) {
		return { ok: false, code: "invalid_identity" };
	}
	let runDir: string;
	try {
		runDir = await locateSecureRunDirectory(runsDir, expected.sessionId, expected.runId);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") return { ok: false, code: "missing" };
		if (String((error as Error).message).includes("mode")) return { ok: false, code: "bad_mode" };
		return { ok: false, code: "unsafe_path" };
	}
	const filePath = path.join(runDir, TERMINAL_RUN_MANIFEST_FILE);
	let handle: fs.promises.FileHandle | undefined;
	try {
		const noFollow = (fs.constants as typeof fs.constants & { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
		handle = await fs.promises.open(filePath, fs.constants.O_RDONLY | noFollow);
		const stat = await handle.stat();
		const linkStat = await fs.promises.lstat(filePath);
		if (linkStat.isSymbolicLink() || !stat.isFile() || !linkStat.isFile() || stat.dev !== linkStat.dev || stat.ino !== linkStat.ino) {
			return { ok: false, code: "unsafe_path" };
		}
		if (!ownedByCurrentUser(stat) || !modeIs(stat, 0o600)) return { ok: false, code: "bad_mode" };
		if (stat.size <= 0 || stat.size > MAX_TERMINAL_MANIFEST_BYTES) return { ok: false, code: "too_large" };
		const text = await handle.readFile("utf8");
		let value: unknown;
		try { value = JSON.parse(text); } catch { return { ok: false, code: "invalid_json" }; }
		const parsed = parseTerminalRunManifest(value, expected);
		return parsed.ok ? { ok: true, manifest: parsed.manifest, runDir } : parsed;
	} catch (error) {
		return { ok: false, code: (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "io_error" };
	} finally {
		await handle?.close().catch(() => {});
	}
}
