import { describe, expect, it } from "bun:test";
import { $createTextNode, $getRoot, $isElementNode } from "lexical";
import * as Y from "yjs";
import * as Room from "./room";
import * as Service from "./service";
import { MemoryStorage } from "../storage/memory/adapter";
import type { Server } from "bun";
import type { Socket, SocketData } from "../wire";

const RESEARCH = "01K0N4W3B7P27CBAEC7A8C8WEH";
const INVESTIGATION = "6f1c3c2e-8b0a-4c43-9d55-2d6f3c1b9a10";
const DECISION = "aaa82fce-993c-4c1d-a1e1-c0d08697c8da";

async function fixture() {
	let storage = new MemoryStorage();
	let now = new Date();
	await storage.users.put({ id: "user", login: "user", avatarUrl: "", now });
	let channel = await storage.channels.create({
		id: crypto.randomUUID(),
		repositoryId: "repo",
		repositoryOwner: "owner",
		repositoryName: "repo",
		title: "Title",
		createdBy: "user",
		now,
		initial: await Service.initial("# Title\n\nBody.\n", undefined, "Title"),
	});
	let lease = (await storage.leases.acquire("writer", "staging", 60_000))!;
	let frames: Array<{ kind: string; update?: string }> = [];
	let server = {
		publish(_topic: string, raw: unknown) {
			frames.push(JSON.parse(String(raw)));
		},
	} as unknown as Server<SocketData>;
	let plan = await Service.open(channel.id, {
		documentTitles: true,
		storage,
		lease: () => lease,
		fatal: () => {},
	}, server);
	let peer = await Room.restore(
		plan.document.epoch,
		Y.encodeStateAsUpdate(plan.document.doc),
		Service.source(plan),
		[],
	);
	let vector = Y.encodeStateVector(peer.doc);
	peer.editor.update(() => {
		let title = $getRoot().getFirstChild();
		if (!$isElementNode(title)) throw new Error("title missing");
		title.clear().append($createTextNode("Title "));
	}, { discrete: true });
	await Room.settle();
	let ws = {
		data: { canEdit: true, room: plan.id, handle: "user", client: "peer" },
		send() {},
		publish() {},
		close() {},
	} as unknown as Socket;
	Service.submit(plan, ws, {
		kind: "plan:update",
		ts: 0,
		rid: "typing",
		id: "typing",
		epoch: plan.document.epoch,
		update: Buffer.from(Y.encodeStateAsUpdate(peer.doc, vector)).toString("base64"),
	});
	await Service.drain(plan);
	frames.length = 0;
	return { storage, plan, peer, frames, now };
}

describe("product title staging deltas", () => {
	for (let kind of ["research", "investigation", "experiment", "rename", "rewrite"] as const) {
		it(`keeps live, peer and durable state together after a trailing space then ${kind}`, async () => {
			let c = await fixture();
			try {
				let expected = "# Title&#x20;\n\nBody.\n";
				let title = "Title ";
				if (kind === "research") {
					await Service.placeResearchReference(c.plan, RESEARCH);
					expected += `\n<Research id="${RESEARCH}" />\n`;
				} else if (kind === "investigation") {
					await Service.placeInvestigationReference(c.plan, INVESTIGATION);
					expected += `\n<Investigation id="${INVESTIGATION}" />\n`;
				} else if (kind === "experiment") {
					await Service.placeExperimentReference(c.plan, INVESTIGATION, "comparison", DECISION);
				} else if (kind === "rename") {
					await Service.exclusive(c.plan, () => Service.rename(c.plan, "Renamed"));
					expected = "# Renamed\n\nBody.\n";
					title = "Renamed";
				} else {
					let outcome = await Service.exclusive(
						c.plan,
						() =>
							Service.rewrite(c.plan, "# Title\n\nUpdated body.\n", (source, revision) => ({
								idempotencyKey: "rewrite",
								fingerprint: "rewrite",
								fromRevision: c.plan.revision,
								client: { name: "test", version: "1" },
								document: { source, revision, title: "Title", url: "/documents/owner/repo/title" },
							})),
					);
					expect(outcome.ok).toBe(true);
					expected = "# Title\n\nUpdated body.\n";
					title = "Title";
				}
				for (let frame of c.frames) {
					if (frame.kind === "plan:update") {
						Y.applyUpdate(c.peer.doc, Buffer.from(frame.update!, "base64"));
					}
				}
				await Room.settle();
				let source = Service.source(c.plan);
				if (kind === "experiment") {
					expect(source).toStartWith(expected);
					expect(source).toContain(`experiment="${INVESTIGATION}"`);
					expect(source).toContain('view="comparison"');
					expect(source).toContain(`decision="${DECISION}"`);
				} else expect(source).toBe(expected);
				expect(Room.project(c.peer)).toBe(source);
				expect(c.plan.persistence.committedSource).toBe(source);
				let stored = (await c.storage.collaboration.load(c.plan.id, c.now))!;
				let restored = await Room.restore(
					stored.snapshot!.epoch,
					stored.snapshot!.document,
					stored.snapshot!.source,
					stored.updates.map(update => ({ epoch: update.epoch, update: update.update })),
				);
				try {
					expect(Room.project(restored)).toBe(source);
					for (let doc of [c.plan.document, c.peer, restored]) {
						doc.editor.getEditorState().read(() =>
							expect($getRoot().getFirstChild()!.getTextContent()).toBe(title)
						);
					}
				} finally {
					restored.doc.destroy();
				}
			} finally {
				c.peer.doc.destroy();
				await Service.close(c.plan);
			}
		});
	}
});
