import { spawn, type ChildProcess } from "node:child_process";
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
import {
	BACKGROUND_RUN_RECORD_VERSION,
	prepareSecureRunDirectory,
	terminalManifestFromSnapshot,
	writeTerminalRunManifest,
} from "./run-persistence.ts";

export { BACKGROUND_RUN_RECORD_VERSION } from "./run-persistence.ts";
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
	| "recovery_blocked"
	| "persistence_failed"
	| "termination_unconfirmed"
	| "explicit_stop"
	| "session_shutdown";

export interface BackgroundRunSnapshot {
	recordVersion?: typeof BACKGROUND_RUN_RECORD_VERSION;
	id: string;
	taskId: string;
	name: string;
	status: BackgroundRunStatus;
	/** Live-only execution context. Never written to a durable run/wake/web record. */
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
	timeoutEscalated?: boolean;
	signalDeliveryFailed?: boolean;
	stdoutTail: string;
	stderrTail: string;
	logTruncated: boolean;
	/** Live diagnostic only; terminal manifests intentionally omit it. */
	error?: string;
	manifestPersisted?: boolean;
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
	runsDir: string;
	sessionId: string;
	timeoutMs: number;
	healthPolicy?: BackgroundHealthPolicy;
	terminateGraceMs: number;
	killConfirmMs?: number;
	/** @deprecated Output is memory-only; retained as a source-compatibility no-op. */
	maxLogBytes?: number;
	maxTailBytes: number;
	env?: NodeJS.ProcessEnv;
	shell?: string;
	now?: () => number;
	monotonicNow?: () => number;
	onUpdate?: (snapshot: BackgroundRunSnapshot) => void;
	spawnProcess?: typeof spawn;
	signalProcess?: (child: ChildProcess, signal: "SIGTERM" | "SIGKILL") => boolean | void;
}

const TERMINAL = new Set<BackgroundRunStatus>(["completed", "failed", "stopped"]);

function boundedUtf8Tail(previous: string, chunk: string, maxBytes: number): { value: string; truncated: boolean } {
	let value = previous + chunk;
	if (Buffer.byteLength(value, "utf8") <= maxBytes) return { value, truncated: false };
	let start = Math.max(0, value.length - maxBytes);
	value = value.slice(start);
	while (Buffer.byteLength(value, "utf8") > maxBytes && value.length > 0) value = value.slice(1);
	return { value, truncated: true };
}

function signalOwnedProcessGroup(child: ChildProcess, signal: "SIGTERM" | "SIGKILL"): boolean {
	if (process.platform !== "win32" && typeof child.pid === "number" && child.pid > 0) {
		try {
			// The live ChildProcess pid is used only for signalling this owned group.
			return process.kill(-child.pid, signal);
		} catch {
			// A group can disappear between close detection and the signal. Fall back
			// to the direct child handle without exposing or persisting its pid.
		}
	}
	return child.kill(signal);
}

