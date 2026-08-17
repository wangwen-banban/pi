import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

export type BackgroundRunStatus = "running" | "completed" | "failed" | "stopped";
export type BackgroundStopReason = "user" | "shutdown" | "timeout";
export type BackgroundTerminationReason =
	| "completed"
	| "exit_nonzero"
	| "signal"
	| "spawn_error"
	| "timed_out"
	| "explicit_stop"
	| "session_shutdown";

export interface BackgroundRunSnapshot {
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
	exitCode?: number;
	signal?: string;
	terminationReason?: BackgroundTerminationReason;
	stopReason?: BackgroundStopReason;
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
	terminateGraceMs: number;
	maxLogBytes: number;
	maxTailBytes: number;
	env?: NodeJS.ProcessEnv;
	shell?: string;
	now?: () => number;
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

export async function startManagedBackgroundRun(options: BackgroundRunOptions): Promise<BackgroundRunController> {
	const now = options.now ?? Date.now;
	const spawnProcess = options.spawnProcess ?? spawn;
	const signalProcess = options.signalProcess ?? signalOwnedProcessGroup;
	const shell = options.shell || (path.isAbsolute(process.env.SHELL ?? "") ? process.env.SHELL! : "/bin/sh");
	const createdAt = now();
	const stdoutPath = path.join(options.runDir, "stdout.log");
	const stderrPath = path.join(options.runDir, "stderr.log");
	const resultPath = path.join(options.runDir, "result.json");
	const metadataPath = path.join(options.runDir, "metadata.json");
	await fs.promises.mkdir(options.runDir, { recursive: true, mode: 0o700 });
	try { await fs.promises.chmod(options.runDir, 0o700); } catch { /* best effort */ }
	await writeJsonAtomically(metadataPath, {
		version: 1,
		id: options.id,
		taskId: options.taskId,
		name: options.name,
		command: options.command,
		cwd: options.cwd,
		createdAt,
		timeoutMs: options.timeoutMs,
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
	let graceTimer: ReturnType<typeof setTimeout> | undefined;
	let child: ChildProcess | undefined;
	let finalized = false;
	let resolveCompletion!: (snapshot: BackgroundRunSnapshot) => void;
	const completion = new Promise<BackgroundRunSnapshot>((resolve) => { resolveCompletion = resolve; });
	const snapshot: BackgroundRunSnapshot = {
		id: options.id,
		taskId: options.taskId,
		name: options.name,
		status: "running",
		cwd: options.cwd,
		createdAt,
		startedAt: createdAt,
		timeoutAt: createdAt + options.timeoutMs,
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
		if (graceTimer) clearTimeout(graceTimer);
		outputNotifyTimer = undefined;
		timeoutTimer = undefined;
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

	const requestStop = (reason: BackgroundStopReason): boolean => {
		if (finalized || TERMINAL.has(snapshot.status) || snapshot.stopReason) return false;
		snapshot.stopReason = reason;
		if (timeoutTimer) clearTimeout(timeoutTimer);
		timeoutTimer = undefined;
		if (!child) {
			void finalize({
				status: reason === "timeout" ? "failed" : "stopped",
				terminationReason: reason === "timeout" ? "timed_out" : reason === "shutdown" ? "session_shutdown" : "explicit_stop",
				error: reason === "timeout" ? `Background task timed out after ${compactDuration(options.timeoutMs)}.` : undefined,
			});
			return true;
		}
		signalProcess(child, "SIGTERM");
		graceTimer = setTimeout(() => {
			graceTimer = undefined;
			if (finalized || !child) return;
			snapshot.timeoutEscalated = true;
			signalProcess(child, "SIGKILL");
			void finalize(reason === "timeout"
				? {
					status: "failed",
					terminationReason: "timed_out",
					signal: "SIGKILL",
					error: `Background task timed out after ${compactDuration(options.timeoutMs)}; SIGKILL followed a ${compactDuration(options.terminateGraceMs)} grace period.`,
				}
				: {
					status: "stopped",
					terminationReason: reason === "shutdown" ? "session_shutdown" : "explicit_stop",
					signal: "SIGKILL",
				});
		}, Math.max(0, options.terminateGraceMs));
		graceTimer.unref?.();
		safeNotify(options.onUpdate, snapshot);
		return true;
	};

	try {
		child = spawnProcess(shell, ["-lc", options.command], {
			cwd: options.cwd,
			env: { ...process.env, ...(options.env ?? {}) },
			detached: process.platform !== "win32",
			stdio: ["ignore", "pipe", "pipe"],
		});
		child.stdout?.on("data", (chunk) => writeChunk("stdout", chunk));
		child.stderr?.on("data", (chunk) => writeChunk("stderr", chunk));
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
					error: `Background task timed out after ${compactDuration(options.timeoutMs)}${snapshot.timeoutEscalated ? `; SIGKILL followed a ${compactDuration(options.terminateGraceMs)} grace period` : ""}.`,
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
	}
	safeNotify(options.onUpdate, snapshot);

	return {
		completion,
		snapshot: () => ({ ...snapshot }),
		stop: (reason = "user") => requestStop(reason),
	};
}
