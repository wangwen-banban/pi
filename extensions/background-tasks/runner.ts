import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import type { Readable } from "node:stream";
import {
	MAX_HEALTH_REPORT_BYTES,
	createBackgroundHealthMonitor,
	parseBackgroundHealthReport,
	validateBackgroundHealthPolicy,
	type BackgroundHealthFailure,
	type BackgroundHealthFailureCode,
	type BackgroundHealthPolicy,
	type BackgroundHealthSnapshot,
	type BackgroundHealthStatus,
} from "./health-policy.ts";

export const BACKGROUND_RUN_RECORD_VERSION = 2;
export type BackgroundRunStatus = "running" | "completed" | "failed" | "stopped";
export type BackgroundStopReason = "user" | "shutdown" | "timeout" | "health_policy";
export type BackgroundTerminationReason =
	| "completed"
	| "exit_nonzero"
	| "signal"
	| "spawn_error"
	| "timed_out"
	| "health_policy_failed"
	| "monitor_restarted"
	| "explicit_stop"
	| "session_shutdown";

export interface BackgroundRunSnapshot {
	recordVersion?: typeof BACKGROUND_RUN_RECORD_VERSION;
	id: string;
	taskId: string;
	name: string;
	status: BackgroundRunStatus;
	cwd: string;
	createdAt: number;
	startedAt: number;
	finishedAt?: number;
	lastOutputAt?: number;
	timeoutAt: number;
	healthPolicy?: BackgroundHealthPolicy;
	healthStatus?: BackgroundHealthStatus;
	healthFailure?: BackgroundHealthFailureCode;
	healthDeadlineAt?: number;
	lastHeartbeatAt?: number;
	lastProgressAt?: number;
	unavailableSince?: number;
	exitCode?: number;
	signal?: string;
	terminationReason?: BackgroundTerminationReason;
	stopReason?: BackgroundStopReason;
	terminationEscalated?: boolean;
	/** @deprecated Prefer terminationEscalated; retained for persisted v1 results. */
	timeoutEscalated?: boolean;
	stdoutTail: string;
	stderrTail: string;
	stdoutPath: string;
	stderrPath: string;
	resultPath: string;
	logTruncated: boolean;
	error?: string;
}

export interface BackgroundRunController {
	readonly completion: Promise<BackgroundRunSnapshot>;
	snapshot(): BackgroundRunSnapshot;
	stop(reason?: "user" | "shutdown"): boolean;
}

export interface BackgroundRunOptions {
	id: string;
	taskId: string;
	name: string;
	command: string;
	cwd: string;
	runDir: string;
	timeoutMs: number;
	healthPolicy?: BackgroundHealthPolicy;
	terminateGraceMs: number;
	maxLogBytes: number;
	maxTailBytes: number;
	env?: NodeJS.ProcessEnv;
	shell?: string;
	now?: () => number;
	monotonicNow?: () => number;
	onUpdate?: (snapshot: BackgroundRunSnapshot) => void;
	spawnProcess?: typeof spawn;
	signalProcess?: (child: ChildProcess, signal: "SIGTERM" | "SIGKILL") => void;
}

const TERMINAL = new Set<BackgroundRunStatus>(["completed", "failed", "stopped"]);

function boundedUtf8Tail(previous: string, chunk: string, maxBytes: number): string {
	let value = previous + chunk;
	if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
	let start = Math.max(0, value.length - maxBytes);
	value = value.slice(start);
	while (Buffer.byteLength(value, "utf8") > maxBytes && value.length > 0) value = value.slice(1);
	return value;
}

async function writeJsonAtomically(filePath: string, value: unknown): Promise<void> {
	await fs.promises.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
	const temporaryPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
	try {
		await fs.promises.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
		await fs.promises.rename(temporaryPath, filePath);
	} catch (error) {
		await fs.promises.rm(temporaryPath, { force: true }).catch(() => {});
		throw error;
	}
}

function signalOwnedProcessGroup(child: ChildProcess, signal: "SIGTERM" | "SIGKILL"): void {
	if (process.platform !== "win32" && typeof child.pid === "number" && child.pid > 0) {
		try {
			// The child was spawned detached solely to give this runtime an exact
			// process group. The pid is used only from the live ChildProcess handle;
			// it is never persisted or accepted from a caller.
			process.kill(-child.pid, signal);
			return;
		} catch {
			// Fall through to the direct child signal if the group already exited.
		}
	}
	try {
		child.kill(signal);
	} catch {
		// The close/error path owns final classification.
	}
}

