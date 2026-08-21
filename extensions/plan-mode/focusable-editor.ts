import type { Component, Focusable } from "@earendil-works/pi-tui";

export interface EditorFocusTarget {
	focused: boolean;
}

/**
 * Make an outer custom component focusable and propagate TUI focus to its
 * embedded Editor. Without the outer `focused` property, TUI does not emit the
 * child's hardware-cursor marker and terminal/IME redraws can flicker.
 */
export function withEditorFocus<T extends Component>(
	component: T,
	editor: EditorFocusTarget,
): T & Focusable {
	Object.defineProperty(component, "focused", {
		enumerable: true,
		configurable: false,
		get: () => editor.focused,
		set: (value: boolean) => {
			editor.focused = value === true;
		},
	});
	return component as T & Focusable;
}
