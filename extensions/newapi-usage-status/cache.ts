import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { NEWAPI_ACCOUNT_ID, type NewApiUsage } from "./usage.ts";

export function getNewApiCachePath(agentDir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent")): string {
	return path.join(agentDir, "cache", "newapi-usage.json");
}

function exactMode(stat: fs.Stats, expected: number): boolean {
	return (stat.mode & 0o777) === expected;
}

export function parseNewApiCache(value: unknown): NewApiUsage | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const data = value as Record<string, unknown>;
	if (data.version !== 1 || data.account !== NEWAPI_ACCOUNT_ID || typeof data.unlimited !== "boolean") return undefined;
	if (data.source !== "api" && data.source !== "cache") return undefined;
	if (typeof data.updatedAt !== "number" || !Number.isFinite(data.updatedAt) || data.updatedAt <= 0) return undefined;
	const expiresAt = typeof data.expiresAt === "number" && Number.isFinite(data.expiresAt) && data.expiresAt > 0 ? data.expiresAt : undefined;
	if (data.unlimited) {
		if (data.remainingPercent !== null || data.totalGranted !== null || data.totalUsed !== null || data.totalAvailable !== null) return undefined;
	} else {
		for (const key of ["remainingPercent", "totalGranted", "totalUsed", "totalAvailable"] as const) {
			if (typeof data[key] !== "number" || !Number.isFinite(data[key]) || (data[key] as number) < 0) return undefined;
		}
		const granted = data.totalGranted as number;
		const used = data.totalUsed as number;
		const available = data.totalAvailable as number;
		const tolerance = Math.max(1e-6, granted * 1e-9);
		if ((data.remainingPercent as number) > 100 || granted <= 0 || Math.abs(granted - used - available) > tolerance) return undefined;
		if (Math.abs((data.remainingPercent as number) - available / granted * 100) > 1e-6) return undefined;
	}
	return {
		version: 1,
		account: NEWAPI_ACCOUNT_ID,
		remainingPercent: data.remainingPercent as number | null,
		totalGranted: data.totalGranted as number | null,
		totalUsed: data.totalUsed as number | null,
		totalAvailable: data.totalAvailable as number | null,
		unlimited: data.unlimited,
		...(expiresAt ? { expiresAt } : {}),
		updatedAt: data.updatedAt,
		source: "cache",
	};
}

export function readNewApiCache(agentDir?: string): NewApiUsage | undefined {
	const file = getNewApiCachePath(agentDir);
	try {
		const dirStat = fs.lstatSync(path.dirname(file));
		if (!dirStat.isDirectory() || dirStat.isSymbolicLink() || !exactMode(dirStat, 0o700)) return undefined;
		const stat = fs.lstatSync(file);
		if (!stat.isFile() || stat.isSymbolicLink() || !exactMode(stat, 0o600)) return undefined;
		return parseNewApiCache(JSON.parse(fs.readFileSync(file, "utf8")));
	} catch {
		return undefined;
	}
}

export function writeNewApiCache(usage: NewApiUsage, agentDir?: string): void {
	const file = getNewApiCachePath(agentDir);
	const dir = path.dirname(file);
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	const dirStat = fs.lstatSync(dir);
	if (!dirStat.isDirectory() || dirStat.isSymbolicLink() || !exactMode(dirStat, 0o700)) throw new Error("NewAPI cache directory is not a private regular directory");
	try {
		const existing = fs.lstatSync(file);
		if (!existing.isFile() || existing.isSymbolicLink() || !exactMode(existing, 0o600)) throw new Error("NewAPI cache file is not a private regular file");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	const persisted = {
		version: 1,
		account: NEWAPI_ACCOUNT_ID,
		remainingPercent: usage.remainingPercent,
		totalGranted: usage.totalGranted,
		totalUsed: usage.totalUsed,
		totalAvailable: usage.totalAvailable,
		unlimited: usage.unlimited,
		...(usage.expiresAt ? { expiresAt: usage.expiresAt } : {}),
		updatedAt: usage.updatedAt,
		source: usage.source,
	};
	const temp = path.join(dir, `.newapi-usage.${randomUUID()}.tmp`);
	let handle: number | undefined;
	try {
		handle = fs.openSync(temp, "wx", 0o600);
		fs.writeFileSync(handle, `${JSON.stringify(persisted, null, 2)}\n`, "utf8");
		fs.fsyncSync(handle);
		fs.closeSync(handle);
		handle = undefined;
		fs.renameSync(temp, file);
	} finally {
		if (handle !== undefined) fs.closeSync(handle);
		try { fs.unlinkSync(temp); } catch { /* committed or already absent */ }
	}
}
