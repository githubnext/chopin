import * as Questions from "../questions/service";
import { announceImplementation } from "../tasks/notifications";
import { $createHeadingNode } from "@chopin/dialect";
import * as Y from "yjs";
import { $createTextNode, $getRoot, $isElementNode } from "lexical";
import * as Room from "./room";
import * as Edit from "./edit";
import type { Socket } from "../wire";
import { describe, expect, it } from "bun:test";
import * as Service from "./service";
import { MemoryStorage } from "../storage/memory/adapter";
import { normalizedTitle } from "../channels/title";
import type { Server } from "bun";
import type { SocketData } from "../wire";

async function context(source?: string, active = false) {
	let storage = new MemoryStorage();
	let now = new Date();
	await storage.users.put({ id: "user", login: "user", avatarUrl: "", now });
	let initial = source !== undefined ? await Service.initial(source) : undefined;
	if (active && initial) {
		initial.sidecar = {
			...initial.sidecar as object,
			builds: [{
				id: crypto.randomUUID(),
				user: "user",
				connectionId: "connection",
				repositoryId: "repo",
				checkout: { repository: "owner/repo", commit: "a".repeat(40) },
				planRevision: 0,
				graphVersion: 1,
				graphRevision: 1,
				createdAt: now.toISOString(),
				expiresAt: Date.now() + 60_000,
				state: "running",
			}],
		};
	}
	let channel = await storage.channels.create({
		id: crypto.randomUUID(),
		repositoryId: "repo",
		repositoryOwner: "owner",
		repositoryName: "repo",
		title: "Friendly name",
		createdBy: "user",
		now,
		...(initial ? { initial } : {}),
	});
	let lease = (await storage.leases.acquire("writer", "test", 60_000))!;
	let backend: Service.Backend = {
		documentTitles: true,
		storage,
		lease: () => lease,
		fatal: () => {},
	};
	let server = { publish() {} } as unknown as Server<SocketData>;
	return { storage, channel, backend, server };
}

