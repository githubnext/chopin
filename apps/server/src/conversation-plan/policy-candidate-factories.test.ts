import { expect, test } from "bun:test";
import { applyInference } from "./domain";
import { createCandidateFactories } from "./policy-candidate-factories";
import {
	verificationFrame,
	verificationInput,
} from "./policy-candidate-verification.test-fixtures";
import { stableId } from "./policy-identity";

test.each(["member", "agent"])("factories retain exact %s source and base metadata", author => {
	let input = verificationInput();
	if (author === "agent") input.message.author = { kind: "agent" };
	let { context, entry } = verificationFrame(input);
	let factories = createCandidateFactories(context, entry, () => context.working);
	if (input.message.author.kind === "system") throw new Error("expected source author");
	expect(factories.source("verification")).toEqual({
		messageId: input.message.id,
		author: input.message.author,
		quote: entry.candidate.quote,
		start: entry.candidate.start,
		end: entry.candidate.end,
		role: "verification",
	});
	expect(factories.base("provider", "settle.resumed")).toEqual({
		id: stableId(input.channelId, input.message.id, entry.index, "settle.resumed"),
		threadId: "provider",
		observedThreadVersion: context.working.threads[0]!.version,
		origin: author === "agent" ? "planner" : "classifier",
		actor: { kind: author === "agent" ? "agent" : "classifier" },
		at: input.message.ts,
	});
	expect(factories.base("missing", "reason.added").observedThreadVersion).toBe(0);
});

test("base reads active local working on every call after a real inferred update", () => {
	let { context, entry } = verificationFrame();
	let working = context.working;
	let reads = 0;
	let factories = createCandidateFactories(context, entry, () => {
		reads++;
		return working;
	});
	expect(reads).toBe(0);
	factories.source("constraint");
	expect(reads).toBe(0);
	let before = factories.base("provider", "constraint.added");
	working = applyInference(working, {
		...before,
		type: "constraint.added",
		source: factories.source("constraint"),
		contribution: {
			id: "constraint",
			text: entry.candidate.quote,
			authoring: "quoted",
			targetId: "provider",
		},
	}, context.message);
	let after = factories.base("provider", "settle.resumed");
	expect(after.observedThreadVersion).toBe(before.observedThreadVersion + 1);
	expect(context.working.threads[0]!.version).toBe(before.observedThreadVersion);
	expect(reads).toBe(2);
});

test("source keeps captured object references while base retains candidate-index identity", () => {
	let { context, entry } = verificationFrame();
	entry.index = 2;
	let factories = createCandidateFactories(context, entry, () => context.working);
	let originalMessage = context.message;
	let originalCandidate = entry.candidate;
	context.input.message = { ...originalMessage, id: "replacement" };
	context.input.candidates[0] = { ...originalCandidate, quote: "replacement" };
	originalCandidate.quote = "Captured object changed.";
	originalMessage.ts = 1001;
	expect(factories.source("reason").quote).toBe("Captured object changed.");
	if (originalMessage.author.kind === "system") throw new Error("expected source author");
	expect(factories.source("reason").author).toBe(originalMessage.author);
	expect(factories.source("reason").messageId).toBe(originalMessage.id);
	expect(factories.base("provider", "reason.added").id).toBe(
		stableId("channel", originalMessage.id, 2, "reason.added"),
	);
	expect(factories.base("provider", "reason.added").at).toBe(1001);
});
