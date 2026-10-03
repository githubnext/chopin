/** Read accepted research-offer links over an admitted, read-only socket. */

import { authenticate, expect, test } from "./room";
import { createChannel } from "./database";
import {
	offerSources,
	saveConversationState,
	seedRequest,
	transportState,
} from "./research-offer-fixtures";

import type { OfferSpec } from "./research-offer-fixtures";

import type { Page } from "@playwright/test";

type WireFrame = { kind: string; rid?: string; [key: string]: unknown };
type Wire = { socket: WebSocket };

function port(baseURL: string): number {
	return Number(new URL(baseURL).port);
}
async function connectReader(page: Page, channelId: string): Promise<void> {
	await page.evaluate(async id => {
		let target = window as typeof window & { __researchLinkWire?: Wire };
		target.__researchLinkWire?.socket.close();
		let url = new URL("/ws", location.href);
		url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
		url.searchParams.set("channel", id);
		let socket = new WebSocket(url);
		target.__researchLinkWire = { socket };
		await new Promise<void>((resolve, reject) => {
			socket.addEventListener("open", () => resolve(), { once: true });
			socket.addEventListener("error", () => reject(new Error("reader socket failed")), {
				once: true,
			});
		});
	}, channelId);
	let opened = await wireRequest(page, { kind: "plan:open" });
	expect(opened.kind).toBe("plan:open");
}

async function wireRequest(page: Page, frame: WireFrame): Promise<WireFrame> {
	return page.evaluate(async input => {
		let socket = (window as typeof window & { __researchLinkWire?: Wire })
			.__researchLinkWire?.socket;
		if (!socket || socket.readyState !== WebSocket.OPEN) {
			throw new Error("research link test socket is not open");
		}
		let rid = crypto.randomUUID();
		return await new Promise<WireFrame>((resolve, reject) => {
			let timeout = setTimeout(() => {
				socket.removeEventListener("message", onMessage);
				reject(new Error(`no reply for ${input.kind}`));
			}, 10_000);
			let onMessage = (event: MessageEvent) => {
				if (typeof event.data !== "string") return;
				let reply = JSON.parse(event.data) as WireFrame;
				if (reply.rid !== rid) return;
				clearTimeout(timeout);
				socket.removeEventListener("message", onMessage);
				resolve(reply);
			};
			socket.addEventListener("message", onMessage);
			socket.send(JSON.stringify({ ...input, rid, ts: 0 }));
		});
	}, frame);
}

async function seededReader(page: Page, handle: string, baseURL: string, channelId: string) {
	await authenticate(page, handle, baseURL);
	let session = await page.goto(`${baseURL}/api/session`);
	expect(session?.status()).toBe(200);
	await connectReader(page, channelId);
}

test("accepted research-link reads are channel-scoped and read-only for a pull viewer", async ({ baseURL, page, room, seed }) => {
	let origin = baseURL!;
	let databasePort = port(origin);
	let foreignChannel = crypto.randomUUID();
	await createChannel(databasePort, foreignChannel);
	let specs: OfferSpec[] = [
		{ id: "offer-pending", brief: "Compare synthetic backup targets.", status: "accepted" },
		{
			id: "offer-unlinked",
			brief: "Review synthetic queue storage.",
			status: "accepted",
			workspace: "unlinked",
		},
		{
			id: "offer-linked",
			brief: "Review synthetic notification services.",
			status: "accepted",
			workspace: "linked",
		},
		{
			id: "offer-offered",
			brief: "This offer has not been accepted.",
			status: "offered",
		},
		{
			id: "offer-foreign",
			brief: "This request exists only in another channel.",
			status: "accepted",
		},
	];
	let { state, transcript } = offerSources(specs, "readonly");
	await authenticate(page, "readonly", origin);
	await seed("# Research link fixture\n", { transcript });
	await saveConversationState(room, state);
	let seededIds = new Map<string, string>();
	for (let spec of specs) {
		if (spec.workspace) {
			seededIds.set(spec.id, await seedRequest(room, spec, spec.workspace));
		}
	}
	let foreignId = await seedRequest(
		foreignChannel,
		specs.find(spec => spec.id === "offer-foreign")!,
		"unlinked",
	);
	let session = await page.goto(`${origin}/api/session`);
	expect(session?.status()).toBe(200);
	await connectReader(page, room);
	let before = await transportState([room, foreignChannel]);

	let pending = await wireRequest(page, {
		kind: "conversation-plan:research-link",
		offerId: "offer-pending",
	});
	expect(pending).toMatchObject({
		kind: "conversation-plan:research-link",
		offerId: "offer-pending",
		status: "pending",
	});
	expect(pending.researchRequestId).toBeUndefined();

	for (let [offerId, status] of [["offer-unlinked", "unlinked"], ["offer-linked", "linked"]]) {
		let reply = await wireRequest(page, {
			kind: "conversation-plan:research-link",
			offerId,
		});
		expect(reply).toMatchObject({
			kind: "conversation-plan:research-link",
			offerId,
			status,
			researchRequestId: seededIds.get(offerId),
		});
	}

	let foreign = await wireRequest(page, {
		kind: "conversation-plan:research-link",
		offerId: "offer-foreign",
	});
	expect(foreign).toMatchObject({
		kind: "conversation-plan:research-link",
		offerId: "offer-foreign",
		status: "pending",
	});
	expect(foreign.researchRequestId).toBeUndefined();
	expect(JSON.stringify(foreign)).not.toContain(foreignId);

	for (let offerId of ["offer-offered", "offer-absent"]) {
		let rejected = await wireRequest(page, {
			kind: "conversation-plan:research-link",
			offerId,
		});
		expect(rejected).toMatchObject({ kind: "session:error" });
		expect(rejected).not.toHaveProperty("researchRequestId");
	}
	let after = await transportState([room, foreignChannel]);
	expect(after).toEqual(before);
});

test("research-link rechecks a pull viewer after GitHub access is revoked", async ({ baseURL, page, room, seed }) => {
	let origin = baseURL!;
	let spec: OfferSpec = {
		id: "offer-revoked",
		brief: "Check a synthetic permission revalidation.",
		status: "accepted",
	};
	let handle = `revoked-after-admission-${crypto.randomUUID().slice(0, 8)}`;
	let { state, transcript } = offerSources([spec], handle);
	await seed("# Research link authorization fixture\n", { transcript });
	await saveConversationState(room, state);
	await seededReader(page, handle, origin, room);

	let invalidated = await page.request.get(`${origin}/auth/github/setup`, {
		maxRedirects: 0,
	});
	expect(invalidated.status()).toBe(303);
	let rejected = await wireRequest(page, {
		kind: "conversation-plan:research-link",
		offerId: spec.id,
	});
	expect(rejected).toMatchObject({
		kind: "session:error",
		message: "authorization expired",
	});
	expect(rejected).not.toHaveProperty("researchRequestId");
});