describe("synchronized product document titles", () => {
	it("commits explicit rename before publishing and keeps the live document unchanged on failure", async () => {
		let c = await context("# Original\n\nBody.\n");
		let events: string[] = [];
		c.server.publish = (_topic, frame) => {
			events.push(JSON.parse(String(frame)).kind);
			return 0;
		};
		c.backend.onChannelRenamed = () => {
			events.push("metadata");
		};
		let plan = await Service.open(c.channel.id, c.backend, c.server);
		events.length = 0;
		await Service.exclusive(plan, () => Service.rename(plan, "Renamed"));
		expect(events).toEqual(["plan:update", "metadata"]);
		expect(Service.source(plan)).toBe("# Renamed\n\nBody.\n");
		let before = await c.storage.channels.get(c.channel.id);
		let originalCommit = c.storage.collaboration.commit;
		c.storage.collaboration.commit = async () => {
			throw new Error("disk failed");
		};
		await expect(Service.exclusive(plan, () => Service.rename(plan, "Rejected"))).rejects.toThrow(
			"disk failed",
		);
		expect(Service.source(plan)).toBe("# Renamed\n\nBody.\n");
		expect(await c.storage.channels.get(c.channel.id)).toEqual(before);
		expect(await c.storage.channels.resolve("repo", "rejected")).toBeUndefined();
		expect(events).toEqual(["plan:update", "metadata"]);
		c.storage.collaboration.commit = originalCommit;
		await Service.close(plan);
	});

	it("repairs a custom wire deletion with a blank title and preserves the following body H1", async () => {
		let body = "Body " + "x".repeat(60);
		let c = await context("# Title\n\n# " + body + "\n");
		let plan = await Service.open(c.channel.id, c.backend, c.server);
		let peer = await Room.restore(
			plan.document.epoch,
			Y.encodeStateAsUpdate(plan.document.doc),
			Service.source(plan),
			[],
		);
		let vector = Y.encodeStateVector(peer.doc);
		peer.editor.update(() => {
			$getRoot().getFirstChild()!.remove();
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
			rid: "delete",
			id: "delete",
			epoch: plan.document.epoch,
			update: Buffer.from(Y.encodeStateAsUpdate(peer.doc, vector)).toString("base64"),
		});
		await Service.drain(plan);
		expect(Service.source(plan)).toBe("#\n\n# " + body + "\n");
		expect((await c.storage.channels.get(plan.id))?.title).toBe("Untitled");
		peer.doc.destroy();
		await Service.close(plan);
	});

	it("adopts a client's replacement blank H1 once when the known title was deleted", async () => {
		let c = await context("# Title\n\n# Body heading\n");
		let plan = await Service.open(c.channel.id, c.backend, c.server);
		let peer = await Room.restore(
			plan.document.epoch,
			Y.encodeStateAsUpdate(plan.document.doc),
			Service.source(plan),
			[],
		);
		let vector = Y.encodeStateVector(peer.doc);
		peer.editor.update(() => {
			let title = $getRoot().getFirstChild()!;
			title.insertBefore($createHeadingNode("h1"));
			title.remove();
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
			rid: "repair",
			id: "repair",
			epoch: plan.document.epoch,
			update: Buffer.from(Y.encodeStateAsUpdate(peer.doc, vector)).toString("base64"),
		});
		await Service.drain(plan);
		expect(Service.source(plan)).toBe("#\n\n# Body heading\n");
		peer.doc.destroy();
		await Service.close(plan);
	});

	it("preserves a typed trailing space and returns a capped correction to the submitting editor", async () => {
		let c = await context("# Title\n");
		let frames: Array<{ kind: string; update?: string }> = [];
		c.server.publish = (_topic, frame) => {
			frames.push(JSON.parse(String(frame)));
			return 0;
		};
		let plan = await Service.open(c.channel.id, c.backend, c.server);
		await Service.exclusive(plan, () => Service.rename(plan, "Staged rename"));
		let peer = await Room.restore(
			plan.document.epoch,
			Y.encodeStateAsUpdate(plan.document.doc),
			Service.source(plan),
			[],
		);
		let ws = {
			data: { canEdit: true, room: plan.id, handle: "user", client: "peer" },
			send() {},
			publish() {},
			close() {},
		} as unknown as Socket;
		for (let [index, text] of ["Title ", "😀".repeat(51)].entries()) {
			frames.length = 0;
			let vector = Y.encodeStateVector(peer.doc);
			peer.editor.update(() => {
				let title = $getRoot().getFirstChild();
				if (!$isElementNode(title)) throw new Error("title missing");
				title.clear().append($createTextNode(text));
			}, { discrete: true });
			await Room.settle();
			Service.submit(plan, ws, {
				kind: "plan:update",
				ts: 0,
				rid: `edit-${index}`,
				id: `edit-${index}`,
				epoch: plan.document.epoch,
				update: Buffer.from(Y.encodeStateAsUpdate(peer.doc, vector)).toString("base64"),
			});
			await Service.drain(plan);
			if (index === 1) {
				let correction = frames.find(frame => frame.kind === "plan:update");
				expect(correction).toBeDefined();
				Y.applyUpdate(peer.doc, Buffer.from(correction!.update!, "base64"));
				await Room.settle();
			}
			let expected = index === 0 ? "Title " : "😀".repeat(50);
			plan.document.editor.getEditorState().read(() =>
				expect($getRoot().getFirstChild()!.getTextContent()).toBe(expected)
			);
			peer.editor.getEditorState().read(() =>
				expect($getRoot().getFirstChild()!.getTextContent()).toBe(expected)
			);
		}
		peer.doc.destroy();
		await Service.close(plan);
	});

	it("defers legacy title adoption while an implementation locks its source", async () => {
		let c = await context("Body.\n", true);
		let plan = await Service.open(c.channel.id, c.backend, c.server);
		expect(Service.implementationActive(plan)).toBe(true);
		expect(Service.source(plan)).toBe("Body.\n");
		expect((await c.storage.channels.get(plan.id))?.revision).toBe(0);
		await expect(Service.rename(plan, "Blocked")).rejects.toThrow("implementation is active");
		let activation: Promise<void> | undefined;
		plan.persistence.liveBuild = false;
		plan.persistence.onEditingUnlocked = () => {
			activation = Service.exclusive(plan, () => Service.activateTitles(plan));
		};
		plan.builds[0]!.state = "stopped";
		announceImplementation(plan);
		expect(activation).toBeDefined();
		await activation;
		expect(Service.source(plan)).toBe("# Friendly name\n\nBody.\n");
		await Service.exclusive(plan, () => Service.rename(plan, "Unlocked"));
		expect((await c.storage.channels.get(plan.id))?.title).toBe("Unlocked");
		let changed = Edit.apply(plan, plan.revision, [{
			op: "replace",
			index: 0,
			source: "# Next title\n",
		}]);
		if (!changed.ok || !changed.mutation) throw new Error("title update failed");
		await Service.publish(plan, c.server, plan.id, changed.mutation);
		expect(Service.source(plan)).toBe("# Next title\n\nBody.\n");
		expect((await c.storage.channels.get(plan.id))?.title).toBe("Next title");
		await Service.close(plan);
	});

	it("returns an invalid rewrite for malformed source while legacy title activation is pending", async () => {
		let c = await context("Body.\n", true);
		let plan = await Service.open(c.channel.id, c.backend, c.server);
		plan.builds[0]!.state = "stopped";
		let outcome = await Service.exclusive(plan, () =>
			Service.rewrite(plan, "<broken", () => {
				throw new Error("invalid source must not produce a receipt");
			}));
		expect(outcome).toMatchObject({ ok: false, reason: "invalid" });
		expect(Service.source(plan)).toBe("Body.\n");
		await Service.close(plan);
	});

	it("keeps the title first through structural replace, insertion and deletion beside a body H1", async () => {
		let c = await context("# Title\n\n# Body heading\n\nBody.\n");
		let plan = await Service.open(c.channel.id, c.backend, c.server);
		for (
			let operation of [
				{ op: "replace" as const, index: 0, source: "# Renamed\n" },
				{ op: "delete" as const, index: 0 },
				{ op: "insert" as const, index: 0, source: "Inserted.\n" },
			]
		) {
			let outcome = Edit.apply(plan, plan.revision, [operation]);
			if (!outcome.ok || !outcome.mutation) throw new Error("structural edit failed");
			await Service.publish(plan, c.server, plan.id, outcome.mutation);
			let expected = operation.op === "replace"
				? "# Renamed\n\n# Body heading\n\nBody.\n"
				: operation.op === "insert"
				? "#\n\nInserted.\n\n# Body heading\n\nBody.\n"
				: "#\n\n# Body heading\n\nBody.\n";
			expect(Service.source(plan)).toBe(expected);
			expect((await c.storage.channels.get(plan.id))?.title).toBe(
				operation.op === "replace" ? "Renamed" : "Untitled",
			);
		}
		await Service.close(plan);
	});

	it("bounds structural writes and preserves blank title source across reload", async () => {
		let c = await context("# Title\n\nBody.\n");
		let plan = await Service.open(c.channel.id, c.backend, c.server);
		let outcome = Edit.replace(plan, plan.revision, "# " + "😀".repeat(51) + "\n\nBody.\n");
		if (!outcome.ok || !outcome.mutation) throw new Error("edit failed");
		await Service.publish(plan, c.server, plan.id, outcome.mutation);
		expect((await c.storage.channels.get(plan.id))?.title).toBe("😀".repeat(50));
		await Service.exclusive(plan, () => Service.rename(plan, ""));
		expect(Service.source(plan)).toBe("#\n\nBody.\n");
		await Service.close(plan);
		let restored = await Service.open(c.channel.id, c.backend, c.server);
		expect(Service.source(restored)).toBe("#\n\nBody.\n");
		expect((await c.storage.channels.get(plan.id))?.title).toBe("Untitled");
		await Service.close(restored);
	});

	it("initializes a missing title without consuming existing body blocks", async () => {
		let c = await context("Body.\n\n## Ordinary heading\n");
		let plan = await Service.open(c.channel.id, c.backend, c.server);
		expect(Service.source(plan)).toBe("# Friendly name\n\nBody.\n\n## Ordinary heading\n");
		await Service.close(plan);
	});

	it("adopts the plain leading H1 and commits its title and slug before opening", async () => {
		let c = await context("# **Release** [notes](https://example.com)\n\nBody.\n");
		let plan = await Service.open(c.channel.id, c.backend, c.server);
		expect(Service.source(plan)).toBe("# Release notes\n\nBody.\n");
		expect(await c.storage.channels.get(c.channel.id)).toMatchObject({
			title: "Release notes",
			slug: "release-notes",
		});
		expect((await c.storage.channels.resolve("repo", "friendly-name"))?.id).toBe(c.channel.id);
		await Service.close(plan);
		let restored = await Service.open(c.channel.id, c.backend, c.server);
		expect(Service.source(restored)).toBe("# Release notes\n\nBody.\n");
		await Service.close(restored);
	});

	it("uses one 50-code-point bound for explicit names", () => {
		expect(normalizedTitle("😀".repeat(51))).toBe("😀".repeat(50));
		expect(normalizedTitle(" ")).toBe("");
	});
});

