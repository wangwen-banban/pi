export interface StatuslineModel {
	id: string;
	provider: string;
	contextWindow?: number;
}

export interface ActiveModelState {
	get(): StatuslineModel | undefined;
	set(model: StatuslineModel | undefined): void;
	bindRender(render: () => void): () => void;
}

export function createActiveModelState(initial?: StatuslineModel): ActiveModelState {
	let active = initial;
	let requestRender: (() => void) | undefined;
	return {
		get: () => active,
		set(model) {
			active = model;
			requestRender?.();
		},
		bindRender(render) {
			requestRender = render;
			return () => {
				if (requestRender === render) requestRender = undefined;
			};
		},
	};
}

export function getRoutingProviderForStatusline(provider: string): string {
	return provider === "openai-codex-second" ? "openai-codex" : provider;
}
