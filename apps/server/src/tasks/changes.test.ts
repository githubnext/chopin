import { describe, expect, test } from "bun:test";
import { changedBlocks } from "./changes";

const BASE = "# Snooze\n\nFive minutes.\n\nFifteen minutes.\n\nAn hour.\n";

describe("changedBlocks", () => {
	test("counts nothing for the same source", () => {
		expect(changedBlocks(BASE, BASE)).toBe(0);
	});

	test("counts an edited block once", () => {
		expect(changedBlocks(BASE, BASE.replace("An hour.", "Two hours."))).toBe(1);
	});

	test("counts added and removed blocks", () => {
		expect(changedBlocks(BASE, `${BASE}\nA day.\n\nA week.\n`)).toBe(2);
		expect(changedBlocks(BASE, BASE.replace("Fifteen minutes.\n\n", ""))).toBe(1);
	});

	test("counts the larger side when edits and additions mix", () => {
		let after = BASE.replace("Five minutes.", "Ten minutes.").replace("An hour.", "Two hours.");
		expect(changedBlocks(BASE, `${after}\nA day.\n`)).toBe(3);
	});

	test("counts a moved block as unchanged but any difference as at least one", () => {
		let moved = "# Snooze\n\nAn hour.\n\nFive minutes.\n\nFifteen minutes.\n";
		expect(changedBlocks(BASE, moved)).toBe(1);
		expect(changedBlocks(BASE, `${BASE}\n`)).toBe(1);
	});
});
