import { expect, test } from "bun:test";
import { message } from "./policy-initial.test-fixtures";
import { addThreadWithOption } from "./policy-terminal.test-fixtures";
import {
	knownChoiceAnswers,
	mockInterpret,
	newChoiceAnswers,
	proposalTriage,
} from "./pipeline-ordinary-save.test-fixtures";
import { hostingState, lowConfidenceResolution } from "./pipeline-commitment.test-fixtures";

test("a noisy Jev commitment can suggest a known option but cannot auto-record", async () => {
	let current = message("noisy-vps-commitment", "We've decided to host it on our own VPS.");
	let state = hostingState();
	let output = await mockInterpret(
		current,
		state,
		proposalTriage("hosting-thread", "commitment", { explicit_resolution: 0.69 }),
		prefix =>
			knownChoiceAnswers(prefix, "hosting-thread", "vps-option", "resolution", {
				chosen_option: 0.87,
				explicit_resolution: 0.53,
			}),
		(result, prefix) => {
			if (!prefix) {
				result.answers.act.confidence = 0.94;
				result.answers.act.probabilities = { commitment: 0.94, proposal: 0.03, other: 0.03 };
				return;
			}
			lowConfidenceResolution("hosting-thread", "vps-option")(result, prefix);
		},
	);
	expect(output.events.map(event => event.type)).toEqual(["settle.suggested"]);
	expect(output.events[0]).toMatchObject({
		threadId: "hosting-thread",
		optionId: "vps-option",
		source: { quote: current.text, start: 0, end: current.text.length, role: "resolution" },
	});
	expect(output.events.some(event => event.type === "decision.recorded")).toBe(false);
});

test("reported and negated commitment variants never settle", async () => {
	let state = hostingState();
	for (
		let [id, text] of [
			["reported-vps-commitment", "Alice said we've decided to host it on our own VPS."],
			["negated-vps-commitment", "We've decided not to host it on our own VPS."],
		] as const
	) {
		let current = message(id, text);
		let output = await mockInterpret(
			current,
			state,
			proposalTriage("hosting-thread", "commitment", { explicit_resolution: 0.69 }),
			prefix =>
				knownChoiceAnswers(prefix, "hosting-thread", "vps-option", "resolution", {
					explicit_resolution: 0.53,
				}),
			lowConfidenceResolution("hosting-thread", "vps-option"),
		);
		expect(output.events).toEqual([]);
	}
});

test("attributed commitments cannot trigger the rescue with strong Jev scores", async () => {
	let state = hostingState();
	state = addThreadWithOption(
		state,
		"email-thread",
		"Which service should send notification emails?",
		"existing-mailgun",
		"Use Mailgun for notification emails.",
	);
	for (
		let [id, text, target, option] of [
			[
				"told-reported-vps-commitment",
				"Alice told me we've decided to host it on our own VPS.",
				"hosting-thread",
				"vps-option",
			],
			[
				"told-reported-new-choice",
				"Alice told me let's do Postmark for notification emails.",
				"email-thread",
				"new",
			],
		] as const
	) {
		let current = message(id, text);
		let output = await mockInterpret(
			current,
			state,
			proposalTriage(target, "commitment", {
				explicit_resolution: 0.98,
				new_option: 0.98,
				c0_owned_unretracted: 0.95,
			}),
			prefix =>
				option === "new"
					? newChoiceAnswers(prefix, target, { explicit_resolution: 0.98 })
					: knownChoiceAnswers(prefix, target, option, "resolution", {
						explicit_resolution: 0.98,
					}),
		);
		expect(output.events).toEqual([]);
	}
});
