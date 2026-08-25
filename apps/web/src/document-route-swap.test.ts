import { expect, test } from "bun:test";

import { transitionDocumentRoute } from "./document-route-swap";

import type { DocumentRouteSwap } from "./document-route-swap";

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

test("a requested document remains pending until it resolves", () => {
	let state: DocumentRouteSwap<Route> = { current: a };
	state = transitionDocumentRoute(state, { route: b, type: "requested" });
	expect(state).toEqual({ current: a, pending: b });

	state = transitionDocumentRoute(state, { key: b.key, type: "ready" });
	expect(state).toEqual({ current: b, previous: a });
});

test("reversing to a loaded route preserves metadata and updates input modality", () => {
	let state: DocumentRouteSwap<Route, string> = { current: a };
	state = transitionDocumentRoute(state, { route: b, type: "requested" });
	state = transitionDocumentRoute(state, { key: b.key, type: "ready" });
	state = transitionDocumentRoute(state, {
		channel: "loaded",
		key: a.key,
		type: "ready",
	});
	let requested = { ...a, immediately: false, source: { slug: "a" } };
	state = transitionDocumentRoute(state, { route: requested, type: "requested" });
	expect(state).toEqual({
		current: { ...a, channel: "loaded", immediately: false },
		previous: b,
	});
	expect(state.current.source).toBe(a.source);
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
