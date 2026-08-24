export interface BtwPagingKeybindings {
	matches(data: string, binding: "tui.select.pageUp" | "tui.select.pageDown"): boolean;
}

export type BtwPagingAction = "page-up" | "page-down";

export function resolveBtwPagingInput(
	data: string,
	keybindings: BtwPagingKeybindings,
): BtwPagingAction | undefined {
	if (keybindings.matches(data, "tui.select.pageUp")) return "page-up";
	if (keybindings.matches(data, "tui.select.pageDown")) return "page-down";
	return undefined;
}

export interface BtwScrollState {
	/** Wrapped transcript lines hidden below the current viewport. */
	scrollBack: number;
	/** True while new output should keep the viewport pinned to the bottom. */
	followOutput: boolean;
	lastBodyLength: number;
	pageSize: number;
}

export function createBtwScrollState(): BtwScrollState {
	return { scrollBack: 0, followOutput: true, lastBodyLength: 0, pageSize: 5 };
}

export function applyBtwPaging(state: BtwScrollState, action: BtwPagingAction): void {
	if (action === "page-up") {
		state.followOutput = false;
		state.scrollBack += state.pageSize;
		return;
	}
	state.scrollBack = Math.max(0, state.scrollBack - state.pageSize);
	if (state.scrollBack === 0) state.followOutput = true;
}

export interface BtwViewport {
	start: number;
	end: number;
	maxScroll: number;
}

/**
 * Reconcile scroll state against freshly wrapped output.
 *
 * While history is paused, each new line increases scrollBack so the absolute
 * viewport stays on the same content instead of drifting or snapping down.
 */
export function layoutBtwViewport(
	state: BtwScrollState,
	bodyLength: number,
	maxBody: number,
): BtwViewport {
	const safeBodyLength = Math.max(0, Math.floor(bodyLength));
	const safeMaxBody = Math.max(1, Math.floor(maxBody));
	state.pageSize = Math.max(3, safeMaxBody - 1);

	if (state.followOutput) {
		state.scrollBack = 0;
	} else if (safeBodyLength > state.lastBodyLength) {
		state.scrollBack += safeBodyLength - state.lastBodyLength;
	}

	const maxScroll = Math.max(0, safeBodyLength - safeMaxBody);
	state.scrollBack = Math.max(0, Math.min(state.scrollBack, maxScroll));
	if (maxScroll === 0 || state.scrollBack === 0) state.followOutput = true;
	state.lastBodyLength = safeBodyLength;

	const end = Math.max(safeMaxBody, safeBodyLength - state.scrollBack);
	return {
		start: Math.max(0, end - safeMaxBody),
		end: Math.min(safeBodyLength, end),
		maxScroll,
	};
}
