/**
 * PI WEB Activity Registry (v1)
 *
 * A small shared, versioned, filesystem protocol used to surface extension
 * activity to the PI WEB browser panel and to accept safe control requests
 * (stop one / stop all) issued by the browser plugin as atomic JSON files.
 *
 * Design rules:
 * - Registry root: <git worktree root>/.pi/.runtime/pi-web-activity/v1
 *   (falls back to ctx.cwd when the workspace is not a Git repository).
 * - Each runtime owns a private directory under
 *   `sessions/<sessionId>/runtimes/<runtimeId>` (both segments validated
 *   against `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`, fail-closed), so multiple
 *   sessions/runtimes never clobber each other's records or controls.
 * - The workspace registry is only active when PI_WEB_SESSION=1.
 * - Before writing into a Git worktree, `.pi/.runtime/` is added to
 *   .git/info/exclude (never a tracked .gitignore). If the exclusion cannot
 *   be guaranteed the registry disables itself and notifies, rather than
 *   dirtying git status.
 * - Files are 0600 and directories 0700 where supported; every write is a
 *   same-directory temp file + atomic rename.
 * - Each runtime writes its own files (runtime.json, agents.json,
 *   plan-mode.json, acks/*.json) so independent runtimes never merge-race.
 * - All persisted data is sanitized and bounded: no full task text, parent
 *   context, live output, credentials, or tokens (except the per-runtime
 *   control token in runtime.json, which is the designed handshake secret).
 * - Control requests are validated against the exact runtime identity
 *   (sessionId + runtimeId + generation + controlToken) and a bounded TTL;
 *   request ids are idempotent via persisted acks.
 */

import { execFile } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

/** Numeric schema version written into JSON records (`schemaVersion`). */
export const WEB_ACTIVITY_SCHEMA_VERSION = 1;
/** Directory name of the versioned registry root on disk. */
export const WEB_ACTIVITY_SCHEMA_DIR = "v1";
export const WEB_ACTIVITY_RELATIVE_DIR = path.join(".pi", ".runtime", "pi-web-activity");
export const WEB_ACTIVITY_EXCLUDE_PATTERN = ".pi/.runtime/";
export const MAX_RECORD_BYTES = 64 * 1024;
export const MAX_CONTROL_FILE_BYTES = 16 * 1024;
export const DEFAULT_MAX_TTL_MS = 60_000;
export const DEFAULT_MAX_CLOCK_SKEW_MS = 5_000;

const SAFE_SOURCE_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const SAFE_REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SAFE_ID_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** Validate an identity component that becomes a filesystem path segment. */
function isValidIdSegment(value: unknown): value is string {
	return typeof value === "string" && SAFE_ID_SEGMENT.test(value);
}

const SENSITIVE_KEY = /(^|[-_.\s])(token|secret|password|passwd|api[_-]?key|credential|bearer)([-_.\s]|$)/i;

export type NotifyKind = "info" | "warning" | "error";

export interface GitResult {
	code: number | null;
	stdout: string;
}

export type GitRunner = (args: string[], options: { cwd: string }) => Promise<GitResult>;

/** Default runner. `code === null` means the git binary is unavailable. */
export const defaultGitRunner: GitRunner = (args, options) =>
	new Promise((resolve) => {
		execFile("git", args, { cwd: options.cwd, timeout: 5000, encoding: "utf8" }, (error, stdout) => {
			if (error) {
				const code = (error as NodeJS.ErrnoException & { code?: unknown }).code;
				resolve({ code: typeof code === "string" ? null : (typeof code === "number" ? code : 1), stdout: stdout ?? "" });
			} else {
				resolve({ code: 0, stdout: stdout ?? "" });
			}
		});
	});

// ---------------------------------------------------------------------------
// Bounded sanitization
// ---------------------------------------------------------------------------

export interface SanitizeLimits {
	maxDepth?: number;
	maxStringChars?: number;
	maxKeys?: number;
	maxArrayItems?: number;
	maxNumberMagnitude?: number;
}

const DEFAULT_SANITIZE_LIMITS: Required<SanitizeLimits> = {
	maxDepth: 6,
	maxStringChars: 512,
	maxKeys: 100,
	maxArrayItems: 200,
	maxNumberMagnitude: 1e15,
};

