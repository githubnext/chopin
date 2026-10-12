import { expect, test } from "bun:test";
import { experimentTools } from "./experiment-tools";
import { refusal } from "./job-scope";
import type { DocumentRoom } from "./tools";

test("only current server-authenticated member identity attributes a proposal", async () => {
	let received: unknown;
	let room = {
		investigations: {
			propose: async (input: unknown) => {
				received = input;
				return { state: "requested" };
			},
		},
		currentMemberRequest: () => ({ userId: "actual-user", entryId: "actual-message" }),
	} as unknown as DocumentRoom;
	let call = () =>
		experimentTools.propose_investigation.execute!({ brief: "Measure startup", key: "first" }, {
			context: { room },
			toolCallId: "test",
			messages: [],
		});
	expect(await call()).toContain("requested");
	expect(received).toEqual({
		brief: "Measure startup",
		key: "first",
		userId: "actual-user",
		entryId: "actual-message",
	});
	let after = { index: 2, digest: `sha256:${"a".repeat(64)}` };
	await experimentTools.propose_investigation.execute!(
		{ brief: "Measure startup", key: "first", after },
		{ context: { room }, toolCallId: "test", messages: [] },
	);
	expect(received).toMatchObject({ after });
	room.currentMemberRequest = () => undefined;
	expect(await call()).toContain("current member request");
	expect(refusal({ kind: "heading" } as never, "propose_investigation")).toContain("not available");
});
