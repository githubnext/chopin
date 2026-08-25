export type KeyedDocumentRoute = { key: string };

export type DocumentRouteSwap<T extends KeyedDocumentRoute> = {
	current: T;
	pending?: T;
	previous?: T;
};

export function initialDocumentRouteSwap<T extends KeyedDocumentRoute>(
	current: T,
): DocumentRouteSwap<T> {
	return { current };
}

export function requestDocumentRoute<T extends KeyedDocumentRoute>(
	state: DocumentRouteSwap<T>,
	requested: T,
): DocumentRouteSwap<T> {
	if (requested.key === state.current.key) {
		return state.pending ? { current: state.current, previous: state.previous } : state;
	}
	if (requested.key === state.previous?.key) {
		return { current: state.previous, previous: state.current };
	}
	return { ...state, pending: requested };
}

export function resolveDocumentRoute<T extends KeyedDocumentRoute>(
	state: DocumentRouteSwap<T>,
	key: string,
): DocumentRouteSwap<T> {
	if (state.pending?.key !== key) return state;
	return { current: state.pending, previous: state.current };
}

export function closeDocumentRoute<T extends KeyedDocumentRoute>(
	state: DocumentRouteSwap<T>,
	key: string,
): DocumentRouteSwap<T> {
	return state.previous?.key === key
		? { current: state.current, pending: state.pending }
		: state;
}
