import { expect, test } from "bun:test";

import {
	closeDocumentRoute,
	initialDocumentRouteSwap,
	requestDocumentRoute,
	resolveDocumentRoute,
} from "./document-route-swap";

let a = { immediately: true, key: "document:a", slug: "a" };
let b = { immediately: false, key: "document:b", slug: "b" };
let c = { immediately: false, key: "document:c", slug: "c" };

test("a requested document remains pending until it resolves", () => {
	let state = initialDocumentRouteSwap(a);
	state = requestDocumentRoute(state, b);
	expect(state).toEqual({ current: a, pending: b });

	state = resolveDocumentRoute(state, b.key);
	expect(state).toEqual({ current: b, previous: a });
});

test("requesting the outgoing route reverses an active swap", () => {
	let state = resolveDocumentRoute(requestDocumentRoute(initialDocumentRouteSwap(a), b), b.key);
	let requested = { ...a, immediately: false };
	state = requestDocumentRoute(state, requested);
	expect(state).toEqual({ current: requested, previous: b });
});

test("rapid requests cancel pending work and preserve the requested visible route", () => {
	let state = resolveDocumentRoute(requestDocumentRoute(initialDocumentRouteSwap(a), b), b.key);
	state = requestDocumentRoute(state, a);
	state = requestDocumentRoute(state, c);
	state = requestDocumentRoute(state, b);

	expect(state.pending).toBeUndefined();
	expect(state.current).toBe(b);
});

test("stale resolve and close events cannot replace or remove current content", () => {
	let state = requestDocumentRoute(initialDocumentRouteSwap(a), b);
	expect(resolveDocumentRoute(state, c.key)).toBe(state);

	state = resolveDocumentRoute(state, b.key);
	expect(closeDocumentRoute(state, c.key)).toBe(state);
	expect(closeDocumentRoute(state, state.current.key)).toBe(state);
	expect(closeDocumentRoute(state, a.key)).toEqual({ current: b, pending: undefined });
});
