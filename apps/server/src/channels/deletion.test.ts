import { describe, expect, it } from "bun:test";
import { $createParagraphNode, $createTextNode, $getRoot } from "lexical";
import * as Y from "yjs";

import { MemoryStorage } from "../storage/memory/adapter";
import { contractId, userAndChannel } from "../storage/contract-support";
import { StorageError } from "../storage/errors";
import { DELETED_REMEMBERED_MS, DocumentDeletion } from "./deletion";
import * as Room from "../plan/room";
import * as Service from "../plan/service";
import { openPlan } from "../testing/plan";

import type { DocumentDeletionDeps } from "./deletion";
import type { Lease } from "../storage/model";
import type { Socket } from "../wire";

const ANA = { id: "U_ana", login: "ana" };

/** A document with one child, and a deletion whose every step says when it ran. */
async function world(overrides: Partial<DocumentDeletionDeps> = {}) {
	let storage = new MemoryStorage();
	let { userId, channelId, repositoryId, lease } = await userAndChannel(storage);
	let child = await storage.channels.create({
		id: contractId("child"),
		repositoryId,
		repositoryOwner: "octo-org",
		repositoryName: "score",
		title: "Research child",
		createdBy: userId,
		parentChannelId: channelId,
		now: new Date("2026-01-03T03:04:05.000Z"),
	});
	let held = { lease };
	let steps: string[] = [];
	let deleting = new Set<string>();
	let clock = { now: 1_000 };
	let transitions = new Map<string, Promise<unknown>>();
	let deps: DocumentDeletionDeps = {
		storage,
		lease: () => held.lease,
		deleting,
		transition: (id, action) => {
			let next = (transitions.get(id) ?? Promise.resolve()).then(action, action);
			transitions.set(id, next.catch(() => {}));
			return next;
		},
		children: async document =>
			(await storage.channels.children(document.id, 100)).map(item => item.id),
		running: async () => undefined,
		stop: async id => {
			steps.push(`stop ${id === channelId ? "document" : "child"}`);
		},
		resume: async ids => {
			steps.push(`resume ${ids.length}`);
		},
		deleted: (deleted, by) => {
			steps.push(`told ${deleted.length} by ${by.login}`);
		},
		clock: () => clock.now,
		...overrides,
	};
	return { storage, deps, steps, deleting, clock, held, channelId, childId: child.id, lease };
}

function commit(storage: MemoryStorage, channelId: string, lease: Lease, operation: string) {
	return storage.collaboration.commit({
		channelId,
		lease,
		expectedRevision: 0,
		operationId: contractId(operation),
		epoch: "epoch",
		update: new Uint8Array([1, 2, 3]),
		sidecar: { edited: operation },
		events: [],
		now: new Date("2026-01-04T03:04:05.000Z"),
	});
}

