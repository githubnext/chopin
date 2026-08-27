import { expect, test } from "bun:test";

import { documentRouteIdentity, transitionDocumentRoute } from "./document-route-swap";

import type { DocumentRouteIdentity, DocumentRouteSwap } from "./document-route-swap";

type Route = {
	channel?: string;
	immediately: boolean;
	key: string;
	slug: string;
	source: { slug: string };
};

let a: Route = {
	immediately: true,
	key: "document:a",
	slug: "a",
	source: { slug: "a" },
};
let b: Route = {
	immediately: false,
	key: "document:b",
	slug: "b",
	source: { slug: "b" },
};
let c: Route = {
	immediately: false,
	key: "document:c",
	slug: "c",
	source: { slug: "c" },
};

test("document route identities have one canonical encoding", () => {
	let identity: DocumentRouteIdentity = documentRouteIdentity({
		id: "channel-id",
		page: "channel",
	});
	expect(String(identity)).toBe("channel:channel-id");
	expect(String(documentRouteIdentity({
		owner: "octo-org",
		page: "document",
		repository: "score",
		slug: "launch-plan",
	}))).toBe("document:octo-org/score/launch-plan");
	expect(String(documentRouteIdentity({
		owner: "octo-org",
		page: "research",
		repository: "score",
		slug: "launch-plan",
		workspaceId: "workspace-id",
	}))).toBe("research:octo-org/score/launch-plan/workspace-id");
	// @ts-expect-error Route identities must come from the canonical encoder.
	let untyped: DocumentRouteIdentity = "document:octo-org/score/launch-plan";
	void untyped;
});

test("a requested document remains pending until it resolves", () => {
	let state: DocumentRouteSwap<Route> = { current: a };
	state = transitionDocumentRoute(state, { route: b, type: "requested" });
	expect(state).toEqual({ current: a, pending: b });

	state = transitionDocumentRoute(state, { key: b.key, type: "ready" });
	expect(state).toEqual({ current: b, previous: a });
});

test("retargeting a retained layer makes its requested source authoritative", () => {
	let state: DocumentRouteSwap<Route, string> = {
		current: { ...a, resolution: "loaded" },
	};
	let child = { ...a, slug: "child", source: { slug: "child" } };

	state = transitionDocumentRoute(state, { route: child, type: "requested" });

	expect(state.current).toEqual({ ...child, resolution: "loaded" });
});

test("reversing to a loaded layer preserves metadata and accepts the requested source", () => {
	let state: DocumentRouteSwap<Route, string> = { current: a };
	state = transitionDocumentRoute(state, { route: b, type: "requested" });
	state = transitionDocumentRoute(state, { key: b.key, type: "ready" });
	state = transitionDocumentRoute(state, {
		key: a.key,
		resolution: "loaded",
		type: "ready",
	});
	let requested = { ...a, immediately: false, source: { slug: "a" } };
	state = transitionDocumentRoute(state, { route: requested, type: "requested" });
	expect(state).toEqual({
		current: { ...requested, resolution: "loaded" },
		previous: b,
	});
	expect(state.current.source).toBe(requested.source);
});

test("rapid requests cancel pending work and preserve the requested visible route", () => {
	let state: DocumentRouteSwap<Route> = { current: a };
	state = transitionDocumentRoute(state, { route: b, type: "requested" });
	state = transitionDocumentRoute(state, { key: b.key, type: "ready" });
	state = transitionDocumentRoute(state, { route: a, type: "requested" });
	state = transitionDocumentRoute(state, { route: c, type: "requested" });
	state = transitionDocumentRoute(state, { route: b, type: "requested" });

	expect(state.pending).toBeUndefined();
	expect(state.current).toEqual(b);
});

test("stale ready and close events cannot replace or remove current content", () => {
	let state: DocumentRouteSwap<Route> = { current: a };
	state = transitionDocumentRoute(state, { route: b, type: "requested" });
	expect(transitionDocumentRoute(state, { key: c.key, type: "ready" })).toBe(state);

	state = transitionDocumentRoute(state, { key: b.key, type: "ready" });
	expect(transitionDocumentRoute(state, { key: c.key, type: "closed" })).toBe(state);
	expect(transitionDocumentRoute(state, { key: state.current.key, type: "closed" })).toBe(state);
	expect(transitionDocumentRoute(state, { key: a.key, type: "closed" })).toEqual({
		current: b,
		pending: undefined,
	});
});
