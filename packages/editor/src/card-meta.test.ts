import { describe, expect, it } from "bun:test";

import { CardMetaStore } from "./card-meta";

import type { Transport } from "./transport";

function wire() {
	let handlers = new Map<string, (frame: never) => void>();
	let value: Transport = {
		on: (kind, handler) => {
			handlers.set(kind, handler as never);
			return () => handlers.delete(kind);
		},
		send() {},
		ask: async () => ({}) as never,
	};
	return { value, emit: (kind: string, frame: unknown) => handlers.get(kind)?.(frame as never) };
}

const META = {
	status: "decided" as const,
	origin: "conversation" as const,
	involved: ["ana"],
	history: [],
	optionOrigins: {},
	hasProse: false,
	refining: false,
	proseOrphaned: false,
};

describe("CardMetaStore", () => {
	it("takes a join snapshot and later updates", () => {
		let store = new CardMetaStore();
		let socket = wire();
		store.listen(socket.value);
		socket.emit("question:metas", { cards: [{ id: "w", meta: META }] });
		expect(store.get("w")?.status).toBe("decided");
		socket.emit("question:meta", { id: "w", meta: { ...META, status: "discarded" } });
		expect(store.get("w")?.status).toBe("discarded");
	});

	it("notifies subscribers with a new snapshot identity", () => {
		let store = new CardMetaStore();
		let socket = wire();
		store.listen(socket.value);
		let before = store.snapshot();
		let calls = 0;
		store.subscribe(() => calls++);
		socket.emit("question:meta", { id: "w", meta: META });
		expect(calls).toBe(1);
		expect(store.snapshot()).not.toBe(before);
	});

	it("retires a closed controller before publishing reopened metadata", () => {
		let forgotten: string[] = [];
		let store = new CardMetaStore((_wire, id) => forgotten.push(id));
		let socket = wire();
		store.listen(socket.value);
		socket.emit("question:meta", { id: "w", meta: META });
		store.subscribe(() => {
			if (store.get("w")?.status === "reopened") expect(forgotten).toEqual(["w"]);
		});
		socket.emit("question:meta", { id: "w", meta: { ...META, status: "reopened" } });
		expect(forgotten).toEqual(["w"]);
	});

	it("retires a closed controller from a reconnect snapshot only once", () => {
		let forgotten: string[] = [];
		let store = new CardMetaStore((_wire, id) => forgotten.push(id));
		let socket = wire();
		store.listen(socket.value);
		socket.emit("question:metas", { cards: [{ id: "w", meta: META }] });
		let reopened = { ...META, status: "reopened" };
		socket.emit("question:metas", { cards: [{ id: "w", meta: reopened }] });
		expect(forgotten).toEqual(["w"]);
		socket.emit("question:metas", { cards: [{ id: "w", meta: reopened }] });
		expect(forgotten).toEqual(["w"]);
	});

	it("recognizes a later reopen even when the decided frame was missed", () => {
		let forgotten: string[] = [];
		let store = new CardMetaStore((_wire, id) => forgotten.push(id));
		let socket = wire();
		store.listen(socket.value);
		let first = { ...META, status: "reopened", history: [{ choices: ["a"], owner: "ana", at: 1 }] };
		let second = {
			...first,
			history: [...first.history, { choices: ["b"], owner: "ben", at: 2 }],
		};
		socket.emit("question:metas", { cards: [{ id: "w", meta: first }] });
		socket.emit("question:metas", { cards: [{ id: "w", meta: second }] });
		expect(forgotten).toEqual(["w", "w"]);
	});

	it("clears on disconnect without retiring an already reopened draft again", () => {
		let forgotten: string[] = [];
		let store = new CardMetaStore((_wire, id) => forgotten.push(id));
		let socket = wire();
		let off = store.listen(socket.value);
		let reopened = { ...META, status: "reopened" };
		socket.emit("question:metas", { cards: [{ id: "w", meta: reopened }] });
		expect(forgotten).toEqual(["w"]);
		off();
		store.listen(undefined);
		expect(store.get("w")).toBeUndefined();
		store.listen(socket.value);
		socket.emit("question:metas", { cards: [{ id: "w", meta: reopened }] });
		expect(forgotten).toEqual(["w"]);
	});
});