/**
 * Recursively bound a JSON-able value: truncates strings, clamps numbers,
 * caps object keys / array items / nesting depth, and drops keys that look
 * like credentials or auth material. Returns a plain JSON-safe clone.
 */
export function sanitizeRecord(value: unknown, limits: SanitizeLimits = {}, depth = 0): unknown {
	const max = { ...DEFAULT_SANITIZE_LIMITS, ...limits };
	if (value === null || typeof value === "boolean") return value;
	if (typeof value === "string") {
		return value.length > max.maxStringChars ? `${value.slice(0, max.maxStringChars)}…` : value;
	}
	if (typeof value === "number") {
		if (!Number.isFinite(value)) return null;
		return Math.abs(value) > max.maxNumberMagnitude ? Math.sign(value) * max.maxNumberMagnitude : value;
	}
	if (typeof value !== "object") return null;
	if (depth >= max.maxDepth) return null;
	if (Array.isArray(value)) {
		return value.slice(0, max.maxArrayItems).map((item) => sanitizeRecord(item, limits, depth + 1));
	}
	const source = value as Record<string, unknown>;
	const keys = Object.keys(source)
		.filter((key) => !SENSITIVE_KEY.test(key))
		.sort();
	const out: Record<string, unknown> = {};
	for (const key of keys.slice(0, max.maxKeys)) {
		out[key] = sanitizeRecord(source[key], limits, depth + 1);
	}
	return out;
}

// ---------------------------------------------------------------------------
// Git worktree detection + exclusion
// ---------------------------------------------------------------------------

