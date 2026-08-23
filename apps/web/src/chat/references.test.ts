import { describe, expect, test } from "bun:test";

import {
	acknowledgeDraft,
	beforeInputSelection,
	boundedChatError,
	chatSendPayload,
	contiguousReplacement,
	insertReference,
	MAX_REFERENCE_QUERY,
	MAX_REFERENCES,
	prepareDraftSubmission,
	reconcileReferenceDrafts,
	referenceTrigger,
	reviseComposerDraft,
	selectedReplacement,
} from "./references";

import type { ReferenceDraft, ReferenceTarget } from "./references";

let REQUEST_ID = "123e4567-e89b-42d3-a456-426614174000";

function documentDraft(text: string, token: string, channelId = "channel-one"): ReferenceDraft {
	let start = text.indexOf(token);
	return { kind: "document", channelId, start, end: start + token.length, token };
}

function researchDraft(text: string, token: string, workspaceId = "research-one"): ReferenceDraft {
	let start = text.indexOf(token);
	return { kind: "research", workspaceId, start, end: start + token.length, token };
}

function select(text: string, target: ReferenceTarget, references: ReferenceDraft[] = []) {
	let trigger = referenceTrigger(text, text.length);
	if (!trigger) throw new Error("expected a reference trigger");
	return insertReference(text, references, trigger, target);
}

describe("typed reference triggers", () => {
	test("finds bare and queried tokens only at a whitespace boundary", () => {
		expect(referenceTrigger("#", 1)).toMatchObject({
			kind: "document",
			marker: "#",
			query: "",
			start: 0,
			end: 1,
		});
		expect(referenceTrigger("Ask %OAuth", 10)).toMatchObject({
			kind: "research",
			query: "OAuth",
			start: 4,
			end: 10,
		});
		expect(referenceTrigger("Line one\n#release:v2", 20)?.query).toBe("release:v2");
	});

	test("ignores URLs, embedded markers, whitespace queries, and selections", () => {
		for (let value of ["https://example.com/#release", "issue#12", "100%ready", "#two words"]) {
			expect(referenceTrigger(value, value.length)).toBeUndefined();
		}
		expect(referenceTrigger("#release", 0, 4)).toBeUndefined();
	});

	test("bounds the active query", () => {
		let accepted = `#${"a".repeat(MAX_REFERENCE_QUERY)}`;
		let rejected = `#${"a".repeat(MAX_REFERENCE_QUERY + 1)}`;
		expect(referenceTrigger(accepted, accepted.length)?.query).toHaveLength(MAX_REFERENCE_QUERY);
		expect(referenceTrigger(rejected, rejected.length)).toBeUndefined();
		expect(referenceTrigger("#release%next", 13)).toBeUndefined();
	});
});

describe("reference draft tokens", () => {
	test("inserts punctuation verbatim and records UTF-16 ranges", () => {
		let text = "😀 compare #rel later";
		let caret = text.indexOf(" later");
		let trigger = referenceTrigger(text, caret)!;
		let result = insertReference(text, [], trigger, {
			kind: "document",
			channelId: "channel-release",
			title: "Release: v2 (API)",
		});

		expect(result.text).toBe("😀 compare #Release: v2 (API) later");
		expect(result.caret).toBe("😀 compare #Release: v2 (API)".length);
		expect(result.references).toEqual([{
			kind: "document",
			channelId: "channel-release",
			start: "😀 compare ".length,
			end: "😀 compare #Release: v2 (API)".length,
			token: "#Release: v2 (API)",
		}]);
	});

	test("deduplicates stable targets while allowing duplicate titles", () => {
		let first = select("#", {
			kind: "document",
			channelId: "channel-one",
			title: "Shared title",
		});
		let duplicate = select(`${first.text} #`, {
			kind: "document",
			channelId: "channel-one",
			title: "Shared title",
		}, first.references);
		let sameTitle = select(`${duplicate.text} #`, {
			kind: "document",
			channelId: "channel-two",
			title: "Shared title",
		}, duplicate.references);

		expect(duplicate.references).toHaveLength(1);
		expect(duplicate.references[0]!.start).toBe(first.text.length + 1);
		expect(
			sameTitle.references.map(reference =>
				reference.kind === "document" ? reference.channelId : reference.workspaceId
			),
		).toEqual(["channel-one", "channel-two"]);
	});

	test("never records more than ten stable references", () => {
		let text = "";
		let references: ReferenceDraft[] = [];
		for (let index = 0; index < MAX_REFERENCES; index++) {
			let prefix = text ? `${text} #` : "#";
			let next = select(prefix, {
				kind: "document",
				channelId: `channel-${index}`,
				title: `Document ${index}`,
			}, references);
			text = next.text;
			references = next.references;
		}
		let overflowText = `${text} %`;
		let overflow = select(overflowText, {
			kind: "research",
			workspaceId: "workspace-overflow",
			title: "Overflow",
			discriminator: "overflow",
		}, references);

		expect(references).toHaveLength(MAX_REFERENCES);
		expect(overflow).toEqual({ text: overflowText, references, caret: overflowText.length });
	});
});

