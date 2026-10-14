import { expect, test } from "bun:test";
import { executionAllowed } from "./execution";
import { initial } from "./state";
import { parseDocumentDevelopmentInput } from "./schema";

let input = parseDocumentDevelopmentInput({
	messageId: "m1",
	revision: 0,
	decisionHash: `sha256:${"a".repeat(64)}`,
	capacity: { additions: 48, characters: 12000 },
	source: "",
	messages: [{ id: "m1", author: "ana", text: "Explore the decision terminology." }],
	passages: [],
	decisions: [],
});

test("owner recovery cannot execute a durably paused or replaced admission", () => {
	let state = { ...initial(), pending: { input } };
	let job = { id: "job-1", input };
	expect(executionAllowed({ documentDevelopment: state }, job)).toBe(true);
	expect(executionAllowed({ documentDevelopment: state }, {
		...job,
		input: Object.fromEntries(Object.entries(input).toReversed()),
	})).toBe(true);
	expect(executionAllowed({ documentDevelopment: { ...state, paused: true } }, job)).toBe(false);
	expect(executionAllowed({ documentDevelopment: initial() }, job)).toBe(false);
	expect(executionAllowed({}, job)).toBe(false);
	expect(executionAllowed(undefined, job)).toBe(false);
	expect(executionAllowed({
		documentDevelopment: {
			...state,
			pending: { input, jobId: "different-job" },
		},
	}, job)).toBe(false);
	expect(executionAllowed({ documentDevelopment: state }, {
		...job,
		input: { ...input, revision: 1 },
	})).toBe(false);
});

test("execution checks the live and persisted implementation locks", () => {
	let documentDevelopment = { ...initial(), pending: { input, jobId: "job-1" } };
	let job = { id: "job-1", input };
	for (let lock of [{ claiming: true }, { execution: {} }, { builds: [{ state: "running" }] }]) {
		expect(executionAllowed({ documentDevelopment, ...lock }, job)).toBe(false);
	}
	expect(
		executionAllowed({ documentDevelopment, builds: [{ state: "running", kind: "rebuild" }] }, job),
	)
		.toBe(true);
});
