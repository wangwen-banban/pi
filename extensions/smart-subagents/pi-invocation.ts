import * as fs from "node:fs";
import * as path from "node:path";

export interface PiInvocation {
	command: string;
	args: string[];
}

/**
 * Process facts used to resolve the worker CLI. Injectable so embedded-host
 * behavior can be regression-tested without starting PI WEB.
 */
export interface PiInvocationRuntime {
	argv1?: string;
	execPath: string;
	env: Readonly<Record<string, string | undefined>>;
	scriptExists?: (scriptPath: string) => boolean;
}

/**
 * Resolve the executable used for a delegated worker.
 *
 * A normal Pi CLI runs as `node .../pi-coding-agent/dist/cli.js`, so reusing
 * argv[1] avoids relying on PATH. PI WEB is different: it embeds the Pi SDK in
 * its session daemon, making argv[1] point at `pi-web/.../sessiond.js` rather
 * than the Pi CLI. Reusing that path starts a second daemon and triggers a
 * SessiondStateOwnershipConflictError. PI WEB deliberately exports
 * PI_WEB_SESSION=1 to every agent-visible child, so nested workers must resolve
 * the standalone `pi` command instead.
 */
export function getPiInvocation(
	args: string[],
	runtime: PiInvocationRuntime = {
		argv1: process.argv[1],
		execPath: process.execPath,
		env: process.env,
	},
): PiInvocation {
	const execName = path.basename(runtime.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);

	// A compiled Pi binary is already the correct executable, including when it
	// was launched from a PI WEB environment.
	if (!isGenericRuntime) return { command: runtime.execPath, args };

	const currentScript = runtime.argv1;
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/") ?? false;
	const isEmbeddedPiWebSession = runtime.env.PI_WEB_SESSION === "1";
	const scriptExists = runtime.scriptExists ?? fs.existsSync;

	if (
		!isEmbeddedPiWebSession &&
		currentScript &&
		!isBunVirtualScript &&
		scriptExists(currentScript)
	) {
		return { command: runtime.execPath, args: [currentScript, ...args] };
	}

	// spawn() resolves this through PATH. PI WEB preserves PATH for
	// agent-visible children, and its service setup includes the installed Pi
	// binary (for example /opt/homebrew/bin/pi on macOS).
	return { command: "pi", args };
}
