import { describe, expect, it } from "bun:test";

import { carryReferences, project } from "./queued-work";

import type { Chat as Wire } from "@chopin/protocol";

function reference(label: string, start: number): Wire.DocumentReference {
	return {
		id: `01JREFERENCE${start}`.padEnd(26, "0"),
		kind: "document",
		start,
		end: start + label.length,
		label,
		href: "/o/r/doc",
		repositoryId: "R",
		observedRevision: 1,
		channelId: "00000000-0000-4000-8000-000000000001",
		observedSourceHash: `sha256:${"a".repeat(64)}`,
	};
}

describe("what the queue says of each kind of waiting turn", () => {
	it("keeps a typed message as it was typed, with its references and author", () => {
		let text = "Check #Plan again";
		let references = [reference("#Plan", 6)];
		expect(project({ id: "a", handle: "ana", text, message: true, references })).toEqual({
			id: "a",
			handle: "ana",
			text,
			references,
		});
		expect(project({ id: "a", handle: "ana", text, message: true })).toEqual({
			id: "a",
			handle: "ana",
			text,
		});
	});

	it("tells work nobody typed in plain words, never as its prompt", () => {
		let prompt = "SECRET PROMPT the Planner alone reads";
		expect(project({ id: "c", handle: "ana", text: prompt, thread: "t" })).toEqual({
			id: "c",
			handle: "ana",
			kind: "comment",
			text: "Reply to a comment",
		});
		expect(project({ id: "d", handle: "ana", text: prompt, draft: "d" })).toEqual({
			id: "d",
			handle: "ana",
			kind: "draft",
			text: "Draft of the build tasks",
		});
		expect(project({ id: "f", handle: "ana", text: prompt })).toEqual({
			id: "f",
			handle: "ana",
			kind: "followup",
			text: "Automatic follow-up",
		});
		for (
			let kind of ["heading", "refine", "suggest", "prose", "decision-followup"] as const
		) {
			let shown = project({ id: kind, handle: "chopin", text: prompt, job: { job: { kind } } });
			expect(shown).toMatchObject({ kind: "job", handle: "chopin" });
			expect(shown.text).toMatch(/^[A-Z][^.]+[a-z]$/);
			expect(JSON.stringify(shown)).not.toContain("SECRET");
		}
	});

	it("is a message before it is a thread: a typed message about a thread is still the person's", () => {
		expect(project({ id: "m", handle: "ana", text: "hi", message: true, thread: "t" })).toEqual({
			id: "m",
			handle: "ana",
			text: "hi",
		});
	});
});

describe("references that stand after an edit", () => {
	let text = "Compare #Plan with #Spec today";
	let plan = reference("#Plan", 8);
	let spec = reference("#Spec", 19);

	it("keeps every reference when the edit changes nothing", () => {
		expect(carryReferences(text, text, [plan, spec])).toEqual([plan, spec]);
	});

	it("keeps those before the edit where they were, and moves those after it", () => {
		let after = "Please compare #Plan with #Spec today";
		let carried = carryReferences(text, after, [plan, spec]);
		expect(carried.map(item => after.slice(item.start, item.end))).toEqual(["#Plan", "#Spec"]);
		expect(carried[0]).toMatchObject({ id: plan.id, start: 15, end: 20 });
		expect(carried[1]).toMatchObject({ id: spec.id, start: 26, end: 31 });
		// Everything else about the reference stays as it was resolved.
		expect(carried[1]).toEqual({ ...spec, start: 26, end: 31 });

		let shorter = "Compare #Plan with #Spec";
		let trimmed = carryReferences(text, shorter, [plan, spec]);
		expect(trimmed).toEqual([plan, spec]);
	});

	it("drops a reference the edit touched, and keeps the others", () => {
		let edited = "Compare #Pla with #Spec today";
		let carried = carryReferences(text, edited, [plan, spec]);
		expect(carried).toEqual([{ ...spec, start: 18, end: 23 }]);
		expect(edited.slice(carried[0]!.start, carried[0]!.end)).toBe("#Spec");

		expect(carryReferences(text, "Compare today", [plan, spec])).toEqual([]);
	});

	it("keeps a reference the edit did not touch when it changed both ends of the message", () => {
		let before = "see #Doc and fix";
		let after = "please see #Doc and fix it";
		let doc = reference("#Doc", 4);
		let carried = carryReferences(before, after, [doc]);
		expect(carried).toEqual([{ ...doc, start: 11, end: 15 }]);
		expect(after.slice(carried[0]!.start, carried[0]!.end)).toBe("#Doc");
		// Where the label stands more than once, which place is the reference's cannot be told.
		expect(carryReferences(before, "please see #Doc and #Doc, fix it", [doc])).toEqual([]);
		// One the edit changed is still dropped.
		expect(carryReferences(before, "please see #Do and fix it", [doc])).toEqual([]);
		// Several keep their order, and none overlaps another.
		let two = [reference("#Plan", 8), reference("#Spec", 19)];
		let swapped = carryReferences(text, "Hey: compare #Plan with #Spec now!", two);
		expect(swapped.map(item => item.label)).toEqual(["#Plan", "#Spec"]);
		expect(swapped[0]!.end).toBeLessThanOrEqual(swapped[1]!.start);
	});

	it("drops a reference the edit ran into the word beside it, and keeps one that already did", () => {
		let doc = reference("#Doc", 2);
		expect(carryReferences("a #Doc b", "x #Docs y", [doc])).toEqual([]);
		expect(carryReferences("see #Doc now", "see #Doc, now", [reference("#Doc", 4)])).toEqual([
			reference("#Doc", 4),
		]);
		expect(carryReferences("see #Doc now", "see #Docs now", [reference("#Doc", 4)])).toEqual([]);
		// Joined before the edit as well, so nothing the edit did.
		let joinedBefore = reference("#Doc", 3);
		expect(carryReferences("see#Docs now", "see#Docs now!", [joinedBefore])).toEqual([
			joinedBefore,
		]);
	});

	it("keeps none when there were none, and never invents one", () => {
		expect(carryReferences("one", "two")).toEqual([]);
		expect(carryReferences("", "new", [])).toEqual([]);
	});

	it("never keeps a reference whose label no longer reads where it points", () => {
		// Replaced by text of the same length: the prefix and suffix check cannot be fooled.
		let swapped = "Compare #Plam with #Spec today";
		let carried = carryReferences(text, swapped, [plan, spec]);
		expect(carried.map(item => swapped.slice(item.start, item.end))).toEqual(["#Spec"]);
	});
});
