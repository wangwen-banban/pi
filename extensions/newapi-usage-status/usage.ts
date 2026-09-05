import http from "node:http";
import https from "node:https";
import { timingSafeEqual } from "node:crypto";

export const NEWAPI_ACCOUNT_ID = "newapi-cambricon";
export const NEWAPI_PROVIDER_IDS = ["cambricon-codex", "claude-cambricon"] as const;
export type NewApiProviderId = (typeof NEWAPI_PROVIDER_IDS)[number];

export interface NewApiUsage {
	version: 1;
	account: typeof NEWAPI_ACCOUNT_ID;
	remainingPercent: number | null;
	totalGranted: number | null;
	totalUsed: number | null;
	totalAvailable: number | null;
	unlimited: boolean;
	expiresAt?: number;
	updatedAt: number;
	source: "api" | "cache";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNonNegative(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function getNewApiProviderId(value: unknown): NewApiProviderId | undefined {
	return NEWAPI_PROVIDER_IDS.includes(value as NewApiProviderId) ? value as NewApiProviderId : undefined;
}

export function selectSharedNewApiKey(first: unknown, second: unknown): string | undefined {
	const values = [first, second].filter((value): value is string => typeof value === "string" && value.length > 0);
	if (values.length === 0) return undefined;
	if (values.length === 1) return values[0];
	const left = Buffer.from(values[0]);
	const right = Buffer.from(values[1]);
	return left.length === right.length && timingSafeEqual(left, right) ? values[0] : undefined;
}

export function normalizeNewApiRoot(value: unknown): string | undefined {
	if (typeof value !== "string" || !value) return undefined;
	try {
		const url = new URL(value);
		if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || url.search || url.hash) return undefined;
		let pathname = url.pathname.replace(/\/+$/, "");
		if (pathname.endsWith("/v1")) pathname = pathname.slice(0, -3);
		if (pathname !== "") return undefined;
		return url.origin;
	} catch {
		return undefined;
	}
}

export function sharedNewApiRoot(routes: unknown): string | undefined {
	if (!isRecord(routes)) return undefined;
	const roots = NEWAPI_PROVIDER_IDS.map((provider) => {
		const route = routes[provider];
		return isRecord(route) ? normalizeNewApiRoot(route.baseUrl) : undefined;
	});
	return roots[0] && roots[0] === roots[1] ? roots[0] : undefined;
}

export function parseNewApiUsage(payload: unknown, now = Date.now()): NewApiUsage | undefined {
	if (!isRecord(payload) || payload.code !== true || !isRecord(payload.data)) return undefined;
	const data = payload.data;
	if (typeof data.unlimited_quota !== "boolean") return undefined;
	const expiresAt = finiteNonNegative(data.expires_at) && data.expires_at > 0 ? Math.floor(data.expires_at) : undefined;
	if (data.unlimited_quota) {
		return {
			version: 1,
			account: NEWAPI_ACCOUNT_ID,
			remainingPercent: null,
			totalGranted: null,
			totalUsed: null,
			totalAvailable: null,
			unlimited: true,
			...(expiresAt ? { expiresAt } : {}),
			updatedAt: now,
			source: "api",
		};
	}
	const granted = data.total_granted;
	const used = data.total_used;
	const available = data.total_available;
	if (!finiteNonNegative(granted) || granted <= 0 || !finiteNonNegative(used) || !finiteNonNegative(available)) return undefined;
	const tolerance = Math.max(1e-6, granted * 1e-9);
	if (Math.abs(granted - used - available) > tolerance || used > granted + tolerance || available > granted + tolerance) return undefined;
	return {
		version: 1,
		account: NEWAPI_ACCOUNT_ID,
		remainingPercent: Math.max(0, Math.min(100, available / granted * 100)),
		totalGranted: granted,
		totalUsed: used,
		totalAvailable: available,
		unlimited: false,
		...(expiresAt ? { expiresAt } : {}),
		updatedAt: now,
		source: "api",
	};
}

export interface NewApiRequestOptions {
	timeoutMs?: number;
	maxBytes?: number;
	signal?: AbortSignal;
}

export function requestNewApiUsage(root: string, apiKey: string, options: NewApiRequestOptions = {}): Promise<NewApiUsage> {
	const endpoint = new URL("/api/usage/token/", root);
	const transport = endpoint.protocol === "https:" ? https : http;
	const timeoutMs = options.timeoutMs ?? 10_000;
	const maxBytes = options.maxBytes ?? 64 * 1024;
	return new Promise((resolve, reject) => {
		let settled = false;
		const finish = (error?: Error, usage?: NewApiUsage) => {
			if (settled) return;
			settled = true;
			options.signal?.removeEventListener("abort", abort);
			error ? reject(error) : resolve(usage!);
		};
		const request = transport.request(endpoint, {
			method: "GET",
			headers: {
				authorization: `Bearer ${apiKey}`,
				accept: "application/json",
				"user-agent": "pi-newapi-usage-status/1.0",
			},
		}, (response) => {
			if (response.statusCode !== 200) {
				response.resume();
				finish(new Error(`NewAPI usage endpoint returned HTTP ${response.statusCode ?? 0}`));
				return;
			}
			const chunks: Buffer[] = [];
			let bytes = 0;
			let tooLarge = false;
			response.on("data", (chunk: Buffer) => {
				if (tooLarge) return;
				bytes += chunk.length;
				if (bytes > maxBytes) {
					tooLarge = true;
					response.destroy();
					finish(new Error("NewAPI usage response exceeded the size limit"));
					return;
				}
				chunks.push(chunk);
			});
			response.on("error", (error) => finish(error));
			response.on("end", () => {
				if (tooLarge) return;
				try {
					const usage = parseNewApiUsage(JSON.parse(Buffer.concat(chunks).toString("utf8")));
					if (!usage) throw new Error("NewAPI usage response was invalid");
					finish(undefined, usage);
				} catch (error) {
					finish(error instanceof Error ? error : new Error("NewAPI usage response was invalid"));
				}
			});
		});
		const abort = () => request.destroy(new Error("NewAPI usage request aborted"));
		request.setTimeout(timeoutMs, () => request.destroy(new Error("NewAPI usage request timed out")));
		request.on("error", (error) => finish(error));
		if (options.signal?.aborted) abort();
		else options.signal?.addEventListener("abort", abort, { once: true });
		request.end();
	});
}
