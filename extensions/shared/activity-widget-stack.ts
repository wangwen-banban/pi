import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";

export const ACTIVITY_WIDGET_KEY = "activity-widget-stack";
export const LEGACY_ACTIVITY_WIDGET_KEYS = ["background-tasks", "smart-subagents"] as const;
export const MAX_ACTIVITY_SECTION_LINES = 10;

export type ActivityWidgetSection = "tasks" | "subagents";

export interface ActivityWidgetOwner {
	readonly section: ActivityWidgetSection;
}

const SECTION_ORDER: readonly ActivityWidgetSection[] = ["tasks", "subagents"];
const STATE_SYMBOL = Symbol.for("pi.extensions.activity-widget-stack.state.v1");

type ActivityWidgetUi = Pick<ExtensionUIContext, "setWidget">;
type ActivityTheme = { fg(color: "muted", text: string): string };
type ActivityTui = { requestRender(): void };

interface ActivityWidgetState {
	owners: Partial<Record<ActivityWidgetSection, ActivityWidgetOwner>>;
	sections: Partial<Record<ActivityWidgetSection, readonly string[]>>;
	legacyCleanedOwners: WeakSet<ActivityWidgetOwner>;
	component?: ActivityWidgetStackComponent;
}

function globalStates(): WeakMap<object, ActivityWidgetState> {
	const root = globalThis as typeof globalThis & Record<symbol, unknown>;
	const existing = root[STATE_SYMBOL];
	if (existing instanceof WeakMap) return existing as WeakMap<object, ActivityWidgetState>;
	const states = new WeakMap<object, ActivityWidgetState>();
	Object.defineProperty(root, STATE_SYMBOL, {
		value: states,
		configurable: false,
		enumerable: false,
		writable: false,
	});
	return states;
}

function stateFor(ui: ActivityWidgetUi): ActivityWidgetState {
	const states = globalStates();
	const key = ui as object;
	let state = states.get(key);
	if (!state) {
		state = {
			owners: {},
			sections: {},
			legacyCleanedOwners: new WeakSet<ActivityWidgetOwner>(),
		};
		states.set(key, state);
	}
	return state;
}

function hasVisibleSections(state: ActivityWidgetState): boolean {
	return SECTION_ORDER.some((section) => (state.sections[section]?.length ?? 0) > 0);
}

class ActivityWidgetStackComponent extends Container {
	private readonly state: ActivityWidgetState;
	private readonly theme: ActivityTheme;
	private readonly tui: ActivityTui;

	constructor(state: ActivityWidgetState, theme: ActivityTheme, tui: ActivityTui) {
		super();
		this.state = state;
		this.theme = theme;
		this.tui = tui;
		this.rebuild();
	}

	refresh(): void {
		this.rebuild();
		this.tui.requestRender();
	}

	override invalidate(): void {
		this.rebuild();
		super.invalidate();
	}

	dispose(): void {
		this.clear();
		if (this.state.component === this) this.state.component = undefined;
	}

	private rebuild(): void {
		this.clear();
		for (const section of SECTION_ORDER) {
			const lines = this.state.sections[section];
			if (!lines?.length) continue;
			for (const line of lines.slice(0, MAX_ACTIVITY_SECTION_LINES)) {
				this.addChild(new Text(line, 1, 0));
			}
			if (lines.length > MAX_ACTIVITY_SECTION_LINES) {
				this.addChild(new Text(this.theme.fg("muted", "... (widget truncated)"), 1, 0));
			}
		}
	}
}

function clearLegacyWidgets(ui: ActivityWidgetUi, state: ActivityWidgetState, owner: ActivityWidgetOwner): void {
	if (state.legacyCleanedOwners.has(owner)) return;
	state.legacyCleanedOwners.add(owner);
	for (const key of LEGACY_ACTIVITY_WIDGET_KEYS) ui.setWidget(key, undefined);
}

function syncWidget(ui: ActivityWidgetUi, state: ActivityWidgetState): void {
	if (!hasVisibleSections(state)) {
		ui.setWidget(ACTIVITY_WIDGET_KEY, undefined);
		state.component = undefined;
		return;
	}

	if (state.component) {
		state.component.refresh();
		return;
	}

	ui.setWidget(
		ACTIVITY_WIDGET_KEY,
		(tui, theme) => {
			const component = new ActivityWidgetStackComponent(state, theme, tui);
			state.component = component;
			return component;
		},
		{ placement: "aboveEditor" },
	);
}

export function createActivityWidgetOwner(section: ActivityWidgetSection): ActivityWidgetOwner {
	return Object.freeze({ section });
}

/**
 * Claim and update one section. Passing no lines also replaces an older owner,
 * which removes stale reload/session content without affecting the other section.
 */
export function setActivityWidgetSection(
	ui: ActivityWidgetUi,
	owner: ActivityWidgetOwner,
	lines?: readonly string[],
): void {
	const state = stateFor(ui);
	clearLegacyWidgets(ui, state, owner);
	state.owners[owner.section] = owner;
	if (lines?.length) state.sections[owner.section] = [...lines];
	else delete state.sections[owner.section];
	syncWidget(ui, state);
}

/** Release only the section still owned by this extension/session instance. */
export function releaseActivityWidgetSection(ui: ActivityWidgetUi, owner: ActivityWidgetOwner): void {
	const state = stateFor(ui);
	if (state.owners[owner.section] !== owner) return;
	delete state.owners[owner.section];
	delete state.sections[owner.section];
	syncWidget(ui, state);
}
