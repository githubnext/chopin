import { describe, expect, it } from "bun:test";
import * as Y from "yjs";

import type { Research } from "@chopin/protocol";

const REQUEST: Research.RequestView = {
	id: "07aeae6d-073d-4560-a9f4-bb8e4d954a46",
	channelId: "document-one",
	question: "  Keep this brief exactly.  ",
	state: "running",
	stage: "queued",
	sources: [],
	createdAt: "2026-08-24T09:00:00.000Z",
	updatedAt: "2026-08-24T09:00:00.000Z",
};

type DraftStore = {
	attachPlacement(place: (position: Y.RelativePosition, id: string) => boolean): () => void;
	canOpen(): boolean;
	cancelCreated(
		cancel: (id: string) => Promise<Research.RequestView>,
		writable?: boolean,
	): Promise<boolean>;
	change(question: string): void;
	dismiss(): boolean;
	get(): {
		created?: Research.RequestView;
		cancelling?: boolean;
		error?: string;
		position?: Y.RelativePosition;
		question: string;
		submitted?: { question: string; requestId: string };
		submitting?: boolean;
	} | undefined;
	open(
		anchor: {
			top: number;
			right: number;
			bottom: number;
			left: number;
			width: number;
			height: number;
		},
		position?: Y.RelativePosition,
	): boolean;
	place(position: Y.RelativePosition, writable?: boolean): boolean;
	start(
		create: (question: string, requestId: string) => Promise<Research.RequestView>,
	): Promise<void>;
};

async function draftStore(): Promise<{ new(): DraftStore } | undefined> {
	let module = await import("./research-draft").catch(() => ({}));
	let Store = (module as { ResearchDraftStore?: { new(): DraftStore } }).ResearchDraftStore;
	expect(typeof Store).toBe("function");
	return Store;
}

function position(name: string): Y.RelativePosition {
	let doc = new Y.Doc();
	return Y.createRelativePositionFromTypeIndex(doc.getText(name), 0);
}

const ANCHOR = { top: 1, right: 2, bottom: 3, left: 4, width: 5, height: 6 };

