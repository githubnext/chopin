import { expect, test } from "bun:test";
import { optionIdFor } from "./policy-identity";

// Exact callback: archive 446a9779a937fa5be7cd3eb52fd7f3023d691ed2,
// apps/server/src/conversation-plan/pipeline.test.ts.
// Remaining pipeline callbacks and the D19 policy callback await the complete policy.

test("classifier option IDs are deterministic ULIDs using the message's Unix seconds", () => {
	let id = optionIdFor("channel", "m1", 0, 1_000);
	expect(id).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
	expect(optionIdFor("channel", "m1", 0, 1_000)).toBe(id);
	expect(optionIdFor("channel", "m1", 1, 1_000)).not.toBe(id);
	let alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
	let milliseconds = 0;
	for (let character of id.slice(0, 10)) {
		milliseconds = milliseconds * 32 + alphabet.indexOf(character);
	}
	expect(milliseconds).toBe(1_000_000);
});
