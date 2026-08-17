export interface CompletionQueueScheduler {
	setTimeout(callback: () => void, delayMs: number): unknown;
	clearTimeout(handle: unknown): void;
}

const nativeScheduler: CompletionQueueScheduler = {
	setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
	clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

function unref(handle: unknown): void {
	if (handle && typeof handle === "object" && "unref" in handle) {
		(handle as { unref?: () => void }).unref?.();
	}
}

/**
 * Coalesces background completions into one main-agent wake. While the parent
 * is inside an agent turn, completions remain queued and flush only after the
 * next safe agent_end boundary.
 */
export function createCompletionQueue<T extends { id: string }>(options: {
	onFlush: (items: T[]) => void;
	onError?: (error: unknown) => void;
	debounceMs?: number;
	scheduler?: CompletionQueueScheduler;
}) {
	const scheduler = options.scheduler ?? nativeScheduler;
	const debounceMs = Math.max(0, options.debounceMs ?? 100);
	const pending = new Map<string, T>();
	const delivered = new Set<string>();
	let parentActive = false;
	let stopped = false;
	let timer: unknown;

	const clearTimer = () => {
		if (timer === undefined) return;
		scheduler.clearTimeout(timer);
		timer = undefined;
	};

	const flush = () => {
		timer = undefined;
		if (stopped || parentActive || pending.size === 0) return;
		const items = [...pending.values()];
		for (const item of items) {
			pending.delete(item.id);
			delivered.add(item.id);
		}
		try {
			options.onFlush(items);
		} catch (error) {
			for (const item of items) {
				delivered.delete(item.id);
				pending.set(item.id, item);
			}
			try { options.onError?.(error); } catch { /* observational */ }
		}
	};

	const schedule = () => {
		if (stopped || parentActive || pending.size === 0 || timer !== undefined) return;
		timer = scheduler.setTimeout(flush, debounceMs);
		unref(timer);
	};

	return {
		enqueue(item: T): boolean {
			if (stopped || delivered.has(item.id) || pending.has(item.id)) return false;
			pending.set(item.id, item);
			schedule();
			return true;
		},
		setParentActive(active: boolean): void {
			parentActive = active;
			if (active) clearTimer();
			else schedule();
		},
		flushNow(): void {
			clearTimer();
			flush();
		},
		stop(): void {
			stopped = true;
			clearTimer();
			pending.clear();
		},
		get pendingCount(): number {
			return pending.size;
		},
		get deliveredCount(): number {
			return delivered.size;
		},
	};
}
