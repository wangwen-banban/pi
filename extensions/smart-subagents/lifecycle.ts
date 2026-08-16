import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type ActiveJobStatus = "routing" | "queued" | "running";
export type TerminalJobStatus = "completed" | "failed" | "stopped";
export type LifecycleJobStatus = ActiveJobStatus | TerminalJobStatus;
export type StopRequestKind = "user" | "shutdown";
export type TerminationReason =
	| "completed"
	| "exit_nonzero"
	| "child_error"
	| "signal"
	| "explicit_stop"
	| "session_shutdown"
	| "timed_out"
	| "spawn_error"
	| "routing_error";

export interface TimerScheduler {
	setTimeout(callback: () => void, delayMs: number): unknown;
	clearTimeout(handle: unknown): void;
}

export const nativeTimerScheduler: TimerScheduler = {
	setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
	clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

function unrefTimer(handle: unknown): void {
	if (handle && typeof handle === "object" && "unref" in handle) {
		(handle as { unref?: () => void }).unref?.();
	}
}

/**
 * A recursive timeout rather than an interval keeps at most one refresh queued.
 * `sync()` is cheap and may be called after every job state change.
 */
export function createActivityRefreshLoop(options: {
	hasActiveJobs: () => boolean;
	onTick: () => void;
	intervalMs?: number;
	timers?: TimerScheduler;
}) {
	const timers = options.timers ?? nativeTimerScheduler;
	const intervalMs = Math.max(100, options.intervalMs ?? 1000);
	let timer: unknown;

	const clear = () => {
		if (timer === undefined) return;
		timers.clearTimeout(timer);
		timer = undefined;
	};

	const schedule = () => {
		if (timer !== undefined || !options.hasActiveJobs()) return;
		timer = timers.setTimeout(() => {
			timer = undefined;
			if (!options.hasActiveJobs()) return;
			try {
				options.onTick();
			} catch {
				// A stale or tearing-down UI must not turn a refresh tick into a crash.
			} finally {
				// onTick may itself call sync(); never enqueue a second timer.
				if (timer === undefined && options.hasActiveJobs()) schedule();
			}
		}, intervalMs);
		unrefTimer(timer);
	};

	return {
		sync() {
			if (options.hasActiveJobs()) schedule();
			else clear();
		},
		stop: clear,
		get running() {
			return timer !== undefined;
		},
	};
}

export interface KillableProcess {
	kill(signal: "SIGTERM" | "SIGKILL"): boolean;
}

export interface TerminationController {
	cancel(): void;
	readonly escalated: boolean;
}

function safeKill(process: KillableProcess, signal: "SIGTERM" | "SIGKILL"): void {
	try {
		process.kill(signal);
	} catch {
		// The close/error path owns final classification; a raced process exit is benign.
	}
}

/** Send SIGTERM now and SIGKILL after a bounded grace period unless cancelled. */
export function terminateWithGrace(options: {
	process: KillableProcess;
	graceMs: number;
	timers?: TimerScheduler;
	onEscalate?: () => void;
}): TerminationController {
	const timers = options.timers ?? nativeTimerScheduler;
	let graceTimer: unknown;
	let cancelled = false;
	let escalated = false;

	safeKill(options.process, "SIGTERM");
	graceTimer = timers.setTimeout(() => {
		graceTimer = undefined;
		if (cancelled) return;
		escalated = true;
		safeKill(options.process, "SIGKILL");
		try {
			options.onEscalate?.();
		} catch {
			// Signalling succeeded; lifecycle observers cannot undo it.
		}
	}, Math.max(0, options.graceMs));
	unrefTimer(graceTimer);

	return {
		cancel() {
			cancelled = true;
			if (graceTimer !== undefined) {
				timers.clearTimeout(graceTimer);
				graceTimer = undefined;
			}
		},
		get escalated() {
			return escalated;
		},
	};
}

/**
 * Arm a hard wall-clock execution cap. At expiry the worker receives SIGTERM;
 * an uncooperative worker receives SIGKILL after `graceMs`.
 */
export function createExecutionTimeout(options: {
	process: KillableProcess;
	timeoutMs: number;
	graceMs: number;
	timers?: TimerScheduler;
	onTimeout: () => void;
	onEscalate: () => void;
}) {
	const timers = options.timers ?? nativeTimerScheduler;
	let hardTimer: unknown;
	let termination: TerminationController | undefined;
	let cancelled = false;
	let timedOut = false;

	hardTimer = timers.setTimeout(() => {
		hardTimer = undefined;
		if (cancelled) return;
		timedOut = true;
		try {
			options.onTimeout();
		} catch {
			// The hard cap must still terminate the worker if reporting fails.
		}
		if (cancelled) return;
		termination = terminateWithGrace({
			process: options.process,
			graceMs: options.graceMs,
			timers,
			onEscalate: () => {
				if (!cancelled) {
					try {
						options.onEscalate();
					} catch {
						// Escalation is already complete; finalization can recover on close.
					}
				}
			},
		});
	}, Math.max(0, options.timeoutMs));
	unrefTimer(hardTimer);

	return {
		cancel() {
			cancelled = true;
			if (hardTimer !== undefined) {
				timers.clearTimeout(hardTimer);
				hardTimer = undefined;
			}
			termination?.cancel();
		},
		get timedOut() {
			return timedOut;
		},
		get escalated() {
			return termination?.escalated ?? false;
		},
	};
}

export interface FinalOutcome {
	status: TerminalJobStatus;
	exitCode: number;
	signal?: string;
	terminationReason: TerminationReason;
	error?: string;
}

function signalExitCode(signal: string | null): number {
	if (!signal) return 1;
	const signalNumber = (os.constants.signals as Record<string, number>)[signal];
	return typeof signalNumber === "number" ? 128 + signalNumber : 1;
}

function compactDuration(ms: number): string {
	const seconds = Math.max(1, Math.round(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const remainder = seconds % 60;
	return remainder === 0 ? `${minutes}m` : `${minutes}m ${remainder}s`;
}

export function timeoutFailureMessage(timeoutMs: number, graceMs: number, escalated: boolean): string {
	const timeout = compactDuration(timeoutMs);
	const grace = compactDuration(graceMs);
	return escalated
		? `Worker timed out after the ${timeout} hard execution limit. SIGTERM did not stop it within the ${grace} grace period, so SIGKILL was sent. Increase execution.hardTimeoutMs only if this task is expected to run longer.`
		: `Worker timed out after the ${timeout} hard execution limit and was stopped with SIGTERM during the ${grace} grace period. Increase execution.hardTimeoutMs only if this task is expected to run longer.`;
}

export function classifyChildClose(input: {
	code: number | null;
	signal: string | null;
	stopRequest?: StopRequestKind;
	timedOut?: boolean;
	timeoutEscalated?: boolean;
	hardTimeoutMs: number;
	terminateGraceMs: number;
	childStopReason?: string;
	error?: string;
	stderr?: string;
}): FinalOutcome {
	const exitCode = input.code ?? signalExitCode(input.signal);
	if (input.timedOut) {
		return {
			status: "failed",
			exitCode,
			signal: input.signal ?? undefined,
			terminationReason: "timed_out",
			error: timeoutFailureMessage(input.hardTimeoutMs, input.terminateGraceMs, Boolean(input.timeoutEscalated)),
		};
	}
	if (input.stopRequest) {
		const shutdown = input.stopRequest === "shutdown";
		return {
			status: "stopped",
			exitCode,
			signal: input.signal ?? undefined,
			terminationReason: shutdown ? "session_shutdown" : "explicit_stop",
			error: shutdown ? "Stopped because the parent session shut down." : "Stopped by /agents stop.",
		};
	}
	if (input.signal) {
		return {
			status: "failed",
			exitCode,
			signal: input.signal,
			terminationReason: "signal",
			error: `Worker was terminated by external signal ${input.signal} (exit code ${exitCode}). Check the host, process supervisor, or resource limits before retrying.`,
		};
	}
	const childReportedFailure = input.childStopReason === "error" || input.childStopReason === "aborted";
	if (input.code === null || input.code !== 0 || childReportedFailure) {
		const detail = input.error?.trim() || input.stderr?.trim();
		return {
			status: "failed",
			exitCode,
			terminationReason: childReportedFailure ? "child_error" : "exit_nonzero",
			error: detail || (input.code === null
				? "Worker closed without an exit code or signal. Inspect the run log and retry."
				: `Worker exited with code ${input.code}. Inspect the run log and stderr before retrying.`),
		};
	}
	return {
		status: "completed",
		exitCode: 0,
		terminationReason: "completed",
	};
}

export interface FinalizableJob {
	status: LifecycleJobStatus;
	finishedAt?: number;
	exitCode?: number;
	signal?: string;
	terminationReason?: TerminationReason;
	error?: string;
	process?: unknown;
}

/** Atomically claim a terminal transition so error/close races cannot finalize twice. */
export function applyFinalOutcome(job: FinalizableJob, outcome: FinalOutcome, now = Date.now()): boolean {
	if (isTerminalStatus(job.status)) return false;
	job.status = outcome.status;
	job.exitCode = outcome.exitCode;
	job.signal = outcome.signal;
	job.terminationReason = outcome.terminationReason;
	job.finishedAt = now;
	if (outcome.error) job.error = outcome.error;
	job.process = undefined;
	return true;
}

export function isTerminalStatus(status: LifecycleJobStatus): status is TerminalJobStatus {
	return status === "completed" || status === "failed" || status === "stopped";
}

/**
 * Stop every non-terminal job. Running processes are terminated, while routing
 * and queued jobs are still finalized and persisted by the supplied callback.
 */
export async function shutdownJobs<T extends { status: LifecycleJobStatus; process?: unknown }>(
	jobs: Iterable<T>,
	options: {
		markStopping: (job: T) => void;
		finalize: (job: T) => void | Promise<void>;
		terminate: (process: unknown, job: T) => void;
		onError?: (error: unknown, job: T) => void;
	},
): Promise<number> {
	const targets = [...jobs].filter((job) => !isTerminalStatus(job.status));
	const writes: Promise<void>[] = [];
	for (const job of targets) {
		const wasRunning = job.status === "running";
		const process = job.process;
		options.markStopping(job);
		try {
			writes.push(Promise.resolve(options.finalize(job)).catch((error) => options.onError?.(error, job)));
		} catch (error) {
			options.onError?.(error, job);
		}
		if (wasRunning && process) {
			try {
				options.terminate(process, job);
			} catch (error) {
				options.onError?.(error, job);
			}
		}
	}
	await Promise.all(writes);
	return targets.length;
}

/** Write a user-private JSON record through a same-directory atomic rename. */
export async function writeJsonAtomically(filePath: string, value: unknown): Promise<void> {
	await fs.promises.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
	const temporaryPath = path.join(
		path.dirname(filePath),
		`.${path.basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
	);
	try {
		await fs.promises.writeFile(temporaryPath, JSON.stringify(value, null, 2), {
			encoding: "utf8",
			mode: 0o600,
		});
		await fs.promises.rename(temporaryPath, filePath);
	} catch (error) {
		await fs.promises.rm(temporaryPath, { force: true }).catch(() => {});
		throw error;
	}
}