describe("textarea replacement reconciliation", () => {
	test("derives one replacement from common UTF-16 edges", () => {
		expect(contiguousReplacement("before old after", "before new after")).toEqual({
			start: 7,
			previousEnd: 10,
			nextEnd: 10,
		});
	});

	test("keeps tokens before edits and shifts tokens after edits", () => {
		let text = "Before #Plan after";
		let reference = documentDraft(text, "#Plan");
		expect(reconcileReferenceDrafts(text, `${text}!`, [reference])).toEqual([reference]);

		let prefixed = `New ${text}`;
		expect(reconcileReferenceDrafts(text, prefixed, [reference])).toEqual([{
			...reference,
			start: reference.start + 4,
			end: reference.end + 4,
		}]);

		let atBoundary = `${text.slice(0, reference.end)}!${text.slice(reference.end)}`;
		expect(reconcileReferenceDrafts(text, atBoundary, [reference])).toEqual([reference]);
	});

	test("drops overlap, changed tokens, and moved text conservatively", () => {
		let text = "Before #Plan after";
		let reference = documentDraft(text, "#Plan");
		expect(reconcileReferenceDrafts(text, "Before #PlaXn after", [reference])).toEqual([]);
		expect(reconcileReferenceDrafts(text, "Before #Other after", [reference])).toEqual([]);
		expect(reconcileReferenceDrafts(text, "#Plan Before after", [reference])).toEqual([]);
	});

	test("drops a stable range when an ordinary paste introduces the same token", () => {
		let text = "Use #Plan now";
		let reference = documentDraft(text, "#Plan");
		let duplicate = "#Plan Use #Plan now";

		expect(reconcileReferenceDrafts(text, duplicate, [reference], { start: 0, end: 0 }))
			.toEqual([]);
	});

	test("uses beforeinput selection to drop whole replacements and composition overlap", () => {
		let text = "Use #Plan now";
		let reference = documentDraft(text, "#Plan");
		let pasted = "Pasted #Plan";
		expect(selectedReplacement(text, pasted, { start: 0, end: text.length })).toEqual({
			start: 0,
			previousEnd: text.length,
			nextEnd: pasted.length,
		});
		expect(reconcileReferenceDrafts(text, pasted, [reference], {
			start: 0,
			end: text.length,
		})).toEqual([]);
		expect(beforeInputSelection(4, 4, "deleteContentBackward", text.length)).toEqual({
			start: 3,
			end: 4,
		});
	});
});

