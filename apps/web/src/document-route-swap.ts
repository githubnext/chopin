export type KeyedDocumentRoute = {
	immediately: boolean;
	key: string;
};

type ReadyDocumentRoute<T extends KeyedDocumentRoute, C> = T & { channel?: C };

export type DocumentRouteSwap<T extends KeyedDocumentRoute, C = unknown> = {
	current: ReadyDocumentRoute<T, C>;
	pending?: ReadyDocumentRoute<T, C>;
	previous?: ReadyDocumentRoute<T, C>;
};

export type DocumentRouteAction<T extends KeyedDocumentRoute, C = unknown> =
	| { route: T; type: "requested" }
	| { channel?: C; key: string; type: "ready" }
	| { key: string; type: "closed" };

export function transitionDocumentRoute<T extends KeyedDocumentRoute, C = unknown>(
	state: DocumentRouteSwap<T, C>,
	action: DocumentRouteAction<T, C>,
): DocumentRouteSwap<T, C> {
	if (action.type === "requested") {
		let requested = action.route;
		let reverse = (
			route: ReadyDocumentRoute<T, C>,
		): ReadyDocumentRoute<T, C> => ({ ...route, immediately: requested.immediately });
		if (requested.key === state.current.key) {
			return state.pending
				? {
					current: reverse(state.current),
					previous: state.previous,
				}
				: state;
		}
		if (requested.key === state.previous?.key) {
			return {
				current: reverse(state.previous),
				previous: state.current,
			};
		}
		return { ...state, pending: requested };
	}
	if (action.type === "ready") {
		let ready = (route: ReadyDocumentRoute<T, C>): ReadyDocumentRoute<T, C> =>
			action.channel === undefined
				? route
				: { ...route, channel: action.channel };
		if (state.pending?.key === action.key) {
			return { current: ready(state.pending), previous: state.current };
		}
		if (state.current.key === action.key && action.channel !== undefined) {
			if (state.current.channel === action.channel) return state;
			return { ...state, current: ready(state.current) };
		}
		if (state.previous?.key === action.key && action.channel !== undefined) {
			if (state.previous.channel === action.channel) return state;
			return { ...state, previous: ready(state.previous) };
		}
		return state;
	}
	return state.previous?.key === action.key
		? { current: state.current, pending: state.pending }
		: state;
}
