/**
 * Deciding who a message is for.
 *
 * The risk of a mention gate is a message that reaches nobody: typed, shown,
 * and silently not acted on. So the rule has to be one a person can predict
 * from looking at what they wrote, which means it is worth pinning precisely.
 */

import { describe, expect, it } from "bun:test";

import { addressed, instruction } from "@chopin/protocol/address";

import { annotatedText, compose, referenceCatalog, remember } from "./address";

import type { Said } from "./address";
import type { Chat as Wire } from "@chopin/protocol";

describe("addressing", () => {
	it("recognises the mention wherever it appears", () => {
		expect(addressed("@chopin draft the auth section")).toBe(true);
		expect(addressed("ok, @chopin go ahead")).toBe(true);
		expect(addressed("do that @chopin")).toBe(true);
		expect(addressed("@chopin")).toBe(true);
	});

	it("does not care about case", () => {
		expect(addressed("@CHOPIN please")).toBe(true);
		expect(addressed("@Chopin please")).toBe(true);
	});

	it("does not recognise the retired mention", () => {
		expect(addressed("@ai draft the auth section")).toBe(false);
	});

	it("leaves ordinary conversation alone", () => {
		expect(addressed("should we ask about auth first?")).toBe(false);
		expect(addressed("ai is going to write this bit")).toBe(false);
		expect(addressed("let me look at the plan")).toBe(false);
	});

	/**
	 * The cases that would make the gate unpredictable: an address inside a
	 * larger token. Firing a turn because somebody pasted an email would be
	 * worse than missing one.
	 */
	it("is not fooled by a longer token", () => {
		expect(addressed("mail me at hi@chopin.dev")).toBe(false);
		expect(addressed("see @chopina for that")).toBe(false);
		expect(addressed("the @@chopin thing")).toBe(false);
	});
});

describe("the instruction", () => {
	it("strips the summons, which is addressing rather than content", () => {
		expect(instruction("@chopin draft the auth section")).toBe("draft the auth section");
		expect(instruction("ok @chopin go ahead")).toBe("ok go ahead");
	});

	it("is empty for a bare mention", () => {
		expect(instruction("@chopin")).toBe("");
		expect(instruction("  @chopin  ")).toBe("");
	});
});

function said(text: string, handle = "alice"): Said {
	return { handle, text };
}

function duplicateLabelReference(id: string, start: number): Wire.DocumentReference {
	return {
		id,
		kind: "document",
		start,
		end: start + "#Shared".length,
		label: "#Shared",
		href: `/documents/owner/repository/${id}`,
		repositoryId: "R_test",
		observedRevision: 1,
		channelId: crypto.randomUUID(),
		observedSourceHash: `sha256:${"0".repeat(64)}`,
	};
}

describe("backscroll", () => {
	it("keeps what was said, in order", () => {
		let buffer = remember(remember([], said("one")), said("two", "bob"));
		expect(buffer).toEqual([
			{ handle: "alice", text: "one" },
			{ handle: "bob", text: "two" },
		]);
	});

	it("drops the oldest rather than growing without limit", () => {
		let buffer: Said[] = [];
		for (let i = 0; i < 60; i++) buffer = remember(buffer, said(`message ${i}`));

		expect(buffer.length).toBeLessThanOrEqual(40);
		// The most recent survives; the first is long gone.
		expect(buffer.at(-1)?.text).toBe("message 59");
		expect(buffer.some(item => item.text === "message 0")).toBe(false);
	});

	it("bounds by size as well as count", () => {
		let buffer: Said[] = [];
		for (let i = 0; i < 20; i++) buffer = remember(buffer, said("x".repeat(1000)));

		let total = buffer.reduce((sum, item) => sum + item.text.length, 0);
		expect(total).toBeLessThanOrEqual(8_000);
	});

	it("never discards the only thing it has, however long", () => {
		expect(remember([], said("y".repeat(20_000)))).toHaveLength(1);
	});
});

describe("composing a turn", () => {
	it("sends the message alone when nothing was said before it", () => {
		expect(compose([], "alice", "@chopin draft the auth section"))
			.toBe("@alice: draft the auth section");
	});

	it("carries the conversation in front of the instruction", () => {
		let prompt = compose(
			[
				{ handle: "alice", text: "should we ask about auth first?" },
				{ handle: "bob", text: "probably, the OAuth bit is unclear" },
			],
			"alice",
			"@chopin draft the auth section",
		);

		expect(prompt).toContain("Said in the room since your last turn:");
		expect(prompt).toContain("@alice: should we ask about auth first?");
		expect(prompt).toContain("@bob: probably, the OAuth bit is unclear");
		// The instruction comes last, so it reads as the thing being asked.
		expect(prompt.trimEnd().endsWith("@alice: draft the auth section")).toBe(true);
	});

	/**
	 * A bare mention after a discussion is how somebody says "ok, go" once the
	 * argument is settled. It has to mean act on that, not act on nothing.
	 */
	it("turns a bare mention into an instruction to act on what was said", () => {
		let prompt = compose(
			[{ handle: "bob", text: "let us go with OAuth" }],
			"alice",
			"@chopin",
		);

		expect(prompt).toContain("@bob: let us go with OAuth");
		expect(prompt).toContain("act on the conversation above");
	});

	it("annotates duplicate labels inline with their authoritative reference ids", () => {
		let earlier = duplicateLabelReference("ref-earlier", "Use ".length);
		let current = duplicateLabelReference("ref-current", "Compare ".length);
		let prompt = compose(
			[{ handle: "bob", text: "Use #Shared", references: [earlier] }],
			"alice",
			"Compare #Shared",
			[current],
		);
		expect(prompt).toContain("@bob: Use #Shared [reference id: ref-earlier]");
		expect(prompt).toContain("@alice: Compare #Shared [reference id: ref-current]");
		expect(prompt).toContain("- ref-earlier:");
		expect(prompt).toContain("- ref-current:");
		expect(prompt).not.toContain(earlier.href);
	});

	it("does not interpret @chopin inside an annotated canonical label", () => {
		let text = "Read #@chopin Notes";
		let reference = {
			id: "ref-notes",
			start: "Read ".length,
			end: text.length,
			label: "#@chopin Notes",
		} as Wire.Reference;
		expect(annotatedText(text, [reference])).toBe(
			"Read #@chopin Notes [reference id: ref-notes]",
		);
		expect(compose([], "ana", text, [reference])).toContain("#@chopin Notes");
	});

	it("bounds the model catalog independently of reference hrefs", () => {
		let references = Array.from(
			{ length: 60 },
			(_, index) => duplicateLabelReference(`ref-${index}`, 0),
		);
		let catalog = referenceCatalog(references);
		expect(catalog?.length).toBeLessThanOrEqual(16_000);
		expect(catalog).toContain("ref-49");
		expect(catalog).not.toContain("ref-50:");
		expect(catalog).not.toContain("/documents/");
	});
});
