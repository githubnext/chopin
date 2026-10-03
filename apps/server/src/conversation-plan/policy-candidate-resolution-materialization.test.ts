import { expect, test } from "bun:test";
import { replay } from "./domain";
import { resolutionFrame, resolutionInput } from "./policy-candidate-resolution.test-fixtures";
import { runResolution } from "./policy-candidate-resolution";

test("linked card materialization stages versions then publishes the applied state", () => {
	let input = resolutionInput(true);
	expect(replay(input.state.events)).toEqual(input.state);
	let { context, entry, role } = resolutionFrame(input);
	let version = role.thread!.version;
	expect(runResolution(context, entry, role)).toBeUndefined();
	expect(context.events.map(event => event.observedThreadVersion)).toEqual([version, version + 1]);
	expect(context.events[0]!).toMatchObject({
		type: "option.added",
		source: { role: "option" },
		contribution: { id: "beta", text: "Beta", authoring: "scribe", targetId: "provider" },
	});
	expect(context.events[1]!).toMatchObject({
		type: "settle.suggested",
		source: { role: "resolution" },
		optionId: "beta",
	});
	expect(context.working.threads[0]!.version).toBe(version + 2);
	expect(entry.outcome.status).toBe("accepted");
	expect(entry.outcome.eventIds).toEqual(context.events.map(event => event.id));
	expect(replay(context.working.events)).toEqual(context.working);
});
