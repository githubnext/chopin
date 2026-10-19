import { expect, test } from "bun:test";
import { exploreBrief, findingLine, findingMeta, runningFindings, waitingOn } from "./explore";

import type { Question } from "@chopin/protocol";

let base = { ref: "ref", by: "ana", at: 1 } as const;
let research: Question.Finding = { ...base, id: "r", kind: "research", status: "running" };
let spike: Question.Finding = { ...base, id: "s", kind: "spike", status: "running" };
let ask: Question.Finding = { ...base, id: "a", kind: "ask", status: "running", ref: "sam" };

test("the brief names the question, its options and what to find out", () => {
	expect(exploreBrief("Where should state live?", ["Disk", "SQLite"], " diffing ")).toBe(
		"Where should state live?\n\nOptions under consideration:\n- Disk\n- SQLite\n\nFind out: diffing",
	);
	expect(exploreBrief("Is it true?", [], "")).toBe("Is it true?");
});

test("running findings say what they are doing; settled ones say what they found", () => {
	expect(findingLine(research)).toBe("Researching…");
	expect(findingLine({ ...research, focus: "Drop-off" })).toBe("Drop-off");
	expect(findingLine(spike)).toBe("Building a spike…");
	expect(findingLine(ask)).toBe("Waiting for @sam");
	expect(findingLine({ ...research, status: "ready", title: "Most edit once" })).toBe(
		"Most edit once",
	);
	expect(findingLine({ ...research, status: "failed" })).toBe("Research didn’t finish");
	expect(findingLine({ ...ask, status: "ready", summary: "Objects." })).toBe("Objects.");
});

test("meta counts sources or a branch only once a finding is ready", () => {
	expect(findingMeta(research)).toBeUndefined();
	expect(findingMeta({ ...research, status: "ready", sourceCount: 6 })).toBe("6 sources");
	expect(findingMeta({ ...research, status: "ready", sourceCount: 1 })).toBe("1 source");
	expect(findingMeta({ ...spike, status: "ready", branch: "spike/x" })).toBe("1 branch");
});

test("waiting faces are the asked members who have not replied, once each", () => {
	let again = { ...ask, id: "a2" };
	let replied = { ...ask, id: "a3", ref: "lily", status: "ready" as const };
	expect(waitingOn([research, ask, again, replied])).toEqual(["sam"]);
	expect(runningFindings([research, replied]).map(finding => finding.id)).toEqual(["r"]);
});
