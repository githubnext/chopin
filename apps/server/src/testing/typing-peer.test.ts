import { describe, expect, it } from "bun:test";

import * as room from "../plan/room";
import { typingPeer, Y } from "./typing-peer";

describe("a typing peer", () => {
	it("types into the paragraph that starts with its marker, and the server holds each word once, in order", async () => {
		let server = await room.create("# Load\n\ned0\n\ned1\n");
		let peers = [typingPeer(), typingPeer()];
		for (let client of peers) await client.receive(room.sync(server));
		let sent: Uint8Array[][] = [[], []];
		peers.forEach((client, index) => client.onLocal(update => sent[index]!.push(update)));

		for (let word = 0; word < 5; word++) {
			peers[0]!.type("ed0", `a${word}`);
			peers[1]!.type("ed1", `b${word}`);
		}
		expect(peers[0]!.text("ed0")).toBe("ed0 a0 a1 a2 a3 a4");
		expect(sent[0]!.length).toBe(5);

		await room.apply(server, [...sent[0]!, ...sent[1]!]);
		await room.settle();
		expect(room.project(server)).toBe("# Load\n\ned0 a0 a1 a2 a3 a4\n\ned1 b0 b1 b2 b3 b4\n");

		// What the server sent is not the peer's own to send back, and a repeat changes nothing.
		await room.apply(server, [...sent[0]!]);
		await peers[0]!.receive(Y.encodeStateAsUpdate(server.doc));
		expect(sent[0]!.length).toBe(5);
		expect(peers[0]!.text("ed1")).toBe("ed1 b0 b1 b2 b3 b4");
		for (let client of peers) client.destroy();
		server.doc.destroy();
	});

	it("says which paragraph is missing instead of typing somewhere else", async () => {
		let server = await room.create("# Load\n");
		let client = typingPeer();
		await client.receive(room.sync(server));
		expect(() => client.type("ed9", "a0")).toThrow("no paragraph starts with ed9");
		expect(client.text("ed9")).toBeUndefined();
		client.destroy();
		server.doc.destroy();
	});
});
