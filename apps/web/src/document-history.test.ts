import { describe, expect, test } from "bun:test";

import { historyAge, historyEntries, historyExact, historyGap } from "./document-history";

const NOW = new Date(2026, 9, 14, 11, 30);

function at(day: number, hour: number, minute = 0, month = 9, year = 2026): string {
	return new Date(year, month, day, hour, minute).toISOString();
}

describe("document history", () => {
	test("ages read tersely, then fall back to the date", () => {
		expect(historyAge(at(14, 11, 30), NOW, "en-US")).toBe("now");
		expect(historyAge(at(14, 11, 28), NOW, "en-US")).toBe("2m");
		expect(historyAge(at(14, 8, 10), NOW, "en-US")).toBe("3h");
		expect(historyAge(at(10, 9), NOW, "en-US")).toBe("4d");
		expect(historyAge(at(30, 9, 0, 8), NOW, "en-US")).toBe("2w");
		expect(historyAge(at(1, 9, 0, 6), NOW, "en-US")).toBe("Jul 1");
		expect(historyAge(at(30, 9, 0, 11, 2025), NOW, "en-US")).toBe("Dec 30, 2025");
	});

	test("exact times name the day and minute", () => {
		expect(historyExact(at(11, 11, 17), NOW, "en-US")).toBe("Oct 11 at 11:17 AM");
	});

	test("gaps grow with elapsed time and stop at a cap", () => {
		expect(historyGap(at(14, 11), at(14, 11))).toBe(0);
		expect(historyGap(at(14, 11), at(14, 10))).toBeLessThan(historyGap(at(14, 11), at(13, 11)));
		expect(historyGap(at(14, 11), at(1, 11, 0, 0))).toBe(5);
	});

	test("lists sessions newest first, the newest current, creation last", () => {
		let entries = historyEntries({
			created: { at: at(10, 8), author: { login: "mona" } },
			versions: [
				{ id: "c", revision: 3, startedAt: at(14, 10), updatedAt: at(14, 11) },
				{
					id: "b",
					revision: 2,
					startedAt: at(14, 8),
					updatedAt: at(14, 9),
					author: { login: "hubot" },
				},
			],
		});
		expect(entries.map(entry => entry.kind)).toEqual(["edits", "edits", "created"]);
		expect(entries[0]).toMatchObject({ kind: "edits", current: true, at: at(14, 11) });
		expect(entries[1]).toMatchObject({ kind: "edits", current: false });
		expect(entries[2]).toEqual({ kind: "created", at: at(10, 8), author: { login: "mona" } });
	});
});
