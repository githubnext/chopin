import { createHash } from "node:crypto";

import { expect, test } from "bun:test";

import { cases, materialize } from "./cohort";

test("all frozen development cases materialize from the committed loader", async () => {
	expect(cases.map(item => item.caseId)).toEqual([
		"R1",
		"R2",
		"A1",
		"P1",
		"V1",
		"T1",
		"B1",
		"E1",
		"D1",
		"S1",
	]);
	for (let item of cases) {
		let actual = await materialize(item);
		expect(createHash("sha256").update(actual.source).digest("hex")).toBe(item.sourceSha256);
		expect(createHash("sha256").update(actual.prompt).digest("hex")).toBe(item.promptSha256);
		expect(actual.origin).toBe(item.origin);
	}
});

test("adapted inputs expose their provenance without raw discussion claims", async () => {
	let vite = await materialize(cases.find(item => item.caseId === "V1")!);
	expect(vite.source).toContain("Origin: adapted event summaries");
	expect(vite.source).toContain("Cutoff: 2026-07-30T10:06:03Z");
	expect(vite.source).not.toContain("vite@8.1.5");
	expect(vite.source).not.toContain("css-update");
	let editor = await materialize(cases.find(item => item.caseId === "S1")!);
	expect(editor.source).toContain("Origin: synthetic development chat");
	expect(editor.source).not.toContain("I'd pick Lexical");
});
