import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";

export const ACTIVITY_WIDGET_KEY = "activity-widget-stack";
export const LEGACY_ACTIVITY_WIDGET_KEYS = ["background-tasks", "smart-subagents"] as const;
export const MAX_ACTIVITY_SECTION_LINES = 10;

export type ActivityWidgetSection = "tasks" | "subagents";

export interface ActivityWidgetOwner {
	readonly section: ActivityWidgetSection;
}

export interface ActivityWidgetPresentationLease {
	/** Release this lease once. Repeated calls are harmless. */
	release(): void;
}

const SECTION_ORDER: readonly ActivityWidgetSection[] = ["tasks", "subagents"];
const STATE_SYMBOL = Symbol.for("pi.extensions.activity-widget-stack.state.v1");

type ActivityWidgetUi = Pick<ExtensionUIContext, "setWidget">;
type ActivityTheme = { fg(color: "muted", text: string): string };
type ActivityTui = { requestRender(): void };

interface ActivityWidgetState {
	owners: Partial<Record<ActivityWidgetSection, ActivityWidgetOwner>>;
	/** Latest logical state, including updates received while presentation is leased. */
	sections: Partial<Record<ActivityWidgetSection, readonly string[]>>;
	/** Immutable-for-the-lease snapshot consumed by the mounted component. */
	presentedSections: Partial<Record<ActivityWidgetSection, readonly string[]>>;
	legacyCleanedOwners: WeakSet<ActivityWidgetOwner>;
	retiredOwners: WeakSet<ActivityWidgetOwner>;
	presentationLeases: Set<object>;
	presentationDirty: boolean;
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

function copySections(
	sections: Partial<Record<ActivityWidgetSection, readonly string[]>>,
): Partial<Record<ActivityWidgetSection, readonly string[]>> {
	const copy: Partial<Record<ActivityWidgetSection, readonly string[]>> = {};
	for (const section of SECTION_ORDER) {
		const lines = sections[section];
		if (lines?.length) copy[section] = [...lines];
	}
	return copy;
}

function stateFor(ui: ActivityWidgetUi): ActivityWidgetState {
	const states = globalStates();
	const key = ui as object;
	let state = states.get(key);
	if (!state) {
		state = {
			owners: {},
			sections: {},
			presentedSections: {},
			legacyCleanedOwners: new WeakSet<ActivityWidgetOwner>(),
			retiredOwners: new WeakSet<ActivityWidgetOwner>(),
			presentationLeases: new Set<object>(),
			presentationDirty: false,
		};
		states.set(key, state);
	} else {
		// STATE_SYMBOL intentionally remains v1 so independently loaded extension
		// copies share ownership. Fill fields added after the original v1 shape.
		state.presentedSections ??= copySections(state.sections);
		state.retiredOwners ??= new WeakSet<ActivityWidgetOwner>();
		state.presentationLeases ??= new Set<object>();
		state.presentationDirty ??= false;
	}
	return state;
}

function hasVisibleSections(
	sections: Partial<Record<ActivityWidgetSection, readonly string[]>>,
): boolean {
	return SECTION_ORDER.some((section) => (sections[section]?.length ?? 0) > 0);
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
			const lines = this.state.presentedSections[section];
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
	state.presentedSections = copySections(state.sections);
	if (!hasVisibleSections(state.presentedSections)) {
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

function requestWidgetSync(ui: ActivityWidgetUi, state: ActivityWidgetState): void {
	if (state.presentationLeases.size > 0) {
		state.presentationDirty = true;
		return;
	}
	state.presentationDirty = false;
	syncWidget(ui, state);
}

export function createActivityWidgetOwner(section: ActivityWidgetSection): ActivityWidgetOwner {
	return Object.freeze({ section });
}

/**
 * Freeze this UI's shared widget at its current snapshot while logical section
 * updates continue. Leases are UI-local, nest across independently loaded module
 * copies, and release idempotently. The final release performs at most one shared
 * widget presentation update with the latest Tasks-then-Sub-Agents state.
 */
export function acquireActivityWidgetPresentationLease(
	ui: ActivityWidgetUi,
): ActivityWidgetPresentationLease {
	const state = stateFor(ui);
	const token = Object.freeze({});
	state.presentationLeases.add(token);
	let active = true;

	return Object.freeze({
		release(): void {
			if (!active) return;
			active = false;
			if (!state.presentationLeases.delete(token)) return;
			if (state.presentationLeases.size > 0 || !state.presentationDirty) return;

			// Legacy-key cleanup is deliberately not attempted here: each setWidget
			// can render in Pi 0.84.1, while the outer release promises one flush.
			// An owner first seen during the lease performs that one-time migration
			// on its next ordinary update; the shared snapshot is current now.
			requestWidgetSync(ui, state);
		},
	});
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
	if (state.retiredOwners.has(owner)) return;
	if (state.presentationLeases.size === 0) clearLegacyWidgets(ui, state, owner);
	const previousOwner = state.owners[owner.section];
	if (previousOwner && previousOwner !== owner) state.retiredOwners.add(previousOwner);
	state.owners[owner.section] = owner;
	if (lines?.length) state.sections[owner.section] = [...lines];
	else delete state.sections[owner.section];
	requestWidgetSync(ui, state);
}

/** Release only the section still owned by this extension/session instance. */
export function releaseActivityWidgetSection(ui: ActivityWidgetUi, owner: ActivityWidgetOwner): void {
	const state = stateFor(ui);
	if (state.owners[owner.section] !== owner) return;
	state.retiredOwners.add(owner);
	delete state.owners[owner.section];
	delete state.sections[owner.section];
	requestWidgetSync(ui, state);
}
