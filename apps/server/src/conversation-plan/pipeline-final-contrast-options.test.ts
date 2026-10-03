import { expect, test } from "bun:test";
import { planEvents } from "./policy";
import { confidentChoice, first, follow, message } from "./policy-initial.test-fixtures";
import { planD03ContrastiveM2, stateWithOptions } from "./pipeline-contrast.test-fixtures";

test("D04's R2 follow-up stays an option despite a comma and terminal or", () => {
	let threadId = "upload-originals";
	let text = "is R2 still worth comparing, or did we rule it out?";
	let current = message("m4", text, "Teo");
	let state = stateWithOptions(
		"Where should image originals live?",
		threadId,
		[
			{ id: "s3", text: "S3 object storage" },
			{ id: "shared-disk", text: "the existing shared disk" },
		],
	);
	let result = planEvents({
		channelId: "channel",
		message: current,
		state,
		first: {
			...first({ new_option: 0.97 }),
			act: confidentChoice("proposal"),
			thread_target: confidentChoice(threadId),
			significance: {
				type: "score",
				score: 2,
				confidence: 0.95,
				legend: { "0": "chatter", "1": "minor", "2": "useful", "3": "work" },
				probabilities: { "0": 0, "1": 0.05, "2": 0.9, "3": 0.05 },
			},
		},
		candidates: [{
			quote: text,
			start: 0,
			end: 51,
			answers: {
				...follow({ role: "option", thread: threadId }),
				option: confidentChoice("new"),
				chosen_option: confidentChoice("new"),
				new_option: { type: "noul", noul: 0.99 },
				planning_substance: { type: "noul", noul: 0.99 },
				duplicate: { type: "noul", noul: 0.01 },
			},
		}],
	});
	expect(result.events.map(event => event.type)).toEqual(["option.added"]);
	expect(result.events[0]).toMatchObject({
		type: "option.added",
		threadId,
		source: {
			messageId: "m4",
			author: { kind: "member", handle: "Teo" },
			quote: text,
			start: 0,
			end: 51,
			role: "option",
		},
		contribution: { text, authoring: "quoted", targetId: threadId },
	});
});

test("D03's contrastive m2 cannot add a fourth option when classified option/new", () => {
	let { result } = planD03ContrastiveM2("option");
	expect(result.events.filter(event => event.type === "option.added")).toEqual([]);
});

test("D03's contrastive m2 can remain a reason when independently classified", () => {
	let { result, current, relayId } = planD03ContrastiveM2("reason");
	expect(result.events.map(event => event.type)).toEqual(["reason.added"]);
	expect(result.events[0]).toMatchObject({
		type: "reason.added",
		threadId: "notification-thread",
		source: { quote: current.text, role: "reason" },
		contribution: { targetId: relayId },
	});
});
