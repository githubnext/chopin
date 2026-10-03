import { MemoryStorage } from "../storage/memory/adapter";
import type { Server } from "bun";
import type { SocketData } from "../wire";
import * as Service from "./service";

export async function hosted() {
	let now = new Date("2026-08-13T12:00:00.000Z");
	let storage = new MemoryStorage();
	await storage.users.put({ id: "U_octocat", login: "octocat", avatarUrl: "", now });
	let channel = await storage.channels.create({
		id: crypto.randomUUID(),
		repositoryId: "R_score",
		repositoryOwner: "octo-org",
		repositoryName: "score",
		title: "Release",
		createdBy: "U_octocat",
		now,
	});
	let lease = await storage.leases.acquire("writer", "test", 60_000);
	if (!lease) throw new Error("could not acquire test lease");
	let frames: Array<Record<string, unknown>> = [];
	let server = {
		publish(_topic: string, value: string) {
			frames.push(JSON.parse(value) as Record<string, unknown>);
		},
	} as unknown as Server<SocketData>;
	let backend: Service.Backend = {
		storage,
		lease: () => lease,
		fatal: err => {
			throw err;
		},
	};
	return { storage, channel, lease, frames, server, backend, now };
}
