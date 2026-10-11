import { afterAll, expect, it } from "bun:test";

import { harnessContract } from "./contract";
import { createRemoteAdapter } from "./remote/adapter";
import { attach, linkAuth, linkServer, nodeClient, scriptedPlanner } from "../testing/planner-link";

let { auth, channel } = await linkAuth();
let server = linkServer(auth);
let client = await attach(server.url, channel.id, scriptedPlanner().handlers);
afterAll(async () => {
	await client.detach();
	server.stop();
});

harnessContract("remote", () =>
	createRemoteAdapter(() => ({
		link: server.links.at(-1)!,
		planner: { channelId: channel.id, isolated: false },
	})));

let nodeLink = await linkAuth();
let nodeServer = linkServer(nodeLink.auth);
let node = await nodeClient(nodeServer.url, nodeLink.channel.id);
afterAll(async () => {
	await node?.stop();
	nodeServer.stop();
});

if (node) {
	it("attaches a Node.js client that uses only the documented wire format", () => {
		expect(node.attached).toBe(nodeLink.channel.id);
		expect(nodeServer.links).toHaveLength(1);
	});
	harnessContract(`remote over Node.js ${node.node}`, () =>
		createRemoteAdapter(() => ({
			link: nodeServer.links.at(-1)!,
			planner: { channelId: nodeLink.channel.id, isolated: false },
		})));
}