describe("research draft lifecycle", () => {
	it("refuses a second research draft during submission and created recovery", async () => {
		let Store = await draftStore();
		if (!Store) return;
		let store = new Store();
		let original = position("original");
		let replacement = position("replacement");
		expect(store.open(ANCHOR, original)).toBe(true);
		store.change(REQUEST.question);
		let resolve!: (request: Research.RequestView) => void;
		let create = new Promise<Research.RequestView>(done => resolve = done);
		let submitted: [string, string] | undefined;
		let running = store.start((question, requestId) => {
			submitted = [question, requestId];
			return create;
		});
		let requestId = store.get()?.submitted?.requestId;

		expect(store.canOpen()).toBe(false);
		expect(store.open({ ...ANCHOR, top: 20 }, replacement)).toBe(false);
		expect(store.get()?.question).toBe(REQUEST.question);
		expect(store.get()?.submitted?.requestId).toBe(requestId);
		expect(store.get()?.position).toBe(original);

		resolve(REQUEST);
		await running;
		expect(store.get()?.created).toEqual(REQUEST);
		expect(store.open({ ...ANCHOR, top: 30 }, replacement)).toBe(false);
		expect(store.get()?.created).toEqual(REQUEST);
		expect(store.get()?.submitted?.requestId).toBe(requestId);
		expect(store.get()?.position).toBe(original);
		expect(submitted).toEqual([REQUEST.question, requestId!]);
	});

	it("keeps an in-flight create through disconnect or read-only placement loss", async () => {
		let Store = await draftStore();
		if (!Store) return;
		let store = new Store();
		let original = position("original");
		store.open(ANCHOR, original);
		store.change(REQUEST.question);
		let resolve!: (request: Research.RequestView) => void;
		let create = new Promise<Research.RequestView>(done => resolve = done);
		let detachedCalls = 0;
		let detach = store.attachPlacement(() => {
			detachedCalls++;
			return true;
		});
		let running = store.start(() => create);
		expect(store.get()?.submitting).toBe(true);
		expect(store.dismiss()).toBe(false);
		detach();
		resolve(REQUEST);
		await running;

		expect(detachedCalls).toBe(0);
		expect(store.get()?.created).toEqual(REQUEST);
		let reconnected: [Y.RelativePosition, string] | undefined;
		store.attachPlacement((saved, id) => {
			reconnected = [saved, id];
			return true;
		});
		expect(reconnected).toEqual([original, REQUEST.id]);
		expect(store.get()).toBeUndefined();
	});

	it("keeps durable recovery through a keyed editor remount during the POST", async () => {
		let Store = await draftStore();
		if (!Store) return;
		let store = new Store();
		let oldPosition = position("old-epoch");
		let newPosition = position("new-epoch");
		store.open(ANCHOR, oldPosition);
		store.change(REQUEST.question);
		let resolve!: (request: Research.RequestView) => void;
		let create = new Promise<Research.RequestView>(done => resolve = done);
		let oldCalls = 0;
		let detach = store.attachPlacement(() => {
			oldCalls++;
			return true;
		});
		let running = store.start(() => create);
		detach();
		let newCalls: Y.RelativePosition[] = [];
		store.attachPlacement(saved => {
			newCalls.push(saved);
			return saved === newPosition;
		});
		resolve(REQUEST);
		await running;

		expect(oldCalls).toBe(0);
		expect(newCalls).toEqual([oldPosition]);
		expect(store.get()?.created?.id).toBe(REQUEST.id);
		expect(store.place(newPosition)).toBe(true);
		expect(store.get()).toBeUndefined();
	});

	it("retains one exact idempotency identity after a failed create and remount", async () => {
		let Store = await draftStore();
		if (!Store) return;
		let store = new Store();
		store.open(ANCHOR, position("brief"));
		store.change(REQUEST.question);
		let attempts: Array<[string, string]> = [];
		await store.start(async (question, requestId) => {
			attempts.push([question, requestId]);
			throw new Error("offline");
		});
		let saved = store.get()?.submitted;
		expect(saved?.question).toBe(REQUEST.question);

		await store.start(async (question, requestId) => {
			attempts.push([question, requestId]);
			return REQUEST;
		});
		expect(attempts).toEqual([
			[REQUEST.question, saved!.requestId],
			[REQUEST.question, saved!.requestId],
		]);
	});

	it("cannot dismiss created recovery and clears it only after durable cancellation", async () => {
		let Store = await draftStore();
		if (!Store) return;
		let store = new Store();
		store.open(ANCHOR, position("cancel"));
		store.change(REQUEST.question);
		await store.start(async () => REQUEST);
		expect(store.dismiss()).toBe(false);
		expect(store.get()?.created?.id).toBe(REQUEST.id);

		let cancelled: string | undefined;
		let finish!: (request: Research.RequestView) => void;
		let waiting = new Promise<Research.RequestView>(done => finish = done);
		let cancellation = store.cancelCreated(async id => {
			cancelled = id;
			return waiting;
		});
		expect(store.get()?.cancelling).toBe(true);
		expect(store.dismiss()).toBe(false);
		let placements = 0;
		store.attachPlacement(() => {
			placements++;
			return true;
		});
		expect(placements).toBe(0);
		finish({ ...REQUEST, state: "cancelled", stage: "cancelled" });
		expect(await cancellation).toBe(true);
		expect(cancelled).toBe(REQUEST.id);
		expect(store.get()).toBeUndefined();
	});

	it("preserves created recovery without mutation while read-only", async () => {
		let Store = await draftStore();
		if (!Store) return;
		let store = new Store();
		let original = position("read-only-original");
		store.open(ANCHOR, original);
		store.change(REQUEST.question);
		await store.start(async () => REQUEST);
		let snapshot = store.get();
		let cancellations = 0;

		expect(
			await store.cancelCreated(async () => {
				cancellations++;
				return { ...REQUEST, state: "cancelled", stage: "cancelled" };
			}, false),
		).toBe(false);
		expect(store.place(position("read-only-new"), false)).toBe(false);
		expect(cancellations).toBe(0);
		expect(store.get()).toBe(snapshot);
		expect(store.get()?.created).toEqual(REQUEST);
		expect(store.get()?.position).toBe(original);
	});
});
