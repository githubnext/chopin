/** A document whose decisions carry option labels long enough to wrap beside their icons. */

import { createHash } from "node:crypto";

export const PROSE = "The rollout goes team by team, starting with the documentation team.";
export const RESOLVED = "01K0N4TR8K7JGM4R1J7PW4R8YJ";
export const SETTLED = "01K0N4TR8K7JGM4R1J7PW4R8YK";
const RESOLVED_QUESTION = "01K0N4V4E7Y6P4MJ5WD8XZF3B2";
const SETTLED_QUESTION = "01K0N4V4E7Y6P4MJ5WD8XZF3B3";
const AT = "2026-09-23T15:13:00.000Z";

export const CHOSEN =
	"Team by team, starting with the documentation team and widening after a review";
const LABELS = [
	"All at once",
	CHOSEN,
	"Phased over a whole quarter with an opt-in beta for the teams who ask first",
];
export const SETTLED_ANSWER =
	"Keep room state on disk as canonical MDX beside the transcript and its sidecar";

function digest(text: string): string {
	return `sha256:${createHash("sha256").update(`${text}\n`).digest("hex")}`;
}

function optionId(question: string, index: number): string {
	return `${question.slice(0, 22)}${question.slice(-2)}0${index}`;
}

function definition(question: string, prompt: string, labels: string[]) {
	return {
		questions: [{
			id: question,
			header: "Rollout",
			question: prompt,
			multiple: false,
			options: labels.map((label, index) => ({
				id: optionId(question, index),
				label,
				description: "",
			})),
		}],
	};
}

const RESOLVED_CARD = `<Questionnaire id="${RESOLVED}" by="ana" at="${AT}">
<Question id="${RESOLVED_QUESTION}" header="Rollout" prompt="How should we roll this out?" multiple="false">
${
	LABELS.map((label, index) =>
		`<Option id="${optionId(RESOLVED_QUESTION, index)}" label="${label}" />`
	).join("\n")
}
<Answer value="${CHOSEN}" />
</Question>
</Questionnaire>`;

const SETTLED_CARD = `<Questionnaire id="${SETTLED}" by="ana" status="decided">
<Question id="${SETTLED_QUESTION}" header="Storage" prompt="Where should room state live?" multiple="false">
<Option id="${optionId(SETTLED_QUESTION, 0)}" label="${SETTLED_ANSWER}" />
<Answer value="${SETTLED_ANSWER}" choices="${optionId(SETTLED_QUESTION, 0)}" />
</Question>
</Questionnaire>`;

export const SOURCE = `${PROSE}\n\n${RESOLVED_CARD}\n\n${SETTLED_CARD}\n\n${
	"Padding paragraph.\n\n".repeat(20)
}`;

export const STATE = {
	revision: 1,
	questions: [
		{
			id: RESOLVED,
			status: "answered",
			definition: definition(RESOLVED_QUESTION, "How should we roll this out?", LABELS),
			answers: { [RESOLVED_QUESTION]: CHOSEN },
			resolver: "ana",
			at: Date.parse(AT) / 1_000,
			anchors: {
				widget: RESOLVED,
				questions: {
					[RESOLVED_QUESTION]: {
						anchors: [{ epoch: "stale", position: "", digest: digest(PROSE) }],
						pending: false,
					},
				},
			},
		},
		{
			id: SETTLED,
			definition: definition(SETTLED_QUESTION, "Where should room state live?", [SETTLED_ANSWER]),
			status: "answered",
			answers: { [SETTLED_QUESTION]: SETTLED_ANSWER },
			choices: [optionId(SETTLED_QUESTION, 0)],
			resolver: "ana",
			owner: "ana",
			decidedAt: 1_790_000_000,
			history: [],
			optionOrigins: {},
			editors: [],
			origin: "conversation",
		},
	],
};
