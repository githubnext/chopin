import { expect, test } from "bun:test";
import { planEvents } from "./policy";
import { extractQuotes } from "./quotes";
import { confidentChoice, first, follow, message } from "./policy-initial.test-fixtures";
import { stateWithOption } from "./policy-terminal.test-fixtures";

test("declarative option capture refuses attribution, negation, withdrawal, ambiguity, and repeats", () => {
	let state = stateWithOption(
		"How should we provide agent access?",
		"access-thread",
		"existing-access",
		"Use a hosted gateway.",
	);
	let duplicateState = stateWithOption(
		"How should we provide agent access?",
		"access-thread",
		"existing-access",
		"Copilot.",
	);
	let plain = "By agent access I mean Copilot or bring-your-own API keys.";
	let assess = (
		text: string,
		overrides: {
			first?: Record<string, any>;
			second?: Record<string, any>;
			triage?: Record<string, any>;
		} = {},
		candidateState = state,
	) => {
		let current = message(`guard-${text}`, text);
		return planEvents({
			channelId: "channel",
			message: current,
			state: candidateState,
			first: {
				...first({ new_option: 0.96 }),
				thread_target: confidentChoice("access-thread"),
				...overrides.triage,
			},
			candidates: extractQuotes(text).map((quote, index) => ({
				...quote,
				answers: {
					...follow({ role: "none", thread: "access-thread" }),
					new_option: { type: "noul", noul: 0.93 },
					duplicate: { type: "noul", noul: 0.04 },
					...(index ? overrides.second : overrides.first),
				},
			})),
		});
	};
	for (
		let text of [
			"Bob said, by agent access I mean Copilot or bring-your-own API keys.",
			"By agent access I mean not Copilot or bring-your-own API keys.",
			`${plain} Actually, I take that back.`,
			"By agent access I mean Copilot or Copilot.",
		]
	) {
		expect(extractQuotes(text)).not.toEqual([
			{ quote: "Copilot", start: 23, end: 30 },
			{ quote: "bring-your-own API keys", start: 34, end: 57 },
		]);
		expect(assess(text).events).toEqual([]);
	}
	expect(assess(plain, {}, duplicateState).events).toEqual([]);
	expect(assess(plain, { triage: { thread_target: confidentChoice("new") } }).events)
		.toEqual([]);
	expect(
		assess(plain, { triage: { c1_owned_unretracted: { type: "noul", noul: 0.2 } } })
			.events,
	).toEqual([]);
	expect(assess(plain, { second: { thread: confidentChoice("none") } }).events).toEqual([]);
	expect(
		assess(plain, { second: { duplicate: { type: "noul", noul: 0.95 } } })
			.events,
	).toEqual([]);
});
