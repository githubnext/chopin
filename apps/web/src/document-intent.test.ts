import { expect, test } from "bun:test";

import { addressOfHref, createDocumentIntent, FRESH_MS } from "./document-intent";

import type * as Api from "./api";

let address = { owner: "octo-org", repository: "score", slug: "plan" };
let detail = (title: string) => ({ channel: { title } }) as unknown as Api.ChannelDetail;

function intent() {
	let reads: string[] = [];
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
		advance: (ms: number) => void (clock += ms),
		fail: () => void (outcome = () => Promise.reject(new Error("gone"))),
	};
}

test("a read started on intent is what the click gets, once", async () => {
	let documents = intent();
	documents.start(address);
	let first = documents.take(address);
	expect(first).toBeDefined();
	expect((await first)!.channel.title).toBe("Plan");
	expect(documents.take(address)).toBeUndefined();
	expect(documents.reads).toEqual(["octo-org/score/plan"]);
});

test("a pointer still on the row after the click that opened it does not ask again", () => {
	let documents = intent();
	documents.start(address);
	documents.take(address);
	documents.advance(200);
	documents.start(address);
	expect(documents.reads).toHaveLength(1);
	expect(documents.take(address)).toBeUndefined();
});

test("resting on the same row again does not ask the server again", () => {
	let documents = intent();
	documents.start(address);
	documents.advance(FRESH_MS - 1);
	documents.start(address);
	expect(documents.reads).toHaveLength(1);
});

test("a read that has gone stale is not used for a click, and a new one can start", () => {
	let documents = intent();
	documents.start(address);
	documents.advance(FRESH_MS);
	expect(documents.take(address)).toBeUndefined();
	documents.start(address);
	expect(documents.reads).toHaveLength(2);
	expect(documents.take(address)).toBeDefined();
});

test("each document has its own read, and a click on another uses none", () => {
	let documents = intent();
	documents.start(address);
	expect(documents.take({ ...address, slug: "other" })).toBeUndefined();
	expect(documents.take(address)).toBeDefined();
});

test("a read that failed is forgotten, so the click asks for itself", async () => {
	let documents = intent();
	documents.fail();
	documents.start(address);
	await Promise.resolve();
	await Promise.resolve();
	expect(documents.take(address)).toBeUndefined();
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