describe("deleting a document", () => {
	it("stops its children and itself, commits once, and only then tells anyone", async () => {
		let { storage, deps, steps, deleting, channelId, childId } = await world();
		deps.stop = async id => {
			// Nothing may start on either while they stop.
			expect([...deleting].sort()).toEqual([channelId, childId].sort());
			steps.push(`stop ${id === channelId ? "document" : "child"}`);
		};
		let seen: Promise<unknown> | undefined;
		deps.deleted = (deleted, by) => {
			// Read as the telling begins: storage no longer has it.
			seen = storage.channels.get(channelId);
			let names = deleted.map(item => item.id === channelId ? "document" : "child");
			steps.push(`told ${names.join(",")} by ${by.login}`);
		};
		let outcome = await new DocumentDeletion(deps).delete(channelId, ANA);
		expect(await seen).toBeUndefined();
		expect(outcome).toMatchObject({ kind: "deleted", by: ANA });
		expect(steps).toEqual(["stop child", "stop document", "told document,child by ana"]);
		expect(await storage.channels.get(channelId)).toBeUndefined();
		expect(await storage.channels.get(childId)).toBeUndefined();
		expect(deleting.size).toBe(0);
	});

	it("tells no one and serves the documents again when the commit fails", async () => {
		let { storage, deps, steps, deleting, held, channelId, childId } = await world();
		// The writer lease was lost while the Planner stopped: storage refuses the delete.
		deps.stop = async id => {
			steps.push(`stop ${id === channelId ? "document" : "child"}`);
			if (id === channelId) await storage.leases.release(held.lease);
		};
		let deletion = new DocumentDeletion(deps);
		let failed = await deletion.delete(channelId, ANA).then(() => undefined, error => error);
		expect(failed).toBeInstanceOf(StorageError);
		expect(steps).toEqual(["stop child", "stop document", "resume 2"]);
		expect(await storage.channels.get(channelId)).toBeDefined();
		expect(await storage.channels.get(childId)).toBeDefined();
		expect(deleting.size).toBe(0);
		expect(deletion.recent(channelId)).toBeUndefined();
	});

	it("refuses while a build holds it, before and after its Planner stops", async () => {
		let { storage, deps, steps, deleting, channelId } = await world();
		let building = true;
		deps.running = async () => building ? "This document is being built." : undefined;
		let deletion = new DocumentDeletion(deps);
		expect(await deletion.delete(channelId, ANA))
			.toEqual({ kind: "running", message: "This document is being built." });
		// Refused before anything was disturbed.
		expect(steps).toEqual([]);

		// A build that started while the Planner was being stopped refuses it too.
		building = false;
		deps.stop = async id => {
			steps.push(`stop ${id === channelId ? "document" : "child"}`);
			building = true;
		};
		expect(await deletion.delete(channelId, ANA))
			.toEqual({ kind: "running", message: "This document is being built." });
		expect(steps).toEqual(["stop child", "stop document", "resume 2"]);
		expect(await storage.channels.get(channelId)).toBeDefined();
		expect(deleting.size).toBe(0);
	});

	it("answers a repeated or concurrent delete as the first, deleting once", async () => {
		let { deps, steps, clock, channelId, childId } = await world();
		let deletion = new DocumentDeletion(deps);
		let [first, second] = await Promise.all([
			deletion.delete(channelId, ANA),
			deletion.delete(channelId, { id: "U_bo", login: "bo" }),
		]);
		expect(first).toMatchObject({ kind: "deleted", by: ANA });
		expect(second).toEqual(first);
		expect(await deletion.delete(channelId, ANA)).toEqual(first);
		expect(steps.filter(step => step.startsWith("told"))).toEqual(["told 2 by ana"]);
		expect(deletion.recent(childId)?.channel).toMatchObject({ id: childId });

		// Remembered for a while, then a delete of it finds nothing.
		clock.now += DELETED_REMEMBERED_MS;
		expect(deletion.recent(channelId)).toBeUndefined();
		expect(await deletion.delete(channelId, ANA)).toEqual({ kind: "missing" });
	});

	it("never deletes a child on its own", async () => {
		let { storage, deps, steps, childId } = await world();
		expect(await new DocumentDeletion(deps).delete(childId, ANA)).toEqual({ kind: "child" });
		expect(steps).toEqual([]);
		expect(await storage.channels.get(childId)).toBeDefined();
	});

	it("lets no edit that lands during or after the delete bring the document back", async () => {
		let { storage, deps, channelId, lease } = await world();
		deps.stop = async id => {
			// An edit admitted before the delete began commits while its Planner stops.
			if (id === channelId) await commit(storage, channelId, lease, "admitted");
		};
		await new DocumentDeletion(deps).delete(channelId, ANA);
		// A reconnecting client's buffered edit, or a Planner tool's, arrives after.
		await expect(commit(storage, channelId, lease, "late")).rejects.toBeInstanceOf(StorageError);
		expect(await storage.channels.get(channelId)).toBeUndefined();
		expect(await storage.collaboration.load(channelId, new Date())).toBeUndefined();
	});

	it("closes an open room, writing the browser edit in flight, before the commit", async () => {
		let { storage, plan, lease, broadcasts } = await openPlan("# Plan\n\nBody.\n");
		let id = plan.id;
		let peer = await Room.restore(
			plan.document.epoch,
			Y.encodeStateAsUpdate(plan.document.doc),
			Service.source(plan),
			[],
		);
		let typed = (text: string) => {
			let vector = Y.encodeStateVector(peer.doc);
			peer.editor.update(() => {
				$getRoot().append($createParagraphNode().append($createTextNode(text)));
			}, { discrete: true });
			return Buffer.from(Y.encodeStateAsUpdate(peer.doc, vector)).toString("base64");
		};
		let replies: Array<{ kind: string }> = [];
		let ws = {
			data: { canEdit: true, room: id, handle: "ana", client: "peer" },
			send: (raw: string) => void replies.push(JSON.parse(raw)),
			publish() {},
			close() {},
		} as unknown as Socket;
		let steps: string[] = [];
		let deletion = new DocumentDeletion({
			storage,
			lease: () => lease,
			deleting: new Set(),
			transition: (_id, action) => action(),
			children: async () => [],
			running: async () => undefined,
			// As main.ts does: the room's plan writes the edits it admitted, and closes.
			stop: async () => {
				await Service.drain(plan);
				await Service.close(plan);
				steps.push("closed");
			},
			resume: async () => {},
			deleted: () => void steps.push(`told after ${broadcasts.length} broadcasts`),
			clock: () => 0,
		});
		await Room.settle();
		Service.submit(plan, ws, {
			kind: "plan:update",
			ts: 0,
			rid: "in-flight",
			id: "in-flight",
			epoch: plan.document.epoch,
			update: typed("Typed as the delete began."),
		});
		let outcome = await deletion.delete(id, ANA);
		expect(outcome.kind).toBe("deleted");
		// The edit in flight was written and acknowledged before the document went.
		expect(replies.some(reply => reply.kind === "plan:ack")).toBe(true);
		expect(steps).toEqual(["closed", `told after ${broadcasts.length} broadcasts`]);
		expect(await storage.channels.get(id)).toBeUndefined();
		expect(await storage.collaboration.load(id, new Date())).toBeUndefined();
		peer.doc.destroy();
	});
});