describe("chat send payloads", () => {
	test("sorts and trims ranges without letting references summon Planner", () => {
		let text = "  @chopin compare #Release and %Evidence  ";
		let document = documentDraft(text, "#Release", "channel-release");
		let research = researchDraft(text, "%Evidence", "workspace-evidence");
		expect(chatSendPayload(text, [research, document], true, REQUEST_ID)).toEqual({
			requestId: REQUEST_ID,
			text: "@chopin compare #Release and %Evidence",
			to: "planner",
			references: [
				{
					kind: "document",
					channelId: "channel-release",
					start: document.start - 2,
					end: document.end - 2,
				},
				{
					kind: "research",
					workspaceId: "workspace-evidence",
					start: research.start - 2,
					end: research.end - 2,
				},
			],
		});

		let roomText = "See #Release";
		expect(
			chatSendPayload(
				roomText,
				[documentDraft(roomText, "#Release")],
				true,
				REQUEST_ID,
			)?.to,
		).toBe(
			"room",
		);
	});

	test("omits stale drafts and empty messages", () => {
		let stale = documentDraft("See #Old", "#Old");
		expect(chatSendPayload("See #New", [stale], false, REQUEST_ID)).toEqual({
			requestId: REQUEST_ID,
			text: "See #New",
			to: "room",
		});
		expect(chatSendPayload("  \n", [], true, REQUEST_ID)).toBeUndefined();
	});

	test("ignores Planner mentions inside attached document and research titles", () => {
		let documentText = "See #Ask @chopin";
		let researchText = "See %OAuth @chopin";
		expect(chatSendPayload(
			documentText,
			[documentDraft(documentText, "#Ask @chopin")],
			true,
			REQUEST_ID,
		)).toMatchObject({ to: "room", references: [{ kind: "document" }] });
		expect(chatSendPayload(
			researchText,
			[researchDraft(researchText, "%OAuth @chopin")],
			true,
			REQUEST_ID,
		)).toMatchObject({ to: "room", references: [{ kind: "research" }] });

		let outside = "@chopin See #Ask @chopin";
		expect(
			chatSendPayload(
				outside,
				[documentDraft(outside, "#Ask @chopin")],
				true,
				REQUEST_ID,
			)?.to,
		).toBe("planner");
	});

	test("treats tokens as ordinary text when chat references are unsupported", () => {
		let text = "See #Ask @chopin";
		expect(chatSendPayload(
			text,
			[documentDraft(text, "#Ask @chopin")],
			true,
			REQUEST_ID,
			false,
		)).toEqual({
			requestId: REQUEST_ID,
			text,
			to: "planner",
		});
	});
});

describe("acknowledged composer drafts", () => {
	test("keeps one UUID through retries and resets after semantic edits", () => {
		let draft = { text: "Send this", references: [] };
		let first = prepareDraftSubmission(draft, () => REQUEST_ID);
		let retry = prepareDraftSubmission(first, () => crypto.randomUUID());
		expect(retry).toBe(first);
		expect(retry.requestId).toBe(REQUEST_ID);

		let edited = reviseComposerDraft(first, `${first.text}!`, first.references);
		let next = prepareDraftSubmission(edited, () => "694a9c19-0e1b-4c66-94f9-523317d76325");
		expect(next.requestId).not.toBe(first.requestId);
		let semanticEdit = reviseComposerDraft(
			first,
			first.text,
			[documentDraft("#Plan", "#Plan")],
		);
		expect(
			prepareDraftSubmission(semanticEdit, () => "ab6eb3f4-5682-46b6-b47c-09f3707a6b62")
				.requestId,
		).not.toBe(first.requestId);
		expect(reviseComposerDraft(first, first.text, [...first.references])).toBe(first);
		expect(prepareDraftSubmission({ text: "Generated", references: [] }).requestId).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
		);
	});

	test("clears only the exact submitted draft", () => {
		let submitted = { text: "Send this", references: [] };
		let changed = { text: "Send this, amended", references: [] };
		expect(acknowledgeDraft(submitted, submitted)).toEqual({ text: "", references: [] });
		expect(acknowledgeDraft(changed, submitted)).toBe(changed);
	});

	test("bounds server errors and gives disconnects useful copy", () => {
		let bounded = boundedChatError(new Error("x".repeat(500)));
		expect(bounded.length).toBeLessThanOrEqual(138);
		expect(bounded).toEndWith("...");
		expect(boundedChatError(new Error("connection lost"))).toContain("Check the connection");
	});
});
