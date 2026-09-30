import { expect, test } from "bun:test";
import type { Chat, ConversationPlan } from "@chopin/protocol";
import { initialState } from "./domain";
import { interpretMessage } from "./interpret";
import type { JevAnswer, JevRequest } from "./jev";
import { cacheMessage, cacheQuotes, emptyCacheThread } from "./question-builder.test-fixtures";

// Whole final outer loop from archive446a9779a937fa5be7cd3eb52fd7f3023d691ed2, questions.test.ts.
for (let hasPrior of [false, true]) {
	test(`interpretation ${hasPrior ? "accepts true" : "omits unasked"} duplicate evidence`, async () => {
		let requests: JevRequest[] = [];
		let earlier: Chat.Entry = {
			...cacheMessage,
			id: "cache-earlier-option",
			text: cacheQuotes[0]!.quote,
			ts: cacheMessage.ts - 1,
		};
		let thread: ConversationPlan.Thread = hasPrior
			? {
				...emptyCacheThread,
				contributions: [{
					id: "cache-redis-option",
					kind: "option",
					text: cacheQuotes[0]!.quote,
					authoring: "quoted",
					sources: [{
						messageId: earlier.id,
						author: { kind: "member", handle: "Ari" },
						quote: earlier.text,
						start: 0,
						end: earlier.text.length,
						role: "option",
					}],
					actor: { kind: "classifier" },
				}],
			}
			: emptyCacheThread;
		let interpreted = await interpretMessage({
			channelId: "engineering-cache",
			message: cacheMessage,
			recent: hasPrior ? [earlier] : [],
			state: { ...initialState(), threads: [thread] },
			ask: async request => {
				requests.push(request);
				let answers = Object.fromEntries(
					Object.entries(request.questions).map(([key, question]) => {
						let answer: JevAnswer;
						if (question.type === "noul") {
							answer = {
								type: "noul",
								noul: key === "new_option" || key.endsWith("_owned_unretracted")
										|| hasPrior && key === "c0_duplicate"
									? 0.95
									: 0.05,
							};
						} else if (question.type === "score") {
							answer = {
								type: "score",
								score: 2,
								confidence: 1,
								legend: Object.fromEntries(question.criteria.map((label, index) => [index, label])),
								probabilities: { "0": 0, "1": 0, "2": 1, "3": 0 },
							};
						} else {
							let preferred = key === "act"
								? "proposal"
								: key === "thread_target"
								? "api-cache"
								: key.endsWith("_role")
								? "option"
								: key.endsWith("_thread")
								? "api-cache"
								: key.endsWith("_option")
								? "new"
								: "none";
							let selected = preferred in question.criteria
								? preferred
								: Object.keys(question.criteria)[0]!;
							answer = {
								type: "choice",
								choice: selected,
								confidence: 1,
								probabilities: Object.fromEntries(
									Object.keys(question.criteria).map(value => [
										value,
										Number(value === selected),
									]),
								),
							};
						}
						return [key, answer];
					}),
				);
				return {
					model: "fake-jev",
					answers,
					usage: { input_tokens: 0, output_tokens: 0 },
					latencyMs: 0,
				};
			},
		});
		let targeting = requests.filter(request => !("new_question" in request.questions));
		expect(targeting).toHaveLength(2);
		let pass = interpreted.analysis.passes.find(item => item.stage === "targeting");
		if (hasPrior) {
			expect(targeting[0]?.questions.c0_duplicate?.type).toBe("noul");
			expect(pass?.answers.c0_duplicate).toEqual({ type: "noul", noul: 0.95 });
		} else {
			expect(
				targeting.every(request =>
					Object.keys(request.questions).every(key => !key.endsWith("_duplicate"))
				),
			).toBe(true);
			expect(pass?.answers.c0_duplicate).toBeUndefined();
			expect(pass?.answers.c1_duplicate).toBeUndefined();
		}
	});
}
