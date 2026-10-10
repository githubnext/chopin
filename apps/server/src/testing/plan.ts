import { createHash } from "node:crypto";
import { $isParagraphNode, $nodesOfType } from "lexical";
import * as Y from "yjs";
import { CalloutNode, ulid } from "@chopin/dialect";
import * as Question from "@chopin/question";

import * as Room from "../plan/room";
import * as Service from "../plan/service";
import { MemoryStorage } from "../storage/memory/adapter";

import type { Server } from "bun";
import type { Definition } from "@chopin/question";
import type { JsonValue } from "../storage/model";
import type { SocketData } from "../wire";

export type SeedState = {
	graph?: import("../tasks/graphs").Graph;
	revision?: number;
	questions?: unknown[];
	openQuestions?: unknown[];
	threads?: unknown[];
	transcript?: unknown[];
	parent?: string;
};

export function storedQuestion(definition: Definition): number[] {
	return [...Question.create(definition).toBinary()];
}

export async function storedDocument(source: string) {
	let document = await Room.create(source);
	try {
		return {
			epoch: document.epoch,
			source: Room.project(document),
			update: Y.encodeStateAsUpdate(document.doc),
		};
	} finally {
		document.doc.destroy();
	}
}

/** Reproduce the direct-text shape written by the original callout client. */
export async function storedLegacyCallout(source: string) {
	let document = await Room.create(source);
	try {
		document.editor.update(
			() => {
				for (let callout of $nodesOfType(CalloutNode)) {
					for (let child of callout.getChildren()) {
						if (!$isParagraphNode(child)) continue;
						for (let inline of child.getChildren()) child.insertBefore(inline);
						child.remove();
					}
				}
			},
			{ discrete: true },
		);
		await Room.settle();
		return {
			epoch: document.epoch,
			source: Room.project(document),
			update: Y.encodeStateAsUpdate(document.doc),
		};
	} finally {
		document.doc.destroy();
	}
}

/**
 * A document with one comment accepted under the earlier lifecycle.
 *
 * Nothing creates accepted threads any more, but storage still holds them, so
 * the `<Decision>` projection and its sidecar record are seeded together. The
 * passage's positions belong to a document the seeded one is not, as after a
 * restart, so the server recovers it from the quote.
 */
export async function storedAcceptedComment(
	source: string,
	quote: string,
	note: { by: string; text: string },
	block = 0,
) {
	let document = await Room.create(source);
	try {
		let passage = Room.passageAt(document, [block], quote, 0, quote.length);
		let id = ulid();
		let at = new Date("2026-08-13T12:00:00.000Z");
		Room.insertDecision(document, {
			id,
			quote,
			by: note.by,
			at: at.toISOString(),
			notes: [note],
		});
		await Room.settle();
		return {
			id,
			source: Room.project(document),
			thread: {
				id,
				status: "accepted",
				passage,
				notes: [{ id: ulid(), handle: note.by, text: note.text, ts: at.getTime() / 1_000 }],
				quote,
				resolver: note.by,
				at: at.getTime() / 1_000,
			},
		};
	} finally {
		document.doc.destroy();
	}
}

/**
 * A resolved comment whose Planner turn wrote the blocks at `result`, as stored.
 *
 * The notes alternate between the member and Chopin, starting with the member.
 */
export async function storedResolvedComment(
	source: string,
	quote: string,
	{ block = 0, notes, resolver, result }: {
		block?: number;
		notes: string[];
		resolver: string;
		result: number[];
	},
) {
	let document = await Room.create(source);
	try {
		let passage = Room.passageAt(document, [block], quote, 0, quote.length);
		let hashes = Room.digests(document);
		let at = new Date("2026-08-13T12:00:00.000Z").getTime() / 1_000;
		let id = ulid();
		return {
			id,
			thread: {
				id,
				status: "resolved",
				passage,
				// A leading "@chopin " addresses the Planner the way the wire does: through `to`.
				notes: notes.map((text, index) => {
					let ts = at + index * 60;
					if (index % 2 === 1) return { id: ulid(), author: "planner", text, ts };
					let addressed = text.startsWith("@chopin ");
					return {
						id: ulid(),
						author: "member",
						handle: resolver,
						text: addressed ? text.slice("@chopin ".length) : text,
						ts,
						...(addressed ? { to: "planner" } : {}),
					};
				}),
				quote,
				resolver,
				at: at + notes.length * 60,
				result: {
					anchors: result.map(index => Room.anchorAt(document, index, hashes[index]!)),
					pending: false,
				},
			},
		};
	} finally {
		document.doc.destroy();
	}
}

