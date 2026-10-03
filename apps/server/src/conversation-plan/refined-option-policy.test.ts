import { expect, test } from "bun:test";
import { applyEvent } from "./events";
import { planEvents } from "./policy";
import { stanceInput } from "./policy-candidate-stance.test-fixtures";
import { pendingChoice } from "./policy-candidate-scoped.test-fixtures";
import { buildCandidateTargetingRequest, buildTriageRequest } from "./questions";

function refinedInput(role = "support") {
	let input = stanceInput(role, role === "support" ? "I support Beta." : "I oppose Beta.");
	let thread = input.state.threads[0]!;
	input.state = applyEvent(input.state, {
		id: "refined-option",
		type: "option.relabeled",
		threadId: thread.id,
		observedThreadVersion: thread.version,
		observedCardRevision: 0,
		origin: "planner",
		actor: { kind: "agent" },
		at: 1000,
		optionId: "alpha",
		label: "Beta",
	});
	input.linkedCards!.get("provider")!.options[0]!.label = "Beta";
	return input;
}

test.each(["support", "objection"])(
	"%s names the refined option while retaining its original evidence",
	role => {
		let input = refinedInput(role);
		let option = structuredClone(input.state.threads[0]!.contributions[0]!);
		let result = planEvents(input);
		expect(result.events).toMatchObject([{
			type: "stance.changed",
			optionId: "alpha",
			position: role === "support" ? "support" : "oppose",
			source: { quote: input.message.text },
		}]);
		expect(input.state.threads[0]!.contributions[0]).toEqual(option);
		expect(option).toMatchObject({ text: "Alpha", displayLabel: "Beta" });
		expect(option.sources[0]!.quote).toBe("Alpha");
	},
);

test("interpretation context names the refined option and pending choice without changing evidence", () => {
	let input = refinedInput();
	pendingChoice(input);
	let original = structuredClone(input.state);
	let triage = buildTriageRequest(
		input.message,
		[],
		input.state.threads,
		input.candidates,
		input.state.events,
	);
	let targeting = buildCandidateTargetingRequest(
		input.message,
		[],
		input.state.threads,
		input.candidates,
		0,
		input.state.events,
		input.linkedCards,
	);
	for (let request of [triage, targeting]) {
		let state = request.state as {
			threads: Array<{
				options: Array<{ id: string; text: string }>;
				pendingSettle?: { optionId: string; option: string };
			}>;
		};
		expect(state.threads[0]!.options).toEqual([{ id: "alpha", text: "Beta" }]);
		expect(state.threads[0]!.pendingSettle).toMatchObject({
			optionId: "alpha",
			option: "Beta",
		});
	}
	expect(input.state).toEqual(original);
});
