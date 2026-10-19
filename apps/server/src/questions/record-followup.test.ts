import { expect, test } from "bun:test";
import { normalizeRecord } from "./records";
import { seed } from "./text-response.test-fixtures";

let target = [{ epoch: "epoch", position: "AA==", digest: `sha256:${"a".repeat(64)}` }];
let scope = "01J00000000000000000000000";

test("anchored capture continuation metadata survives record normalization", () => {
	let record = {
		...seed().record,
		origin: "planner",
		followUp: { scope, target, appliedGeneration: 2 },
	};
	expect(normalizeRecord(record).followUp).toEqual({ scope, target, appliedGeneration: 2 });
	expect(normalizeRecord(seed().record).followUp).toBeUndefined();
});

test.each([
	null,
	{ scope: "not-a-scope", target },
	{ scope, target: [] },
	{ scope, target: [{ ...target[0], position: "not base64" }] },
	{ scope, target, appliedGeneration: -1 },
	{ scope, target, appliedGeneration: 1.5 },
	{ scope, target, extra: true },
])("invalid continuation metadata rejects the stored record (%j)", followUp => {
	expect(() => normalizeRecord({ ...seed().record, origin: "planner", followUp }))
		.toThrow(/invalid question record/);
});
