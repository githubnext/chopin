import type { ChannelDetail } from "./api";
import type { DocumentMetadata } from "./document-actions";
import type { DocumentRouteIdentitySource } from "./document-route-swap";

export type ChildPresentation = "closed" | "open" | "closing";

type DocumentRoute = Extract<DocumentRouteIdentitySource, { page: "document" | "child" }>;

type EmptyDocumentWorkspace = {
	error?: unknown;
	presentation: "closed";
	retry: number;
	status: "empty";
};

export type ReadyDocumentWorkspace = {
	childSlugs: ReadonlySet<string>;
	error?: unknown;
	loaded: { child?: ChannelDetail; parent: ChannelDetail };
	parentSlugs: ReadonlySet<string>;
	presentation: ChildPresentation;
	retry: number;
	status: "ready";
};

export type DocumentWorkspaceState = EmptyDocumentWorkspace | ReadyDocumentWorkspace;

export type DocumentWorkspaceAction =
	| { type: "loading" }
	| { error: unknown; type: "failed" }
	| {
		parent: ChannelDetail;
		route: Extract<DocumentRoute, { page: "child" }>;
		type: "parent-ready";
	}
	| { child?: ChannelDetail; parent: ChannelDetail; route: DocumentRoute; type: "ready" }
	| { route: DocumentRoute; type: "route" }
	| { kind: "parent" | "child"; metadata: DocumentMetadata; type: "metadata" }
	| { type: "retry" }
	| { type: "closed" };

export function initialDocumentWorkspaceState(retry = 0): DocumentWorkspaceState {
	return { presentation: "closed", retry, status: "empty" };
}

export function childPresentation(
	current: ChildPresentation,
	route: "parent" | "child",
	sameParent: boolean,
): ChildPresentation {
	if (route === "child") return sameParent ? "open" : "closed";
	if (current !== "closed" && sameParent) return "closing";
	return "closed";
}

function sameRepository(route: DocumentRoute, detail: ChannelDetail): boolean {
	return route.owner.toLocaleLowerCase() === detail.repository.owner.toLocaleLowerCase()
		&& route.repository.toLocaleLowerCase() === detail.repository.name.toLocaleLowerCase();
}

function routeMatchesParent(
	state: ReadyDocumentWorkspace,
	route: DocumentRoute,
): boolean {
	let slug = route.page === "child" ? route.parentSlug : route.slug;
	return sameRepository(route, state.loaded.parent) && state.parentSlugs.has(slug);
}

export function transitionDocumentWorkspace(
	state: DocumentWorkspaceState,
	action: DocumentWorkspaceAction,
): DocumentWorkspaceState {
	if (action.type === "loading") return { ...state, error: undefined };
	if (action.type === "failed") return { ...state, error: action.error };
	if (action.type === "retry") return { ...state, error: undefined, retry: state.retry + 1 };
	if (action.type === "parent-ready") {
		return {
			childSlugs: new Set(),
			loaded: { parent: action.parent },
			parentSlugs: new Set([action.parent.channel.slug, action.route.parentSlug]),
			presentation: "open",
			retry: state.retry,
			status: "ready",
		};
	}
	if (action.type === "ready") {
		let previous = state.status === "ready" ? state : undefined;
		let sameParent = previous?.loaded.parent.channel.id === action.parent.channel.id;
		let parentSlugs = previous && sameParent
			? new Set(previous.parentSlugs)
			: new Set<string>();
		parentSlugs.add(action.parent.channel.slug);
		parentSlugs.add(action.route.page === "child" ? action.route.parentSlug : action.route.slug);
		let childSlugs = action.child && previous?.loaded.child?.channel.id === action.child.channel.id
			? new Set(previous.childSlugs)
			: new Set<string>();
		if (action.child) {
			childSlugs.add(action.child.channel.slug);
			if (action.route.page === "child") childSlugs.add(action.route.childSlug);
		}
		let loaded = action.child
			? { child: action.child, parent: action.parent }
			: sameParent && previous?.loaded.child
			? { ...previous.loaded, parent: action.parent }
			: { parent: action.parent };
		let presentation = action.child
			? childPresentation(previous?.presentation ?? "closed", "child", true)
			: previous?.loaded.child
			? childPresentation(previous.presentation, "parent", !!sameParent)
			: previous?.presentation ?? "closed";
		return {
			childSlugs,
			loaded,
			parentSlugs,
			presentation,
			retry: state.retry,
			status: "ready",
		};
	}
	if (action.type === "route") {
		if (state.status === "empty") return state;
		let sameParent = routeMatchesParent(state, action.route);
		if (action.route.page === "child") {
			let sameChild = sameParent && state.loaded.child
				&& state.childSlugs.has(action.route.childSlug);
			let presentation = childPresentation(state.presentation, "child", sameParent);
			if (sameChild || (!state.loaded.child && sameParent)) return { ...state, presentation };
			if (!sameParent) return initialDocumentWorkspaceState(state.retry);
			return {
				...state,
				childSlugs: new Set(),
				loaded: { parent: state.loaded.parent },
				presentation,
			};
		}
		let presentation = childPresentation(state.presentation, "parent", sameParent);
		return sameParent
			? { ...state, presentation }
			: initialDocumentWorkspaceState(state.retry);
	}
	if (action.type === "metadata") {
		if (state.status === "empty") return state;
		let target = action.kind === "parent" ? state.loaded.parent : state.loaded.child;
		if (!target) return state;
		let detail = { ...target, channel: { ...target.channel, ...action.metadata } };
		let loaded = action.kind === "parent"
			? { ...state.loaded, parent: detail }
			: { ...state.loaded, child: detail };
		let slugs = new Set(action.kind === "parent" ? state.parentSlugs : state.childSlugs);
		slugs.add(action.metadata.slug);
		return {
			...state,
			loaded,
			...(action.kind === "parent" ? { parentSlugs: slugs } : { childSlugs: slugs }),
		};
	}
	if (state.status === "empty") return state;
	return {
		...state,
		childSlugs: new Set(),
		loaded: { parent: state.loaded.parent },
		presentation: "closed",
	};
}
