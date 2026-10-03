import * as Chat from "./service";
import * as Service from "../plan/service";
import { MemoryStorage } from "../storage/memory/adapter";
import type { Server } from "bun";
import type { SocketData } from "../wire";

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
	let order: string[] = [];
	let frames: Array<{ kind: string; entry?: { text: string; decision?: unknown } }> = [];
	let server = {
		publish(_topic: string, data: string) {
			let frame = JSON.parse(data) as { kind: string; entry?: { text: string } };
			frames.push(frame);
			if (frame.kind === "chat:message") order.push(`broadcast:${frame.entry?.text}`);
		},
	} as unknown as Server<SocketData>;
	let backend: Service.Backend = {
		storage,
		lease: () => lease,
		fatal: () => {},
	};
	let plan = await Service.open(channel.id, backend, server);
	let announcer: Chat.Announcer = { chat: plan.chat, plan, server, room: channel.id };
	return { storage, channel, lease, server, plan, announcer, order, frames, now };
}
