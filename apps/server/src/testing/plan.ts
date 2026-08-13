import { createHash } from "node:crypto";
import * as Y from "yjs";

import * as Room from "../plan/room";
import * as Service from "../plan/service";
import { MemoryStorage } from "../storage/memory/adapter";

import type { Server } from "bun";
import type { JsonValue } from "../storage/model";
import type { SocketData } from "../wire";

export type SeedState = {
	revision?: number;
	questions?: unknown[];
	openQuestions?: unknown[];
	threads?: unknown[];
	transcript?: unknown[];
};

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

export async function openPlan(source = "", state: SeedState = {}) {
	let now = new Date("2026-08-13T12:00:00.000Z");
	let storage = new MemoryStorage();
	await storage.users.put({ id: "U_test", login: "test", avatarUrl: "", now });
	let channel = await storage.channels.create({
		id: crypto.randomUUID(),
		repositoryId: "R_test",
		repositoryOwner: "owner",
		repositoryName: "repository",
		title: "Test plan",
		createdBy: "U_test",
		now,
	});
	let lease = await storage.leases.acquire("writer", crypto.randomUUID(), 60_000);
	if (!lease) throw new Error("could not acquire test lease");
	let sidecar = {
		version: 1,
		revision: state.revision ?? 0,
		documentSeq: 0,
		questions: state.questions ?? [],
		openQuestions: state.openQuestions ?? [],
		threads: state.threads ?? [],
		transcript: state.transcript ?? [],
	} as JsonValue;
	let document = await Room.create(source);
	let canonical = Room.project(document);
	await storage.collaboration.checkpoint({
		channelId: channel.id,
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