function findGitDirUpward(start: string): string | null {
	let dir = path.resolve(start);
	for (;;) {
		const candidate = path.join(dir, ".git");
		try {
			const stat = fs.statSync(candidate);
			if (stat.isDirectory() || stat.isFile()) return candidate;
		} catch {
			// keep walking up
		}
		const parent = path.dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

async function ensureGitExclude(
	worktree: string,
	runGit: GitRunner,
	sessionId: string,
	runtimeId: string,
): Promise<{ ok: boolean; reason: string }> {
	let gitPath: GitResult;
	try {
		gitPath = await runGit(["rev-parse", "--git-path", "info/exclude"], { cwd: worktree });
	} catch {
		return { ok: false, reason: "could not resolve .git/info/exclude" };
	}
	const raw = gitPath.stdout.trim();
	if (gitPath.code !== 0 || !raw) return { ok: false, reason: "could not resolve .git/info/exclude" };
	const excludePath = path.isAbsolute(raw) ? raw : path.resolve(worktree, raw);

	let content = "";
	try {
		content = fs.readFileSync(excludePath, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			return { ok: false, reason: `could not read ${excludePath}` };
		}
	}
	const hasPattern = content.split(/\r?\n/).some((line) => line.trim() === WEB_ACTIVITY_EXCLUDE_PATTERN);
	if (!hasPattern) {
		const addition = `${content.length > 0 && !content.endsWith("\n") ? "\n" : ""}${WEB_ACTIVITY_EXCLUDE_PATTERN}\n`;
		try {
			fs.mkdirSync(path.dirname(excludePath), { recursive: true, mode: 0o700 });
			fs.appendFileSync(excludePath, addition, { encoding: "utf8", mode: 0o600 });
		} catch (error) {
			return { ok: false, reason: `could not update ${excludePath}: ${error instanceof Error ? error.message : String(error)}` };
		}
	}
	const probe = path.posix.join(
		WEB_ACTIVITY_RELATIVE_DIR,
		WEB_ACTIVITY_SCHEMA_DIR,
		"sessions",
		sessionId,
		"runtimes",
		runtimeId,
		"runtime.json",
	);
	try {
		const check = await runGit(["check-ignore", "-q", "--", probe], { cwd: worktree });
		if (check.code !== 0) {
			return { ok: false, reason: "git check-ignore did not confirm the registry path is excluded from git status" };
		}
	} catch {
		return { ok: false, reason: "could not verify the git exclusion" };
	}
	return { ok: true, reason: "" };
}

async function writeJsonAtomically(filePath: string, content: string): Promise<void> {
	await fs.promises.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
	const temporaryPath = path.join(
		path.dirname(filePath),
		`.${path.basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
	);
	try {
		await fs.promises.writeFile(temporaryPath, content, { encoding: "utf8", mode: 0o600 });
		await fs.promises.rename(temporaryPath, filePath);
	} catch (error) {
		await fs.promises.rm(temporaryPath, { force: true }).catch(() => {});
		throw error;
	}
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export interface WebActivityIdentity {
	sessionId: string;
	runtimeId: string;
	generation: number;
	controlToken: string;
}

export interface WebActivityRegistryOptions {
	cwd: string;
	identity: WebActivityIdentity;
	env?: Record<string, string | undefined>;
	notify?: (message: string, kind: NotifyKind) => void;
	runGit?: GitRunner;
}

export interface ControlRequestFile {
	requestId: string;
	path: string;
	parsed: unknown;
}

export class WebActivityRegistry {
	readonly enabled: boolean;
	readonly root: string;
	readonly worktreeRoot: string;
	readonly disabledReason: string;
	readonly identity: WebActivityIdentity;
	readonly requestsDir: string;
	readonly acksDir: string;

	private chain: Promise<unknown> = Promise.resolve();
	private readonly notifyHandler?: (message: string, kind: NotifyKind) => void;
	private readonly tooLargeNotified = new Set<string>();
	private readonly writeFailedNotified = new Set<string>();

	private constructor(options: {
		enabled: boolean;
		root: string;
		worktreeRoot: string;
		disabledReason: string;
		identity: WebActivityIdentity;
		notify?: (message: string, kind: NotifyKind) => void;
	}) {
		this.enabled = options.enabled;
		this.root = options.root;
		this.worktreeRoot = options.worktreeRoot;
		this.disabledReason = options.disabledReason;
		this.identity = options.identity;
		this.notifyHandler = options.notify;
		this.requestsDir = path.join(options.root, "requests");
		this.acksDir = path.join(options.root, "acks");
	}

	static async create(options: WebActivityRegistryOptions): Promise<WebActivityRegistry> {
		const env = options.env ?? process.env;
		const notify = options.notify;
		const disabled = (reason: string, worktreeRoot: string) =>
			new WebActivityRegistry({
				enabled: false,
				root: "",
				worktreeRoot,
				disabledReason: reason,
				identity: options.identity,
				notify,
			});
		if (env.PI_WEB_SESSION !== "1") {
			return disabled("PI_WEB_SESSION is not 1; workspace activity registry stays off", options.cwd);
		}
		const { sessionId, runtimeId } = options.identity;
		if (!isValidIdSegment(sessionId) || !isValidIdSegment(runtimeId)) {
			const reason = "invalid sessionId or runtimeId; activity registry disabled to avoid unsafe paths";
			notify?.(`PI WEB activity registry disabled: ${reason}`, "warning");
			return disabled(reason, options.cwd);
		}
		const runGit = options.runGit ?? defaultGitRunner;
		let worktree = options.cwd;
		let isGitRepo = false;
		try {
			const top = await runGit(["rev-parse", "--show-toplevel"], { cwd: options.cwd });
			if (top.code === 0 && top.stdout.trim()) {
				worktree = top.stdout.trim();
				isGitRepo = true;
			} else if (top.code === null) {
				// git binary unavailable — detect the repo marker manually so we can
				// fail closed instead of writing unexcluded files into a repository.
				if (findGitDirUpward(options.cwd) !== null) {
					const reason =
						"git is unavailable but the workspace is inside a Git repository; activity registry disabled to avoid dirtying git status";
					notify?.(reason, "warning");
					return disabled(reason, options.cwd);
				}
			}
			// Any other non-zero exit: not a Git repository.
		} catch {
			return disabled("could not inspect the Git worktree; activity registry disabled", options.cwd);
		}
		if (isGitRepo) {
			const exclusion = await ensureGitExclude(worktree, runGit, sessionId, runtimeId);
			if (!exclusion.ok) {
				notify?.(`PI WEB activity registry disabled: ${exclusion.reason}`, "warning");
				return disabled(exclusion.reason, worktree);
			}
		}
		const root = path.join(
			worktree,
			WEB_ACTIVITY_RELATIVE_DIR,
			WEB_ACTIVITY_SCHEMA_DIR,
			"sessions",
			sessionId,
			"runtimes",
			runtimeId,
		);
		try {
			fs.mkdirSync(root, { recursive: true, mode: 0o700 });
			try {
				fs.chmodSync(root, 0o700);
			} catch {
				// Best-effort on exotic filesystems; write permissions are what matter.
			}
		} catch (error) {
			const reason = `could not create the activity registry directory: ${error instanceof Error ? error.message : String(error)}`;
			notify?.(`PI WEB activity registry disabled: ${reason}`, "warning");
			return disabled(reason, worktree);
		}
		return new WebActivityRegistry({
			enabled: true,
			root,
			worktreeRoot: worktree,
			disabledReason: "",
			identity: options.identity,
			notify,
		});
	}

	/**
	 * Serialize a sanitized JSON record into `<runtimeRoot>/<source>.json` through a
	 * same-directory atomic rename. Writes are chained per registry so a
	 * single source can never observe a torn or reordered file. Every I/O
	 * failure is caught and reported once; the returned promise always resolves
	 * (never rejects) so callers can `void` it without an unhandled rejection.
	 */
	write(source: string, data: unknown): Promise<boolean> {
		if (!this.enabled || !SAFE_SOURCE_NAME.test(source)) return Promise.resolve(false);
		return this.enqueueWrite(path.join(this.root, `${source}.json`), data, source).catch((error) => {
			this.notifyWriteFailure(source, error);
			return false;
		});
	}

	clear(source: string): Promise<void> {
		if (!this.enabled || !SAFE_SOURCE_NAME.test(source)) return Promise.resolve();
		const task = this.chain.then(async () => {
			await fs.promises.rm(path.join(this.root, `${source}.json`), { force: true });
		});
		this.chain = task.catch(() => {});
		return task;
	}

	/** List JSON control-request files published by the browser plugin. */
	async listControlRequests(): Promise<ControlRequestFile[]> {
		if (!this.enabled) return [];
		let names: string[] = [];
		try {
			names = await fs.promises.readdir(this.requestsDir);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			return [];
		}
		const results: ControlRequestFile[] = [];
		for (const name of names.sort()) {
			if (!name.endsWith(".json") || name.startsWith(".")) continue;
			const full = path.join(this.requestsDir, name);
			try {
				const stat = await fs.promises.stat(full);
				if (!stat.isFile() || stat.size > MAX_CONTROL_FILE_BYTES) continue;
				const parsed: unknown = JSON.parse(await fs.promises.readFile(full, "utf8"));
				const candidate = parsed as { requestId?: unknown } | null;
				const requestId =
					candidate && typeof candidate.requestId === "string" && candidate.requestId
						? candidate.requestId
						: name.slice(0, -".json".length);
				results.push({ requestId, path: full, parsed });
			} catch {
				// Unreadable/invalid request files are skipped; the plugin republishes.
			}
		}
		return results;
	}

	/** Write a bounded acknowledgment for a control request. */
	ackControl(requestId: string, payload: unknown): Promise<boolean> {
		if (!this.enabled || !SAFE_REQUEST_ID.test(requestId)) return Promise.resolve(false);
		return this.enqueueWrite(path.join(this.acksDir, `${requestId}.json`), payload, `ack:${requestId}`).catch(() => false);
	}

	async hasAck(requestId: string): Promise<boolean> {
		if (!this.enabled || !SAFE_REQUEST_ID.test(requestId)) return false;
		try {
			await fs.promises.stat(path.join(this.acksDir, `${requestId}.json`));
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * Remove this runtime's own stale control files (requests and acks) that are
	 * older than `maxAgeMs`. Only touches the current runtime's request/ack
	 * directories, never sibling sessions/runtimes. Best-effort: unreadable or
	 * still-young entries are left untouched.
	 */
	async pruneOwnControlFiles(maxAgeMs = 24 * 60 * 60 * 1000): Promise<void> {
		if (!this.enabled || !Number.isFinite(maxAgeMs) || maxAgeMs < 0) return;
		const cutoff = Date.now() - maxAgeMs;
		for (const dir of [this.requestsDir, this.acksDir]) {
			let names: string[];
			try {
				names = await fs.promises.readdir(dir);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
				continue;
			}
			for (const name of names) {
				if (!name.endsWith(".json") || name.startsWith(".")) continue;
				const full = path.join(dir, name);
				try {
					const info = await fs.promises.stat(full);
					if (info.isFile() && info.mtimeMs < cutoff) {
						await fs.promises.rm(full, { force: true });
					}
				} catch {
					// Skip entries we cannot stat/remove; they stay until a later pass.
				}
			}
		}
	}

	private notifyWriteFailure(label: string, error: unknown): void {
		if (this.writeFailedNotified.has(label)) return;
		this.writeFailedNotified.add(label);
		const detail = error instanceof Error ? error.message : String(error);
		this.notifyHandler?.(`PI WEB activity write for "${label}" failed: ${detail}`, "warning");
	}

	private enqueueWrite(filePath: string, data: unknown, label: string): Promise<boolean> {
		const task = this.chain.then(async () => {
			const clean = sanitizeRecord(data);
			const json = JSON.stringify(clean);
			if (json === undefined) return false;
			if (Buffer.byteLength(json, "utf8") > MAX_RECORD_BYTES) {
				if (!this.tooLargeNotified.has(label)) {
					this.tooLargeNotified.add(label);
					this.notifyHandler?.(`PI WEB activity record "${label}" exceeds ${MAX_RECORD_BYTES} bytes and was skipped`, "warning");
				}
				return false;
			}
			await writeJsonAtomically(filePath, json);
			return true;
		});
		this.chain = task.catch(() => {});
		return task;
	}
}

// ---------------------------------------------------------------------------
// Control request protocol
// ---------------------------------------------------------------------------

export interface ParsedControlRequest {
	schemaVersion: number;
	sessionId: string;
	runtimeId: string;
	generation: number;
	controlToken: string;
	action: "stop_one" | "stop_all";
	jobId?: string;
	requestId: string;
	createdAt: number;
	expiresAt: number;
}

export type ParseControlResult =
	| { ok: true; request: ParsedControlRequest }
	| { ok: false; reason: string; requestId?: string };

function tokensEqual(a: string, b: string): boolean {
	const left = crypto.createHash("sha256").update(a, "utf8").digest();
	const right = crypto.createHash("sha256").update(b, "utf8").digest();
	return crypto.timingSafeEqual(left, right);
}

/**
 * Validate a raw control request against the exact runtime identity and a
 * bounded time window. Fails closed on every mismatch: schema, session,
 * runtime, generation, control token, action, ids, and timestamps.
 */
export function parseControlRequest(
	raw: unknown,
	identity: WebActivityIdentity,
	options: { now?: number; maxTtlMs?: number; maxClockSkewMs?: number } = {},
): ParseControlResult {
	const now = options.now ?? Date.now();
	const maxTtlMs = options.maxTtlMs ?? DEFAULT_MAX_TTL_MS;
	const maxSkew = options.maxClockSkewMs ?? DEFAULT_MAX_CLOCK_SKEW_MS;
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		return { ok: false, reason: "request is not a JSON object" };
	}
	const value = raw as Record<string, unknown>;
	const requestId = typeof value.requestId === "string" ? value.requestId : "";
	const invalid = (reason: string): ParseControlResult => ({ ok: false, reason, requestId: requestId || undefined });

	if (!SAFE_REQUEST_ID.test(requestId)) return invalid("missing or invalid requestId");
	if (value.schemaVersion !== WEB_ACTIVITY_SCHEMA_VERSION) return invalid("unsupported schemaVersion");
	if (value.sessionId !== identity.sessionId) return invalid("sessionId mismatch");
	if (value.runtimeId !== identity.runtimeId) return invalid("runtimeId mismatch");
	if (value.generation !== identity.generation) return invalid("generation mismatch (stale control token)");
	if (typeof value.controlToken !== "string" || !tokensEqual(value.controlToken, identity.controlToken)) {
		return invalid("controlToken mismatch");
	}
	if (value.action !== "stop_one" && value.action !== "stop_all") return invalid("unsupported action");
	if (value.action === "stop_one" && (typeof value.jobId !== "string" || !value.jobId.trim() || value.jobId.length > 256)) {
		return invalid("stop_one requires a bounded jobId");
	}
	if (
		typeof value.createdAt !== "number" ||
		typeof value.expiresAt !== "number" ||
		!Number.isFinite(value.createdAt) ||
		!Number.isFinite(value.expiresAt)
	) {
		return invalid("createdAt/expiresAt must be finite numbers");
	}
	if (value.expiresAt <= value.createdAt) return invalid("expiresAt must be after createdAt");
	if (value.expiresAt <= now) return invalid("request expired (TTL)");
	if (value.createdAt > now + maxSkew) return invalid("createdAt is in the future beyond the allowed clock skew");
	if (value.createdAt < now - maxTtlMs) return invalid("request is stale (createdAt older than the maximum TTL)");
	if (value.expiresAt - value.createdAt > maxTtlMs) return invalid("TTL exceeds the maximum allowed");

	return {
		ok: true,
		request: {
			schemaVersion: WEB_ACTIVITY_SCHEMA_VERSION,
			sessionId: identity.sessionId,
			runtimeId: identity.runtimeId,
			generation: identity.generation,
			controlToken: value.controlToken as string,
			action: value.action as "stop_one" | "stop_all",
			jobId: value.action === "stop_one" ? (value.jobId as string) : undefined,
			requestId,
			createdAt: value.createdAt,
			expiresAt: value.expiresAt,
		},
	};
}

export function buildControlAck(
	options: { requestId: string; accepted: boolean; reason: string; action?: string; jobId?: string },
	identity: WebActivityIdentity,
	respondedAt = Date.now(),
): Record<string, unknown> {
	return {
		schemaVersion: WEB_ACTIVITY_SCHEMA_VERSION,
		sessionId: identity.sessionId,
		runtimeId: identity.runtimeId,
		generation: identity.generation,
		requestId: options.requestId,
		action: options.action,
		jobId: options.jobId,
		accepted: options.accepted,
		reason: String(options.reason ?? "").slice(0, 1000),
		respondedAt,
	};
}

// ---------------------------------------------------------------------------
// Dispatcher (poll + validate + ack + execute)
// ---------------------------------------------------------------------------

export interface ControlActions {
	stopOne(jobId: string): string | Promise<string>;
	stopAll(): string | Promise<string>;
}

export interface ControlDispatcherOptions {
	now?: () => number;
	maxTtlMs?: number;
	maxClockSkewMs?: number;
}

/**
 * Polls the registry requests directory, validates each request against the
 * runtime identity, executes accepted stop actions, and writes a bounded ack.
 * Request ids are idempotent: an in-memory result cache plus persisted ack
 * files guarantee a request is executed at most once, even across restarts
 * of the poller within the same runtime generation.
 */
export class ControlDispatcher {
	private readonly registry: WebActivityRegistry;
	private readonly identity: WebActivityIdentity;
	private readonly actions: ControlActions;
	private readonly options: ControlDispatcherOptions;
	private readonly results = new Map<string, Record<string, unknown>>();

	constructor(
		registry: WebActivityRegistry,
		identity: WebActivityIdentity,
		actions: ControlActions,
		options: ControlDispatcherOptions = {},
	) {
		this.registry = registry;
		this.identity = identity;
		this.actions = actions;
		this.options = options;
	}

	/** Returns the number of accepted control actions executed. */
	async poll(): Promise<number> {
		if (!this.registry.enabled) return 0;
		const files = await this.registry.listControlRequests();
		let executed = 0;
		for (const file of files) {
			const known = this.results.get(file.requestId);
			if (known) {
				await this.registry.ackControl(file.requestId, known);
				continue;
			}
			if (await this.registry.hasAck(file.requestId)) continue;

			const parsed = parseControlRequest(file.parsed, this.identity, {
				now: this.options.now?.() ?? Date.now(),
				maxTtlMs: this.options.maxTtlMs,
				maxClockSkewMs: this.options.maxClockSkewMs,
			});
			if (!parsed.ok) {
				const ack = buildControlAck(
					{ requestId: parsed.requestId ?? file.requestId, accepted: false, reason: parsed.reason },
					this.identity,
				);
				this.results.set(file.requestId, ack);
				await this.registry.ackControl(file.requestId, ack);
				continue;
			}

			const request = parsed.request;
			let accepted = true;
			let reason: string;
			try {
				reason = request.action === "stop_one"
					? await this.actions.stopOne(request.jobId ?? "")
					: await this.actions.stopAll();
				executed += 1;
			} catch (error) {
				accepted = false;
				reason = `control action failed: ${error instanceof Error ? error.message : String(error)}`;
			}
			const ack = buildControlAck(
				{ requestId: request.requestId, accepted, reason, action: request.action, jobId: request.jobId },
				this.identity,
			);
			this.results.set(file.requestId, ack);
			await this.registry.ackControl(file.requestId, ack);
		}
		return executed;
	}
}