function safeNotify(handler: BackgroundRunOptions["onUpdate"], snapshot: BackgroundRunSnapshot): void {
	try { handler?.({ ...snapshot }); } catch { /* observational */ }
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

function appendDiagnostic(current: string | undefined, next: string): string {
	return current ? `${current.replace(/[.;]\s*$/, "")}; ${next}` : next;
}

export async function startManagedBackgroundRun(options: BackgroundRunOptions): Promise<BackgroundRunController> {
	const rawNow = options.now ?? Date.now;
	const now = () => Math.max(0, Math.round(rawNow()));
	const monotonicNow = options.monotonicNow ?? (() => performance.now());
	const spawnProcess = options.spawnProcess ?? spawn;
	const signalProcess = options.signalProcess ?? signalOwnedProcessGroup;
	const shell = options.shell || (path.isAbsolute(process.env.SHELL ?? "") ? process.env.SHELL! : "/bin/sh");
	const createdAt = now();
	const healthPolicy = options.healthPolicy ? validateBackgroundHealthPolicy(options.healthPolicy) : undefined;
	const maxTailBytes = Math.max(0, Math.floor(options.maxTailBytes));
	const killConfirmMs = Math.max(1, Math.floor(options.killConfirmMs ?? Math.max(1_000, options.terminateGraceMs)));
	const runDir = await prepareSecureRunDirectory(options.runsDir, options.sessionId, options.id, options.taskId);
	let healthMonitor: ReturnType<typeof createBackgroundHealthMonitor> | undefined;
	let outputNotifyTimer: ReturnType<typeof setTimeout> | undefined;
	let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
	let healthTimer: ReturnType<typeof setTimeout> | undefined;
	let graceTimer: ReturnType<typeof setTimeout> | undefined;
	let killConfirmationTimer: ReturnType<typeof setTimeout> | undefined;
	let healthStream: Readable | undefined;
	let healthBuffer = Buffer.alloc(0);
	let child: ChildProcess | undefined;
	let finalized = false;
	let closeObserved = false;
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
		timeoutAt: createdAt + Math.max(0, Math.round(options.timeoutMs)),
		...(healthPolicy ? {
			healthPolicy,
			healthStatus: "awaiting" as const,
			healthDeadlineAt: createdAt + healthPolicy.startupGraceMs,
		} : {}),
		stdoutTail: "",
		stderrTail: "",
		logTruncated: false,
	};

	const clearTimers = () => {
		if (outputNotifyTimer) clearTimeout(outputNotifyTimer);
		if (timeoutTimer) clearTimeout(timeoutTimer);
		if (healthTimer) clearTimeout(healthTimer);
		if (graceTimer) clearTimeout(graceTimer);
		if (killConfirmationTimer) clearTimeout(killConfirmationTimer);
		outputNotifyTimer = undefined;
		timeoutTimer = undefined;
		healthTimer = undefined;
		graceTimer = undefined;
		killConfirmationTimer = undefined;
	};

	const finalize = async (fields: Partial<BackgroundRunSnapshot>) => {
		if (finalized) return;
		finalized = true;
		clearTimers();
		healthStream?.destroy();
		healthStream = undefined;
		Object.assign(snapshot, fields, { finishedAt: fields.finishedAt ?? now() });
		try {
			const manifest = terminalManifestFromSnapshot(snapshot, options.sessionId);
			await writeTerminalRunManifest(runDir, manifest);
			snapshot.manifestPersisted = true;
		} catch {
			// A terminal state without a securely published manifest is not reported
			// as a durable success. The session outbox can still carry this bounded,
			// privacy-safe failure classification during the current runtime.
			snapshot.status = "failed";
			snapshot.terminationReason = "persistence_failed";
			snapshot.manifestPersisted = false;
			snapshot.error = appendDiagnostic(snapshot.error, "Secure terminal recovery persistence failed.");
		}
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
		const text = (Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)).toString("utf8");
		snapshot.lastOutputAt = now();
		const bounded = boundedUtf8Tail(kind === "stdout" ? snapshot.stdoutTail : snapshot.stderrTail, text, maxTailBytes);
		if (kind === "stdout") snapshot.stdoutTail = bounded.value;
		else snapshot.stderrTail = bounded.value;
		if (bounded.truncated) snapshot.logTruncated = true;
		scheduleOutputNotify();
	};

	const attemptSignal = (signal: "SIGTERM" | "SIGKILL"): boolean => {
		if (!child) return false;
		try {
			const result = signalProcess(child, signal);
			if (result === false) {
				snapshot.signalDeliveryFailed = true;
				snapshot.error = appendDiagnostic(snapshot.error, `${signal} delivery was not confirmed.`);
				return false;
			}
			return true;
		} catch {
			snapshot.signalDeliveryFailed = true;
			snapshot.error = appendDiagnostic(snapshot.error, `${signal} delivery failed.`);
			return false;
		}
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
		attemptSignal("SIGTERM");
		if (finalized || closeObserved) return true;
		graceTimer = setTimeout(() => {
			graceTimer = undefined;
			if (finalized || closeObserved || !child) return;
			snapshot.terminationEscalated = true;
			if (reason === "timeout") snapshot.timeoutEscalated = true;
			const killDelivered = attemptSignal("SIGKILL");
			if (finalized || closeObserved) return;
			safeNotify(options.onUpdate, snapshot);
			killConfirmationTimer = setTimeout(() => {
				killConfirmationTimer = undefined;
				if (finalized || closeObserved) return;
				void finalize({
					status: "failed",
					terminationReason: "termination_unconfirmed",
					...(killDelivered ? { signal: "SIGKILL" } : {}),
					error: appendDiagnostic(baseError, "Process termination was not confirmed after bounded TERM/KILL cleanup."),
				});
			}, killConfirmMs);
			killConfirmationTimer.unref?.();
		}, Math.max(0, options.terminateGraceMs));
		graceTimer.unref?.();
		safeNotify(options.onUpdate, snapshot);
		return true;
	};

	const copyHealthSnapshot = () => {
		if (!healthMonitor) return;
		const health = healthMonitor.snapshot();
		snapshot.healthStatus = health.status;
		snapshot.healthDeadlineAt = now() + Math.max(0, Math.round(health.deadlineAt - monotonicNow()));
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
			health = healthMonitor.failProtocol(error instanceof Error ? error.message : "invalid health record", monotonicNow());
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
		child.once("error", () => {
			if (snapshot.stopReason) return;
			void finalize({
				status: "failed",
				terminationReason: "spawn_error",
				exitCode: 1,
				error: "Managed process failed to start.",
			});
		});
		child.once("close", (code, signal) => {
			closeObserved = true;
			if (finalized) return;
			const stopReason = snapshot.stopReason;
			if (stopReason === "timeout") {
				void finalize({
					status: "failed",
					terminationReason: "timed_out",
					exitCode: code ?? undefined,
					signal: signal ?? undefined,
					error: appendDiagnostic(
						`Background task timed out after ${compactDuration(options.timeoutMs)}.`,
						snapshot.terminationEscalated ? `SIGKILL followed a ${compactDuration(options.terminateGraceMs)} grace period.` : "",
					).replace(/;\s*$/, ""),
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
	} catch {
		void finalize({
			status: "failed",
			terminationReason: "spawn_error",
			exitCode: 1,
			error: "Managed process failed to start.",
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
