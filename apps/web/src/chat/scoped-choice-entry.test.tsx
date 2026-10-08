import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ScopedChoicePrompt } from "./scoped-choice-entry";
import { applyInference, initialState } from "../../../server/src/conversation-plan/domain";
import { applyEvent } from "../../../server/src/conversation-plan/events";
import {
	cardId,
	scopedInput,
} from "../../../server/src/conversation-plan/policy-candidate-scoped.test-fixtures";

import type { ComponentProps } from "react";
import type { Questionnaire } from "@chopin/dialect";
import type { ConversationPlan } from "@chopin/protocol";

type Props = ComponentProps<typeof ScopedChoicePrompt> & { value?: Questionnaire };

function fixture(): Props {
	let input = scopedInput();
	let message = { ...input.message, text: "I'd pick Beta for a spike;" };
	let source: ConversationPlan.SourceRef = {
		messageId: message.id,
		author: { kind: "member", handle: "Mina" },
		quote: message.text,
		start: 0,
		end: message.text.length,
		role: "support",
	};
	let state = applyInference(input.state, {
		id: "beta-proposal",
		type: "scoped-choice.proposed",
		threadId: "provider",
		observedThreadVersion: input.state.threads[0]!.version,
		origin: "classifier",
		actor: { kind: "classifier" },
		at: 1000,
		source,
		cardId,
		optionId: "beta",
		label: "Beta",
		scope: "spike",
	}, message);
	expect(state.events.reduce(applyEvent, initialState())).toEqual(state);
	return {
		canEdit: true,
		connected: true,
		latest: true,
		state,
		wire: {
			ask: async () => {
				throw new Error("static render must not submit");
			},
			send: () => {},
			on: () => () => {},
		},
		meta: {
			status: "open",
			origin: "planner",
			involved: [],
			history: [],
			optionOrigins: {},
			hasProse: false,
			refining: false,
			proseOrphaned: false,
		},
		value: {
			id: cardId,
			by: "Planner",
			questions: [{
				id: "provider",
				header: "Provider",
				prompt: "Which provider?",
				multiple: false,
				options: [{ id: "alpha", label: "Alpha" }, { id: "beta", label: "Beta" }],
			}],
		},
		decision: {
			kind: "scoped-choice",
			questionnaireId: cardId,
			threadId: "provider",
			proposalId: "beta-proposal",
			cardId,
			optionId: "beta",
			label: "Beta",
			scope: "spike",
			generation: 0,
			triggerEventId: "beta-proposal",
			sources: [source],
		},
	};
}

function render(props: Props): string {
	return renderToStaticMarkup(createElement(ScopedChoicePrompt, props));
}

test("a current linked-card option can be saved without a thread contribution", () => {
	let props = fixture();
	expect(props.state!.threads[0]!.contributions.map(item => item.id)).toEqual(["alpha"]);
	let html = render(props);
	expect(html).not.toContain('disabled=""');
	expect(html).not.toContain("This choice has changed.");
});

test.each(["missing card", "wrong card", "removed option", "changed label", "duplicate option"])(
	"scoped Save fails closed for a %s projection",
	kind => {
		let props = fixture();
		if (kind === "missing card") props.value = undefined;
		else if (kind === "wrong card") props.value!.id = "other-card";
		else if (kind === "removed option") props.value!.questions[0]!.options.pop();
		else if (kind === "changed label") props.value!.questions[0]!.options[1]!.label = "Gamma";
		else props.value!.questions[0]!.options.push({ id: "beta", label: "Beta" });
		expect(render(props)).toContain('disabled=""');
	},
);

test.each(["stale generation", "old prompt", "closed card", "disconnected"])(
	"scoped Save retains its %s guard",
	kind => {
		let props = fixture();
		if (kind === "stale generation") props.decision.generation = 1;
		else if (kind === "old prompt") props.latest = false;
		else if (kind === "closed card") props.meta!.status = "discarded";
		else props.connected = false;
		expect(render(props)).toContain('disabled=""');
	},
);

test("a read-only viewer sees the scoped choice without a Save button", () => {
	let props = fixture();
	props.canEdit = false;
	let markup = render(props);
	expect(markup).toContain("This document is read-only.");
	expect(markup).not.toContain("Save for this spike");
});

test("an already saved scoped choice stays disabled without answering the card", () => {
	let props = fixture();
	props.state = applyEvent(props.state!, {
		id: "human:Rob:save-beta",
		type: "scoped-choice.saved",
		threadId: "provider",
		observedThreadVersion: props.state!.threads[0]!.version,
		origin: "human",
		actor: { kind: "member", handle: "Rob" },
		at: 1001,
		proposalId: "beta-proposal",
		supportEventIds: ["beta-proposal"],
		cardId,
		optionId: "beta",
		label: "Beta",
		scope: "spike",
		sources: props.decision.sources,
		expectedGeneration: 0,
	});
	expect(props.state.events.reduce(applyEvent, initialState())).toEqual(props.state);
	expect(props.state.threads[0]!.status).toBe("exploring");
	let html = render(props);
	expect(html).toContain('disabled=""');
	expect(html).toContain("Saved for this spike");
});
