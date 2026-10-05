import { expect, test } from "bun:test";
import type { JevQuestion } from "./jev";
import {
	buildCandidateTargetingRequest,
	buildTargetingRequest,
	buildTriageRequest,
	QUESTION_SET_VERSION,
} from "./questions";
import { extractQuotes } from "./quotes";
import { seeded, settledBy } from "./interpret.test-fixtures";
import { message } from "./policy-initial.test-fixtures";

test("mixed-message assent names the unique pending choice in its own targeting questions", () => {
	let current = message(
		"mixed-assent",
		"Sounds good to me. What about agent access? Copilot? BYO API keys?",
		"alice",
	);
	let prior = message("prior-proposal", "Let's just go with the optional outline.", "bob");
	let request = buildTargetingRequest(
		current,
		[prior],
		settledBy(seeded(), "bob").threads,
		extractQuotes(current.text),
	);
	let state = request.state as {
		recent: Array<{ text: string }>;
		candidates: Array<{ quote: string }>;
	};
	expect(state.recent.at(-1)?.text).toBe(prior.text);
	expect(state.candidates.map(candidate => candidate.quote)).toEqual([
		"Sounds good to me.",
		"What about agent access?",
		"Copilot?",
		"BYO API keys?",
	]);
	let target = request.questions.c0_thread as Extract<JevQuestion, { type: "choice" }>;
	expect(target.instructions).toContain("candidates[0].quote");
	expect(target.instructions).toContain("later clauses");
	expect(target.criteria["thread-a"].toLowerCase()).toContain("pending proposal to settle");
	expect(target.criteria["thread-a"]).toContain("Use an optional outline.");
	let agreement = request.questions.c0_agrees_with_settle;
	expect(agreement?.instructions).toContain("candidates[0].quote");
	expect(agreement?.instructions).toContain("Use an optional outline.");
	expect(agreement?.instructions).toContain("bob");
	expect(agreement?.instructions).toContain("later clauses");
	expect(agreement?.instructions).toContain("quoted");
	expect(agreement?.instructions).toContain("sarcasm");
});

test("v5 triage checks exact quote ownership while targeting isolates each clause", () => {
	let current = message(
		"mixed-assent",
		"Sounds good to me. What about agent access? Copilot? BYO API keys?",
		"Jules",
	);
	let recent = [
		message("purpose", "We need to figure out auth.", "Mina"),
		message("alternatives", "Auth0, custom login, or GitHub auth?", "Jules"),
		message("proposal", "Let's just go with GitHub.", "Mina"),
	];
	let quotes = extractQuotes(current.text);
	let state = settledBy(seeded(), "Mina");
	let triage = buildTriageRequest(current, recent, state.threads, quotes);
	expect(QUESTION_SET_VERSION).toBe("conversation-plan-9");
	expect(Object.keys(triage.questions).filter(key => key.endsWith("_owned_unretracted")))
		.toEqual([
			"c0_owned_unretracted",
			"c1_owned_unretracted",
			"c2_owned_unretracted",
			"c3_owned_unretracted",
		]);
	expect(
		(triage.state as { candidates: Array<{ quote: string; start: number; end: number }> })
			.candidates,
	).toEqual(quotes);
	for (let index = 0; index < quotes.length; index++) {
		let request = buildCandidateTargetingRequest(
			current,
			recent,
			state.threads,
			quotes,
			index,
		);
		let visible = request.state as {
			current: { id: string; text: string };
			preceding?: string;
			recent: Array<{ id: string }>;
			candidates: Array<{ quote: string; start: number; end: number }>;
		};
		expect(Object.keys(request.questions).every(key => key.startsWith(`c${index}_`)))
			.toBe(true);
		expect(visible.current).toMatchObject({ id: current.id, text: quotes[index]!.quote });
		expect(visible.candidates.at(-1)).toEqual(quotes[index]);
		expect(visible.candidates).toHaveLength(index + 1);
		expect(visible.recent.map(entry => entry.id)).toEqual(recent.map(entry => entry.id));
		expect(visible.preceding ?? "").toBe(
			current.text.slice(0, quotes[index]!.start)
				.slice(-300),
		);
		if (index < 3) expect(JSON.stringify(request.state)).not.toContain("BYO API keys?");
	}
});
