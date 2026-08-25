export type KeyedDocumentRoute = {
	immediately: boolean;
	key: string;
	routeKey?: string;
};

declare const documentRouteIdentityBrand: unique symbol;

export type DocumentRouteIdentity = string & {
	readonly [documentRouteIdentityBrand]: true;
};

export type DocumentRouteIdentitySource =
	| { id: string; page: "channel" }
	| { owner: string; page: "document"; repository: string; slug: string }
	| {
		childSlug: string;
		owner: string;
		page: "child";
		parentSlug: string;
		repository: string;
	};

export function documentRouteIdentity(source: DocumentRouteIdentitySource): DocumentRouteIdentity {
	switch (source.page) {
		case "channel":
			return `channel:${source.id}` as DocumentRouteIdentity;
		case "document":
			return `document:${source.owner}/${source.repository}/${source.slug}` as DocumentRouteIdentity;
		case "child":
			return (
				`child:${source.owner}/${source.repository}/${source.parentSlug}/${source.childSlug}`
			) as DocumentRouteIdentity;
	}
}

type ReadyDocumentRoute<T extends KeyedDocumentRoute, R> = T & { resolution?: R };

export type DocumentRouteSwap<T extends KeyedDocumentRoute, R = unknown> = {
	current: ReadyDocumentRoute<T, R>;
	pending?: ReadyDocumentRoute<T, R>;
	previous?: ReadyDocumentRoute<T, R>;
};

export type DocumentRouteAction<T extends KeyedDocumentRoute, R = unknown> =
	| { route: T; type: "requested" }
	| { key: string; resolution?: R; type: "ready" }
	| { key: string; type: "closed" };

export function transitionDocumentRoute<T extends KeyedDocumentRoute, R = unknown>(
	state: DocumentRouteSwap<T, R>,
	action: DocumentRouteAction<T, R>,
): DocumentRouteSwap<T, R> {
	if (action.type === "requested") {
		let requested = action.route;
		let retarget = (
			route: ReadyDocumentRoute<T, R>,
		): ReadyDocumentRoute<T, R> =>
			requested.routeKey !== undefined && requested.routeKey === route.routeKey
				? { ...route, immediately: requested.immediately }
				: { ...requested, resolution: route.resolution };
		if (requested.key === state.current.key) {
			return {
				current: retarget(state.current),
				previous: state.previous,
			};
		}
		if (requested.key === state.previous?.key) {
			return {
				current: retarget(state.previous),
				previous: state.current,
			};
		}
		return { ...state, pending: requested };
	}
	if (action.type === "ready") {
		let ready = (route: ReadyDocumentRoute<T, R>): ReadyDocumentRoute<T, R> =>
			action.resolution === undefined
				? route
				: { ...route, resolution: action.resolution };
		if (state.pending?.key === action.key) {
			return { current: ready(state.pending), previous: state.current };
		}
		if (state.current.key === action.key && action.resolution !== undefined) {
			if (state.current.resolution === action.resolution) return state;
			return { ...state, current: ready(state.current) };
		}
		if (state.previous?.key === action.key && action.resolution !== undefined) {
			if (state.previous.resolution === action.resolution) return state;
			return { ...state, previous: ready(state.previous) };
		}
		return state;
	}
	return state.previous?.key === action.key
		? { current: state.current, pending: state.pending }
		: state;
}
