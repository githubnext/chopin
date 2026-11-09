import { afterEach, expect, test } from "bun:test";

import {
	addressOfHref,
	AGAIN_MS,
	createDocumentIntent,
	documentIntent,
	FRESH_MS,
} from "./document-intent";

import * as Api from "./api";

let address = { owner: "octo-org", repository: "score", slug: "plan" };
let detail = (title: string) => ({ channel: { title } }) as unknown as Api.ChannelDetail;
let settle = () => new Promise<void>(resolve => setTimeout(resolve));

function intent() {
	let reads: string[] = [];
	let own: string[] = [];
	let clock = 0;
	let outcome: () => Promise<Api.ChannelDetail> = () => Promise.resolve(detail("Plan"));
	let made = createDocumentIntent(
		(owner, repository, slug) => {
			reads.push(`${owner}/${repository}/${slug}`);
			return outcome();
		},
		() => clock,
	);
	return {
		...made,
		reads,
		own,
		advance: (ms: number) => void (clock += ms),
		fail: () => void (outcome = () => Promise.reject(new Error("gone"))),
		hold: () => {
			let held = Promise.withResolvers<Api.ChannelDetail>();
			outcome = () => held.promise;
			return { fail: held.reject, release: held.resolve };
		},
		/** What the opening itself would have read, as it would have without any intent. */
		ordinary: (title = "Fresh") => () => {
			own.push(title);
			return Promise.resolve(detail(title));
		},
	};
}

test("a read started on intent is what the opening gets, once, and the opening asks for nothing itself", async () => {
	let documents = intent();
	documents.start(address);
	expect((await documents.read(address, documents.ordinary())).channel.title).toBe("Plan");
	expect(documents.own).toEqual([]);
	expect((await documents.read(address, documents.ordinary())).channel.title).toBe("Fresh");
	expect(documents.reads).toEqual(["octo-org/score/plan"]);
	expect(documents.own).toEqual(["Fresh"]);
});

test("an opening nobody rested on reads for itself, as it always did", async () => {
	let documents = intent();
	expect((await documents.read(address, documents.ordinary())).channel.title).toBe("Fresh");
	expect(documents.reads).toEqual([]);
});

test("a pointer still on the row after the click that opened it does not ask again", async () => {
	let documents = intent();
	documents.start(address);
	await documents.read(address, documents.ordinary());
	documents.advance(FRESH_MS + 200);
	documents.start(address);
	documents.advance(AGAIN_MS - FRESH_MS - 201);
	documents.start(address);
	expect(documents.reads).toHaveLength(1);
});

test("resting on the same row again does not ask the server again while the read stands", async () => {
	let documents = intent();
	documents.start(address);
	await settle();
	documents.advance(FRESH_MS - 1);
	documents.start(address);
	expect(documents.reads).toHaveLength(1);
});

test("a read that was answered long enough ago is not what an opening gets", async () => {
	let documents = intent();
	documents.start(address);
	await settle();
	documents.advance(FRESH_MS);
	expect((await documents.read(address, documents.ordinary())).channel.title).toBe("Fresh");
	expect(documents.own).toEqual(["Fresh"]);
});

test("a pointer that comes back to a row after its read has gone stale starts a new one", async () => {
	let documents = intent();
	documents.start(address);
	await settle();
	documents.advance(FRESH_MS);
	documents.start(address);
	expect(documents.reads).toHaveLength(2);
	expect((await documents.read(address, documents.ordinary())).channel.title).toBe("Plan");
});

test("a pointer still on the row after an opening that read for itself does not ask either", async () => {
	let documents = intent();
	await documents.read(address, documents.ordinary());
	documents.advance(AGAIN_MS - 1);
	documents.start(address);
	expect(documents.reads).toHaveLength(0);
	documents.advance(1);
	documents.start(address);
	expect(documents.reads).toHaveLength(1);
});

test("an opening never gets a record that was answered two seconds earlier, whatever the window", async () => {
	let documents = intent();
	documents.start(address);
	await settle();
	documents.advance(2_000);
	expect((await documents.read(address, documents.ordinary())).channel.title).toBe("Fresh");
});

test("a read is as old as its answer, so a slow one still serves the click that comes soon after it", async () => {
	let documents = intent();
	let held = documents.hold();
	documents.start(address);
	documents.advance(FRESH_MS + 400);
	held.release(detail("Slow"));
	await settle();
	documents.advance(FRESH_MS - 1);
	expect((await documents.read(address, documents.ordinary())).channel.title).toBe("Slow");
	expect(documents.own).toEqual([]);
});