async function checkpoint(
	storage: MemoryStorage,
	lease: NonNullable<Awaited<ReturnType<MemoryStorage["leases"]["acquire"]>>>,
	channelId: string,
	now: Date,
	source: string,
	state: SeedState,
) {
	let sidecar = {
		version: 1,
		revision: state.revision ?? 0,
		documentSeq: 0,
		questions: state.questions ?? [],
		openQuestions: state.openQuestions ?? [],
		threads: state.threads ?? [],
		transcript: state.transcript ?? [],
		...(state.graph ? { graph: state.graph } : {}),
	} as JsonValue;
	let document = await Room.create(source);
	let canonical = Room.project(document);
	await storage.collaboration.checkpoint({
		channelId,
		lease,
		expectedRevision: 0,
		generation: crypto.randomUUID(),
		revision: 0,
		throughSequence: 0,
		epoch: document.epoch,
		source: canonical,
		sourceHash: `sha256:${createHash("sha256").update(canonical).digest("hex")}`,
		document: Y.encodeStateAsUpdate(document.doc),
		sidecar,
		createdAt: now,
	});
	document.doc.destroy();
}

/** Open another document in the same repository and storage as `context`. */
export async function openSiblingPlan(
	context: Awaited<ReturnType<typeof openPlan>>,
	source = "",
	state: SeedState = {},
) {
	let channel = await context.storage.channels.create({
		repositoryId: "R_test",
		repositoryOwner: "owner",
		repositoryName: "repository",
		createdBy: "U_test",
		now: context.now,
		id: crypto.randomUUID(),
		title: `Sibling ${crypto.randomUUID()}`,
	});
	await checkpoint(context.storage, context.lease, channel.id, context.now, source, state);
	return Service.open(channel.id, context.backend, context.server);
}

export async function openPlan(source = "", state: SeedState = {}) {
	let now = new Date("2026-08-13T12:00:00.000Z");
	let storage = new MemoryStorage();
	await storage.users.put({ id: "U_test", login: "test", avatarUrl: "", now });
	let fields = {
		repositoryId: "R_test",
		repositoryOwner: "owner",
		repositoryName: "repository",
		createdBy: "U_test",
		now,
	};
	let parentChannelId = state.parent === undefined
		? undefined
		: (await storage.channels.create({ ...fields, id: crypto.randomUUID(), title: state.parent }))
			.id;
	let channel = await storage.channels.create({
		...fields,
		id: crypto.randomUUID(),
		title: "Test plan",
		...(parentChannelId ? { parentChannelId } : {}),
	});
	let lease = await storage.leases.acquire("writer", crypto.randomUUID(), 60_000);
	if (!lease) throw new Error("could not acquire test lease");
	await checkpoint(storage, lease, channel.id, now, source, state);
	let broadcasts: Array<Record<string, unknown>> = [];
	let broken: string | undefined;
	let server = {
		publish(_topic: string, data: string) {
			let frame = JSON.parse(data) as Record<string, unknown>;
			if (frame.kind === broken) throw new Error("nobody is listening");
			broadcasts.push(frame);
		},
	} as unknown as Server<SocketData>;
	let backend: Service.Backend = {
		storage,
		lease: () => lease,
		fatal: err => {
			throw err;
		},
	};
	let plan = await Service.open(channel.id, backend, server);
	return {
		backend,
		broadcasts,
		channel,
		lease,
		now,
		plan,
		server,
		storage,
		breakRelay(kind: string) {
			broken = kind;
		},
	};
}
