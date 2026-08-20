export type AgentBrowserSelectionBinding =
	| "tui.select.up"
	| "tui.select.down"
	| "tui.select.pageUp"
	| "tui.select.pageDown"
	| "tui.select.confirm"
	| "tui.select.cancel";

export interface AgentBrowserKeybindings {
	matches(data: string, keybinding: AgentBrowserSelectionBinding): boolean;
}

export type AgentBrowserRawKey =
	| "q"
	| "left"
	| "right"
	| "home"
	| "end"
	| "alt+up"
	| "alt+down";

export type AgentBrowserInputAction =
	| "close"
	| "back"
	| "select-up"
	| "select-down"
	| "inspect"
	| "line-up"
	| "line-down"
	| "page-up"
	| "page-down"
	| "top"
	| "bottom";

export type AgentBrowserRawMatcher = (data: string, key: AgentBrowserRawKey) => boolean;

/**
 * Map terminal input to a semantic AgentBrowser action.
 *
 * The injected keybindings manager keeps PageUp/PageDown configurable. macOS
 * keyboards commonly send Option+Up/Down as alt+up/down instead of physical
 * PageUp/PageDown, so those are explicit page-scroll aliases in detail mode.
 */
export function resolveAgentBrowserInput(
	data: string,
	detail: boolean,
	keybindings: AgentBrowserKeybindings,
	matchesRaw: AgentBrowserRawMatcher,
): AgentBrowserInputAction | undefined {
	if (keybindings.matches(data, "tui.select.cancel") || matchesRaw(data, "left")) {
		return detail ? "back" : "close";
	}
	if (matchesRaw(data, "q")) return "close";

	if (detail) {
		// Page aliases must run before line movement: a custom select-up binding
		// may also use alt+up, but Option+Arrow is documented here as paging.
		if (keybindings.matches(data, "tui.select.pageUp") || matchesRaw(data, "alt+up")) return "page-up";
		if (keybindings.matches(data, "tui.select.pageDown") || matchesRaw(data, "alt+down")) return "page-down";
		if (keybindings.matches(data, "tui.select.up")) return "line-up";
		if (keybindings.matches(data, "tui.select.down")) return "line-down";
		if (matchesRaw(data, "home")) return "top";
		if (matchesRaw(data, "end")) return "bottom";
		return undefined;
	}

	if (keybindings.matches(data, "tui.select.up")) return "select-up";
	if (keybindings.matches(data, "tui.select.down")) return "select-down";
	if (keybindings.matches(data, "tui.select.confirm") || matchesRaw(data, "right")) return "inspect";
	return undefined;
}