for (let source of ["# Named title\n", "#\n"]) {
	it(`a titled-only product document admits unanchored questions: ${JSON.stringify(source)}`, async () => {
		let c = await context(source);
		let plan = await Service.open(c.channel.id, c.backend, c.server);
		let definition = Questions.identify({
			questions: [{
				header: "Release",
				question: "Should we ship?",
				multiple: false,
				options: [{ label: "Pilot", description: "" }],
			}],
		});
		let created = Promise.withResolvers<void>();
		let stop = new AbortController();
		let waiting = Questions.ask(
			plan,
			c.server,
			plan.id,
			definition,
			{
				revision: plan.revision,
				blocks: [[]],
			},
			created.resolve,
			stop.signal,
		);
		try {
			await Promise.race([created.promise, waiting]);
			expect(plan.records.size).toBe(1);
			expect(Room.hasProse(plan.document)).toBe(false);
			expect(Room.headingAllowed(plan.document)).toBe(true);
		} finally {
			stop.abort();
			await waiting.catch(() => {});
			await Service.close(plan);
		}
	});
}

for (let body of ["# Body section\n", "#\n"]) {
	it(`ordinary body H1 prose still requires question anchors in title mode: ${JSON.stringify(body)}`, async () => {
		let c = await context(`# Title\n\n${body}`);
		let plan = await Service.open(c.channel.id, c.backend, c.server);
		let definition = Questions.identify({
			questions: [{
				header: "Release",
				question: "Should we ship?",
				multiple: false,
				options: [{ label: "Pilot", description: "" }],
			}],
		});
		try {
			expect(Room.hasProse(plan.document)).toBe(true);
			expect(Room.headingAllowed(plan.document)).toBe(false);
			await expect(Questions.ask(plan, c.server, plan.id, definition, {
				revision: plan.revision,
				blocks: [[]],
			})).rejects.toThrow("Relate each question to prose");
			let standalone = await Room.create("# Ordinary heading\n");
			expect(Room.hasProse(standalone)).toBe(true);
			expect(Room.headingAllowed(standalone)).toBe(false);
			standalone.doc.destroy();
		} finally {
			await Service.close(plan);
		}
	});
}
