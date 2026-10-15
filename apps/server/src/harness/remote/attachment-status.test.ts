import { afterEach, describe, expect, it } from "bun:test";
import { AGENT_VERSION } from "@chopin/agent-link";

import { attach, linkAuth, linkServer, rawLink, scriptedPlanner } from "../../testing/agent-link";

import type { PlannerAttachment } from "./attachments";

let cleanups: Array<() => unknown> = [];
afterEach(async () => {
	for (let cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

/** A link server whose every attachment change is recorded, as `main.ts` broadcasts them. */
async function observed(graceMs = 2_000, revalidateEveryMs?: number) {
	let linked = await linkAuth();
	let server = linkServer(linked.auth, 2_000, revalidateEveryMs, graceMs);
	cleanups.push(server.stop);
	linked.revocations.add(id => server.attachments.sessionRevoked(id));
	let changes: Array<{ channelId: string; planner: PlannerAttachment }> = [];
	cleanups.push(
		server.attachments.onChange((channelId, planner) => changes.push({ channelId, planner })),
	);
	return { ...linked, server, changes };
}

async function until(condition: () => boolean, timeoutMs = 3_000): Promise<void> {
	for (let deadline = Date.now() + timeoutMs; Date.now() < deadline;) {
		if (condition()) return;
		await Bun.sleep(10);
	}
	throw new Error("condition never held");
}

async function attachedRaw(url: string, channelId: string) {
	let raw = await rawLink(url);
	raw.send({ type: "attach", version: AGENT_VERSION, document: channelId });
	await raw.next("attached");
	return raw;
}

describe("Planner attachment status", () => {
	it("says no Planner is attached to a document nobody attached", async () => {
		let { server, channel, changes } = await observed();
		expect(server.attachments.status(channel.id)).toEqual({ state: "none" });
		expect(changes).toEqual([]);
	});

	it("reports an attach, a detach into its grace period, and the grace expiring, as each happens", async () => {
		let { server, channel, changes } = await observed(300);
		let client = await attach(server.url, channel.id, scriptedPlanner().handlers);
		expect(server.attachments.status(channel.id)).toEqual({ state: "attached", login: "member" });
		expect(changes).toEqual([
			{ channelId: channel.id, planner: { state: "attached", login: "member" } },
		]);

		let detachedAt = Date.now();
		await client.detach();
		await until(() => changes.length === 2);
		let held = server.attachments.status(channel.id);
		expect(held).toMatchObject({ state: "held", login: "member" });
		let releaseAt = Date.parse((held as { until: string }).until);
		expect(releaseAt).toBeGreaterThanOrEqual(detachedAt + 300 - 50);
		expect(releaseAt).toBeLessThanOrEqual(Date.now() + 300 + 50);
		expect(changes[1]).toEqual({ channelId: channel.id, planner: held });

		await until(() => changes.length === 3);
		expect(changes[2]).toEqual({ channelId: channel.id, planner: { state: "none" } });
		expect(server.attachments.status(channel.id)).toEqual({ state: "none" });
	});

	it("reports a reattach within the grace period as attached again", async () => {
		let { server, channel, changes } = await observed();
		let first = await attach(server.url, channel.id, scriptedPlanner().handlers);
		await first.detach();
		await until(() => changes.length === 2);
		let second = await attach(server.url, channel.id, scriptedPlanner().handlers);
		cleanups.push(() => second.detach());
		expect(changes.map(change => change.planner.state)).toEqual(["attached", "held", "attached"]);
		expect(server.attachments.status(channel.id)).toEqual({ state: "attached", login: "member" });
	});

	it("reports the Planner released at once when its owner's browser sign-in ends", async () => {
		let { server, channel, changes, signOut } = await observed();
		let raw = await attachedRaw(server.url, channel.id);
		await signOut("member");
		await raw.closed;
		await Bun.sleep(50);
		expect(changes.map(change => change.planner)).toEqual([
			{ state: "attached", login: "member" },
			{ state: "none" },
		]);
		expect(server.attachments.status(channel.id)).toEqual({ state: "none" });
	});

	it("reports the Planner released at once when a repository writer resets it", async () => {
		let { server, channel, changes, storage } = await observed();
		let raw = await attachedRaw(server.url, channel.id);
		let held = (await storage.channels.readAgent(channel.id, new Date()))!.agent!;
		await storage.channels.clearAgentOwner(
			channel.id,
			held.ownerSessionId!,
			held.generation,
			new Date(),
		);
		server.attachments.ownerReset(channel.id);
		await raw.closed;
		await Bun.sleep(50);
		expect(changes.map(change => change.planner)).toEqual([
			{ state: "attached", login: "member" },
			{ state: "none" },
		]);
	});

	it("reports the Planner released when the server closes a link whose ownership ended elsewhere", async () => {
		let { server, channel, changes, storage } = await observed(2_000, 20);
		let raw = await attachedRaw(server.url, channel.id);
		let held = (await storage.channels.readAgent(channel.id, new Date()))!.agent!;
		await storage.channels.clearAgentOwner(
			channel.id,
			held.ownerSessionId!,
			held.generation,
			new Date(),
		);
		await raw.closed;
		await Bun.sleep(50);
		expect(changes.map(change => change.planner)).toEqual([
			{ state: "attached", login: "member" },
			{ state: "none" },
		]);
		expect(server.attachments.status(channel.id)).toEqual({ state: "none" });
	});

	it("names only the holder's login, never the link's machine or checkout", async () => {
		let { server, channel, changes } = await observed();
		let raw = await rawLink(server.url);
		raw.send({
			type: "attach",
			version: AGENT_VERSION,
			document: channel.id,
			checkout: { origin: "git@github.com:octo-org/score.git", branch: "laptop-7", head: "abc123" },
		});
		await raw.next("attached");
		expect(JSON.stringify(changes)).not.toMatch(/laptop-7|abc123|octo-org/);
		expect(Object.keys(server.attachments.status(channel.id)).sort()).toEqual(["login", "state"]);
	});

	it("stops reporting to a listener that unsubscribed", async () => {
		let { server, channel } = await observed();
		let seen: PlannerAttachment[] = [];
		let off = server.attachments.onChange((_channelId, planner) => seen.push(planner));
		off();
		let client = await attach(server.url, channel.id, scriptedPlanner().handlers);
		cleanups.push(() => client.detach());
		expect(seen).toEqual([]);
	});
});
