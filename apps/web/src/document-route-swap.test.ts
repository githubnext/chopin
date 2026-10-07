import { expect, test } from "bun:test";

import { documentRouteIdentity, transitionDocumentRoute } from "./document-route-swap";

import type { DocumentRouteIdentity, DocumentRouteSwap } from "./document-route-swap";

type Route = {
	channel?: string;
	immediately: boolean;
	key: string;
	routeKey: string;
	slug: string;
	source: { slug: string };
};

let a: Route = {
	immediately: true,
	key: "document:a",
	routeKey: "document:a",
	slug: "a",
	source: { slug: "a" },
};
let b: Route = {
	immediately: false,
	key: "document:b",
	routeKey: "document:b",
	slug: "b",
	source: { slug: "b" },
};
let c: Route = {
	immediately: false,
	key: "document:c",
	routeKey: "document:c",
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
	let child = {
		...a,
		routeKey: "child:a/child",
		slug: "child",
		source: { slug: "child" },
	};

	state = transitionDocumentRoute(state, { route: child, type: "requested" });

	expect(state.current).toEqual({ ...child, resolution: "loaded" });
});

test("reversing to the exact retained route preserves its mounted source", () => {
	let state: DocumentRouteSwap<Route> = { current: a };
	state = transitionDocumentRoute(state, { route: b, type: "requested" });
	state = transitionDocumentRoute(state, { key: b.key, type: "ready" });
	let repeated = { ...a, immediately: false, source: { slug: "a" } };

	state = transitionDocumentRoute(state, { route: repeated, type: "requested" });

	expect(state.current.source).toBe(a.source);
	expect(state.current.immediately).toBe(false);
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
	let requested = {
		...a,
		immediately: false,
		routeKey: "document:alias-a",
		source: { slug: "a" },
	};
	state = transitionDocumentRoute(state, { route: requested, type: "requested" });
	// B never reached the screen while A was leaving, so it is dropped.
	expect(state).toEqual({ current: { ...requested, resolution: "loaded" } });
	expect(state.current.source).toBe(requested.source);
});

test("rapid requests replace pending work and keep the leaving route until the newest is ready", () => {
	let state: DocumentRouteSwap<Route> = { current: a };
	state = transitionDocumentRoute(state, { route: b, type: "requested" });
	state = transitionDocumentRoute(state, { key: b.key, type: "ready" });
	state = transitionDocumentRoute(state, { route: a, type: "requested" });
	state = transitionDocumentRoute(state, { route: c, type: "requested" });
	state = transitionDocumentRoute(state, { route: b, type: "requested" });

	expect(state.current.key).toBe(a.key);
	expect(state.previous).toBeUndefined();
	expect(state.pending).toEqual(b);
});

test("a route that becomes ready while another is leaving replaces the never-shown one", () => {
	let state: DocumentRouteSwap<Route> = { current: a };
	state = transitionDocumentRoute(state, { route: b, type: "requested" });
	state = transitionDocumentRoute(state, { key: b.key, type: "ready" });
	// A is still leaving, so B has not been shown yet.
	state = transitionDocumentRoute(state, { route: c, type: "requested" });
	state = transitionDocumentRoute(state, { key: c.key, type: "ready" });

	expect(state).toEqual({ current: c, previous: a });
	state = transitionDocumentRoute(state, { key: a.key, type: "closed" });
	expect(state).toEqual({ current: c, pending: undefined });
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