function safeNotify(handler: BackgroundRunOptions["onUpdate"], snapshot: BackgroundRunSnapshot): void {
	try {
		handler?.({ ...snapshot });
	} catch {
		// Observability cannot break lifecycle finalization.
	}
}

function compactDuration(ms: number): string {
	const seconds = Math.max(1, Math.round(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const remainder = seconds % 60;
	return remainder === 0 ? `${minutes}m` : `${minutes}m ${remainder}s`;
}

function healthFailureMessage(failure: BackgroundHealthFailure, policy: BackgroundHealthPolicy): string {
	switch (failure.code) {
		case "startup_timeout":
			return `Background health policy failed: no valid health report arrived within the ${compactDuration(policy.startupGraceMs)} startup grace period.`;
		case "heartbeat_timeout":
			return `Background health policy failed: the health heartbeat was silent for ${compactDuration(policy.heartbeatTimeoutMs)}.`;
		case "unavailable_timeout":
			return `Background health policy failed: health remained unavailable for ${compactDuration(policy.unavailableTimeoutMs)}.`;
		case "stale_progress":
			return `Background health policy failed: the progress token did not change for ${compactDuration(policy.staleProgressTimeoutMs ?? 0)} while health was available.`;
		case "protocol_error":
			return `Background health policy failed: invalid control record${failure.detail ? ` (${failure.detail})` : ""}.`;
	}
}

export async function startManagedBackgroundRun(options: BackgroundRunOptions): Promise<BackgroundRunController> {
	const now = options.now ?? Date.now;
	const monotonicNow = options.monotonicNow ?? (() => performance.now());
	const spawnProcess = options.spawnProcess ?? spawn;
	const signalProcess = options.signalProcess ?? signalOwnedProcessGroup;
	const shell = options.shell || (path.isAbsolute(process.env.SHELL ?? "") ? process.env.SHELL! : "/bin/sh");
	const createdAt = now();
	const healthPolicy = options.healthPolicy ? validateBackgroundHealthPolicy(options.healthPolicy) : undefined;
	let healthMonitor: ReturnType<typeof createBackgroundHealthMonitor> | undefined;
	const stdoutPath = path.join(options.runDir, "stdout.log");
	const stderrPath = path.join(options.runDir, "stderr.log");
	const resultPath = path.join(options.runDir, "result.json");
	const metadataPath = path.join(options.runDir, "metadata.json");
	await fs.promises.mkdir(options.runDir, { recursive: true, mode: 0o700 });
	try { await fs.promises.chmod(options.runDir, 0o700); } catch { /* best effort */ }
	await writeJsonAtomically(metadataPath, {
		version: BACKGROUND_RUN_RECORD_VERSION,
		id: options.id,
		taskId: options.taskId,
		name: options.name,
		command: options.command,
		cwd: options.cwd,
		createdAt,
		timeoutMs: options.timeoutMs,
		...(healthPolicy ? { healthPolicy, healthFd: 3 } : {}),
	});

	const stdoutStream = fs.createWriteStream(stdoutPath, { flags: "a", mode: 0o600 });
	const stderrStream = fs.createWriteStream(stderrPath, { flags: "a", mode: 0o600 });
	// A disk failure is reflected in the terminal result; it must never become
	// an unhandled stream error that crashes the parent Pi runtime.
	let logWriteError = "";
	stdoutStream.on("error", (error) => { logWriteError ||= `stdout log failed: ${error.message}`; });
	stderrStream.on("error", (error) => { logWriteError ||= `stderr log failed: ${error.message}`; });
	let stdoutBytes = 0;
	let stderrBytes = 0;
	let outputNotifyTimer: ReturnType<typeof setTimeout> | undefined;
	let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
	let healthTimer: ReturnType<typeof setTimeout> | undefined;
	let graceTimer: ReturnType<typeof setTimeout> | undefined;
	let healthStream: Readable | undefined;
	let healthBuffer = Buffer.alloc(0);
	let child: ChildProcess | undefined;
	let finalized = false;
	let resolveCompletion!: (snapshot: BackgroundRunSnapshot) => void;
	const completion = new Promise<BackgroundRunSnapshot>((resolve) => { resolveCompletion = resolve; });
	const snapshot: BackgroundRunSnapshot = {
		recordVersion: BACKGROUND_RUN_RECORD_VERSION,
		id: options.id,
		taskId: options.taskId,
		name: options.name,
		status: "running",
		cwd: options.cwd,
		createdAt,
		startedAt: createdAt,
		timeoutAt: createdAt + options.timeoutMs,
		...(healthPolicy ? {
			healthPolicy,
			healthStatus: "awaiting" as const,
			healthDeadlineAt: createdAt + healthPolicy.startupGraceMs,
		} : {}),
		stdoutTail: "",
		stderrTail: "",
		stdoutPath,
		stderrPath,
		resultPath,
		logTruncated: false,
	};

	const clearTimers = () => {
		if (outputNotifyTimer) clearTimeout(outputNotifyTimer);
		if (timeoutTimer) clearTimeout(timeoutTimer);
		if (healthTimer) clearTimeout(healthTimer);
		if (graceTimer) clearTimeout(graceTimer);
		outputNotifyTimer = undefined;
		timeoutTimer = undefined;
		healthTimer = undefined;
		graceTimer = undefined;
	};

	const flushStreams = async () => {
		const close = (stream: fs.WriteStream) => new Promise<void>((resolve) => {
			if (stream.closed) return resolve();
			stream.once("close", () => resolve());
			stream.end();
		});
		await Promise.all([close(stdoutStream), close(stderrStream)]);
	};

	const finalize = async (fields: Partial<BackgroundRunSnapshot>) => {
		if (finalized) return;
		finalized = true;
		clearTimers();
		healthStream?.destroy();
		healthStream = undefined;
		Object.assign(snapshot, fields, { finishedAt: fields.finishedAt ?? now() });
		await flushStreams().catch(() => {});
		if (logWriteError) {
			snapshot.error = snapshot.error ? `${snapshot.error}; ${logWriteError}` : logWriteError;
		}
		await writeJsonAtomically(resultPath, snapshot).catch((error) => {
			snapshot.error = snapshot.error
				? `${snapshot.error}; result persistence failed: ${error instanceof Error ? error.message : String(error)}`
				: `Result persistence failed: ${error instanceof Error ? error.message : String(error)}`;
		});
		safeNotify(options.onUpdate, snapshot);
		resolveCompletion({ ...snapshot });
	};

	const scheduleOutputNotify = () => {
		if (outputNotifyTimer || finalized) return;
		outputNotifyTimer = setTimeout(() => {
			outputNotifyTimer = undefined;
			safeNotify(options.onUpdate, snapshot);
		}, 250);
		outputNotifyTimer.unref?.();
	};

	const writeChunk = (kind: "stdout" | "stderr", chunk: Buffer | string) => {
		if (finalized) return;
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		const text = buffer.toString("utf8");
		snapshot.lastOutputAt = now();
		if (kind === "stdout") {
			snapshot.stdoutTail = boundedUtf8Tail(snapshot.stdoutTail, text, options.maxTailBytes);
			const remaining = Math.max(0, options.maxLogBytes - stdoutBytes);
			if (remaining > 0) {
				const piece = buffer.subarray(0, remaining);
				stdoutBytes += piece.byteLength;
				stdoutStream.write(piece);
			}
			if (buffer.byteLength > remaining) snapshot.logTruncated = true;
		} else {
			snapshot.stderrTail = boundedUtf8Tail(snapshot.stderrTail, text, options.maxTailBytes);
			const remaining = Math.max(0, options.maxLogBytes - stderrBytes);
			if (remaining > 0) {
				const piece = buffer.subarray(0, remaining);
				stderrBytes += piece.byteLength;
				stderrStream.write(piece);
			}
			if (buffer.byteLength > remaining) snapshot.logTruncated = true;
		}
		scheduleOutputNotify();
	};

	let activeHealthFailure: BackgroundHealthFailure | undefined;
	const requestStop = (reason: BackgroundStopReason, healthFailure?: BackgroundHealthFailure): boolean => {
		if (finalized || TERMINAL.has(snapshot.status) || snapshot.stopReason) return false;
		snapshot.stopReason = reason;
		if (healthFailure) {
			activeHealthFailure = healthFailure;
			snapshot.healthFailure = healthFailure.code;
			snapshot.error = healthPolicy ? healthFailureMessage(healthFailure, healthPolicy) : "Background health policy failed.";
		}
		if (timeoutTimer) clearTimeout(timeoutTimer);
		if (healthTimer) clearTimeout(healthTimer);
		timeoutTimer = undefined;
		healthTimer = undefined;
		const failed = reason === "timeout" || reason === "health_policy";
		const terminationReason: BackgroundTerminationReason = reason === "timeout"
			? "timed_out"
			: reason === "health_policy"
				? "health_policy_failed"
				: reason === "shutdown"
					? "session_shutdown"
					: "explicit_stop";
		const baseError = reason === "timeout"
			? `Background task timed out after ${compactDuration(options.timeoutMs)}.`
			: reason === "health_policy"
				? snapshot.error
				: undefined;
		if (!child) {
			void finalize({ status: failed ? "failed" : "stopped", terminationReason, error: baseError });
			return true;
		}
		signalProcess(child, "SIGTERM");
		graceTimer = setTimeout(() => {
			graceTimer = undefined;
			if (finalized || !child) return;
			snapshot.terminationEscalated = true;
			if (reason === "timeout") snapshot.timeoutEscalated = true;
			signalProcess(child, "SIGKILL");
			const suffix = ` SIGKILL followed a ${compactDuration(options.terminateGraceMs)} grace period.`;
			void finalize({
				status: failed ? "failed" : "stopped",
				terminationReason,
				signal: "SIGKILL",
				error: baseError ? `${baseError.replace(/\.$/, "")};${suffix}` : undefined,
			});
		}, Math.max(0, options.terminateGraceMs));
		graceTimer.unref?.();
		safeNotify(options.onUpdate, snapshot);
		return true;
	};

	const copyHealthSnapshot = () => {
		if (!healthMonitor) return;
		const health = healthMonitor.snapshot();
		snapshot.healthStatus = health.status;
		// Public timestamps stay in epoch milliseconds for persistence/UI, while
		// enforcement uses the monotonic clock and cannot be extended by a wall
		// clock rollback.
		snapshot.healthDeadlineAt = now() + Math.max(0, health.deadlineAt - monotonicNow());
		if (health.failure) snapshot.healthFailure = health.failure.code;
	};

	const scheduleHealthCheck = () => {
		if (!healthMonitor || finalized || snapshot.stopReason) return;
		if (healthTimer) clearTimeout(healthTimer);
		copyHealthSnapshot();
		const delay = Math.max(0, healthMonitor.snapshot().deadlineAt - monotonicNow());
		healthTimer = setTimeout(() => {
			healthTimer = undefined;
			if (finalized || snapshot.stopReason) return;
			const health = healthMonitor.evaluate(monotonicNow());
			copyHealthSnapshot();
			if (health.failure) requestStop("health_policy", health.failure);
			else scheduleHealthCheck();
		}, delay);
		healthTimer.unref?.();
	};

	const acceptHealthLine = (line: Buffer) => {
		if (!healthMonitor || finalized || snapshot.stopReason) return;
		const text = line.toString("utf8").replace(/\r$/, "");
		if (!text.trim()) return;
		let health: BackgroundHealthSnapshot;
		let validReport = false;
		const before = healthMonitor.snapshot();
		const observedAt = now();
		try {
			health = healthMonitor.report(parseBackgroundHealthReport(text), monotonicNow());
			validReport = true;
		} catch (error) {
			health = healthMonitor.failProtocol(error instanceof Error ? error.message : String(error), monotonicNow());
		}
		if (validReport) snapshot.lastHeartbeatAt = observedAt;
		if (validReport && health.lastProgressAt !== before.lastProgressAt) snapshot.lastProgressAt = observedAt;
		if (validReport && health.unavailableSince === undefined) snapshot.unavailableSince = undefined;
		else if (validReport && health.unavailableSince !== before.unavailableSince) snapshot.unavailableSince = observedAt;
		copyHealthSnapshot();
		safeNotify(options.onUpdate, snapshot);
		if (health.failure) requestStop("health_policy", health.failure);
		else scheduleHealthCheck();
	};

	const acceptHealthChunk = (chunk: Buffer | string) => {
		if (!healthMonitor || finalized || snapshot.stopReason) return;
		healthBuffer = Buffer.concat([healthBuffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
		while (true) {
			const newline = healthBuffer.indexOf(0x0a);
			if (newline < 0) break;
			if (newline > MAX_HEALTH_REPORT_BYTES) {
				const health = healthMonitor.failProtocol(`health report exceeds ${MAX_HEALTH_REPORT_BYTES} bytes`, monotonicNow());
				copyHealthSnapshot();
				requestStop("health_policy", health.failure);
				return;
			}
			const line = healthBuffer.subarray(0, newline);
			healthBuffer = healthBuffer.subarray(newline + 1);
			acceptHealthLine(line);
			if (snapshot.stopReason) return;
		}
		if (healthBuffer.byteLength > MAX_HEALTH_REPORT_BYTES) {
			const health = healthMonitor.failProtocol(`health report exceeds ${MAX_HEALTH_REPORT_BYTES} bytes`, monotonicNow());
			copyHealthSnapshot();
			requestStop("health_policy", health.failure);
		}
	};

	try {
		healthMonitor = healthPolicy ? createBackgroundHealthMonitor(healthPolicy, monotonicNow()) : undefined;
		copyHealthSnapshot();
		child = spawnProcess(shell, ["-lc", options.command], {
			cwd: options.cwd,
			env: {
				...process.env,
				...(options.env ?? {}),
				...(healthPolicy ? { PI_BACKGROUND_TASK_HEALTH_FD: "3" } : {}),
			},
			detached: process.platform !== "win32",
			stdio: healthPolicy ? ["ignore", "pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"],
		});
		child.stdout?.on("data", (chunk) => writeChunk("stdout", chunk));
		child.stderr?.on("data", (chunk) => writeChunk("stderr", chunk));
		if (healthMonitor) {
			healthStream = child.stdio[3] as Readable | undefined;
			if (healthStream) healthStream.on("data", acceptHealthChunk);
			else {
				const health = healthMonitor.failProtocol("managed process did not expose health fd 3", monotonicNow());
				copyHealthSnapshot();
				requestStop("health_policy", health.failure);
			}
		}
		child.once("error", (error) => {
			void finalize({
				status: "failed",
				terminationReason: "spawn_error",
				exitCode: 1,
				error: error.message,
			});
		});
		child.once("close", (code, signal) => {
			if (finalized) return;
			const stopReason = snapshot.stopReason;
			if (stopReason === "timeout") {
				void finalize({
					status: "failed",
					terminationReason: "timed_out",
					exitCode: code ?? undefined,
					signal: signal ?? undefined,
					error: `Background task timed out after ${compactDuration(options.timeoutMs)}${snapshot.terminationEscalated ? `; SIGKILL followed a ${compactDuration(options.terminateGraceMs)} grace period` : ""}.`,
				});
				return;
			}
			if (stopReason === "health_policy") {
				void finalize({
					status: "failed",
					terminationReason: "health_policy_failed",
					exitCode: code ?? undefined,
					signal: signal ?? undefined,
					error: snapshot.error ?? (activeHealthFailure && healthPolicy ? healthFailureMessage(activeHealthFailure, healthPolicy) : "Background health policy failed."),
				});
				return;
			}
			if (stopReason === "user" || stopReason === "shutdown") {
				void finalize({
					status: "stopped",
					terminationReason: stopReason === "shutdown" ? "session_shutdown" : "explicit_stop",
					exitCode: code ?? undefined,
					signal: signal ?? undefined,
				});
				return;
			}
			if (signal) {
				void finalize({
					status: "failed",
					terminationReason: "signal",
					signal,
					error: `Background task exited after signal ${signal}.`,
				});
				return;
			}
			if (code === 0) {
				void finalize({ status: "completed", terminationReason: "completed", exitCode: 0 });
				return;
			}
			void finalize({
				status: "failed",
				terminationReason: "exit_nonzero",
				exitCode: code ?? 1,
				error: `Background task exited with code ${code ?? "unknown"}.`,
			});
		});
	} catch (error) {
		void finalize({
			status: "failed",
			terminationReason: "spawn_error",
			exitCode: 1,
			error: error instanceof Error ? error.message : String(error),
		});
	}

	if (!finalized) {
		timeoutTimer = setTimeout(() => requestStop("timeout"), Math.max(0, options.timeoutMs));
		timeoutTimer.unref?.();
		if (healthMonitor && !snapshot.stopReason) scheduleHealthCheck();
	}
	safeNotify(options.onUpdate, snapshot);

	return {
		completion,
		snapshot: () => ({ ...snapshot }),
		stop: (reason = "user") => requestStop(reason),
	};
}