test("a read that has been under way for too long is not waited for", async () => {
	let documents = intent();
	documents.hold();
	documents.start(address);
	documents.advance(FRESH_MS);
	expect((await documents.read(address, documents.ordinary())).channel.title).toBe("Fresh");
});

test("an opening that was waiting on a read that then fails makes its own read", async () => {
	let documents = intent();
	let held = documents.hold();
	documents.start(address);
	let opening = documents.read(address, documents.ordinary("Own"));
	await settle();
	expect(documents.own).toEqual([]);
	held.fail(new Error("temporary"));
	expect((await opening).channel.title).toBe("Own");
	expect(documents.own).toEqual(["Own"]);
	expect(documents.reads).toHaveLength(1);
});

test("when that read fails too, the opening fails as it would have without intent", async () => {
	let documents = intent();
	let held = documents.hold();
	documents.start(address);
	let opening = documents.read(address, () => Promise.reject(new Error("own failure")));
	held.fail(new Error("temporary"));
	await expect(opening).rejects.toThrow("own failure");
});

test("a read that failed with nobody waiting is dropped without a trace, and the opening asks for itself", async () => {
	let documents = intent();
	documents.fail();
	documents.start(address);
	await settle();
	expect((await documents.read(address, documents.ordinary())).channel.title).toBe("Fresh");
	expect(documents.own).toEqual(["Fresh"]);
});

test("a row whose read failed is not asked again as the pointer passes over it, until a while has gone by", async () => {
	let documents = intent();
	documents.fail();
	documents.start(address);
	await settle();
	documents.advance(AGAIN_MS - 1);
	documents.start(address);
	expect(documents.reads).toHaveLength(1);
	documents.advance(1);
	documents.start(address);
	expect(documents.reads).toHaveLength(2);
});

test("each document has its own read, and an opening of another uses none", async () => {
	let documents = intent();
	documents.start(address);
	expect(
		(await documents.read({ ...address, slug: "other" }, documents.ordinary())).channel.title,
	).toBe("Fresh");
	expect((await documents.read(address, documents.ordinary())).channel.title).toBe("Plan");
});

test("a document's link has an address, and a child's, another page's and nothing have none", () => {
	expect(addressOfHref("/documents/octo-org/score/plan")).toEqual(address);
	expect(addressOfHref("/documents/octo-org/score/my%20plan")).toEqual({
		...address,
		slug: "my plan",
	});
	expect(addressOfHref("/documents/octo-org/score/plan/children/why")).toBeUndefined();
	expect(addressOfHref("/documents/octo-org/score")).toBeUndefined();
	expect(addressOfHref("/machines")).toBeUndefined();
	expect(addressOfHref(undefined)).toBeUndefined();
});

// The read that really goes to the server. A reader whose session has ended is told so by a request
// they made, which reloads the page; one they did not make must not reload anything.
let originalFetch = globalThis.fetch;
let originalLocation = Object.getOwnPropertyDescriptor(globalThis, "location");

afterEach(() => {
	globalThis.fetch = originalFetch;
	if (originalLocation) Object.defineProperty(globalThis, "location", originalLocation);
	else Reflect.deleteProperty(globalThis, "location");
});

function expiredSession() {
	let requested: string[] = [];
	let reloads = 0;
	globalThis.fetch = Object.assign(
		async (input: string | URL | Request) => {
			requested.push(String(input));
			return Response.json({ error: "authentication required" }, { status: 401 });
		},
		{ preconnect: originalFetch.preconnect },
	) as typeof fetch;
	Object.defineProperty(globalThis, "location", {
		configurable: true,
		value: { reload: () => void (reloads += 1) },
	});
	return { reloads: () => reloads, requested };
}

test("a read nobody asked for does not reload the page when the session has ended", async () => {
	let session = expiredSession();
	documentIntent.start({ owner: "octo-org", repository: "score", slug: "resting" });
	await settle();
	expect(session.requested).toEqual(["/api/repositories/octo-org/score/documents/resting"]);
	expect(session.reloads()).toBe(0);
	let opening = await documentIntent.read(
		{ owner: "octo-org", repository: "score", slug: "resting" },
		() => Promise.resolve(detail("Own")),
	);
	expect(opening.channel.title).toBe("Own");
	expect(session.reloads()).toBe(0);
});

test("a read the reader asked for still reloads the page when the session has ended", async () => {
	let session = expiredSession();
	await expect(Api.document("octo-org", "score", "opened")).rejects.toThrow(
		"authentication required",
	);
	expect(session.reloads()).toBe(1);
});
