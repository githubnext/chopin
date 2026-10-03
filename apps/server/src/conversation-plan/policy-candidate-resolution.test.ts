import { expect, test } from "bun:test";
import { applyInference, replay } from "./domain";
import { applyEvent } from "./events";
import { decidedInput } from "./policy-candidate-stance.test-fixtures";
import { pendingChoice } from "./policy-candidate-scoped.test-fixtures";
import {
	confidentChoice,
	resolutionFrame,
	resolutionInput,
} from "./policy-candidate-resolution.test-fixtures";
import { runResolution } from "./policy-candidate-resolution";

test.each([{ marker: 0.8, follow: 0.85 }, { marker: 0.799, follow: 0.85 }, {
	marker: 0.8,
	follow: 0.849,
}])("credibility markers $marker/$follow", ({ marker, follow }) => {
	let input = resolutionInput();
	input.first.explicit_resolution = { type: "noul", noul: marker };
	input.candidates[0]!.answers.explicit_resolution = { type: "noul", noul: follow };
	let { context, entry, role } = resolutionFrame(input);
	expect(role.role).toBe("resolution");
	let result = runResolution(context, entry, role);
	if (marker === 0.8 && follow === 0.85) {
		expect(result?.proposed).toMatchObject({
			type: "settle.suggested",
			source: { role: "resolution" },
			optionId: "alpha",
		});
		let accepted = applyInference(input.state, result!.proposed!, input.message);
		expect(replay(accepted.events)).toEqual(accepted);
	} else {
		expect(result).toBeUndefined();
		expect(entry.outcome.gate).toBe("settle authority unclear");
	}
	expect(context.events).toHaveLength(0);
});
test("commitment supplies credibility without resolution markers", () => {
	let input = resolutionInput();
	input.first.act = confidentChoice("commitment");
	input.first.explicit_resolution = { type: "noul", noul: 0 };
	input.candidates[0]!.answers.explicit_resolution = { type: "noul", noul: 0 };
	let { context, entry, role } = resolutionFrame(input);
	expect(runResolution(context, entry, role)?.proposed?.type).toBe("settle.suggested");
});
test("captured strong recommendation survives later classifier changes", () => {
	let input = resolutionInput();
	input.message.text = "We should use Alpha.";
	Object.assign(input.candidates[0]!, {
		quote: input.message.text,
		end: input.message.text.length,
	});
	input.first.explicit_resolution = { type: "noul", noul: 0 };
	input.candidates[0]!.answers.explicit_resolution = { type: "noul", noul: 0 };
	input.candidates[0]!.answers.support = { type: "noul", noul: 0.8 };
	let { context, entry, role } = resolutionFrame(input);
	expect(role.strongRecommendation).toBe(true);
	context.first.act = confidentChoice("none");
	expect(runResolution(context, entry, role)?.proposed?.type).toBe("settle.suggested");
});
test.each(["missing", "decided", "discarded"])("resolution target %s is handled", status => {
	let input = resolutionInput();
	if (status === "missing") input.candidates[0]!.answers.thread = confidentChoice("missing");
	if (status === "decided") input.state = decidedInput().state;
	if (status === "discarded") {
		input.state = applyEvent(input.state, {
			id: "discard",
			type: "thread.discarded",
			threadId: "provider",
			observedThreadVersion: input.state.threads[0]!.version,
			origin: "human",
			actor: { kind: "member", handle: "Jules" },
			at: 1000,
		});
	}
	if (status !== "discarded") {
		let { context, entry, role } = resolutionFrame(input);
		expect(runResolution(context, entry, role)).toBeUndefined();
		expect(entry.outcome.gate).toBe("settle target needs review");
	} else {
		let { context, entry, role } = resolutionFrame();
		// Synthetic frame control: original role capture skips an already discarded target.
		context.working = input.state;
		role.thread = input.state.threads[0]!;
		expect(replay(input.state.events)).toEqual(input.state);
		expect(runResolution(context, entry, role)).toBeUndefined();
		expect(entry.outcome.gate).toBe("settle target needs review");
	}
});
test.each(["We have decided not to use Alpha.", "Let's use Alpha without backups."])(
	"negative chosen source is handled: %s",
	quote => {
		let input = resolutionInput();
		input.message.text = quote;
		Object.assign(input.candidates[0]!, { quote, end: quote.length });
		let { context, entry, role } = resolutionFrame(input);
		expect(runResolution(context, entry, role)).toBeUndefined();
		expect(entry.outcome.status).toBe("review");
		expect(entry.outcome.gate).toBe("chosen option needs review");
	},
);
test.each([{ beta: false, withdrawn: false }, { beta: true, withdrawn: false }, {
	beta: false,
	withdrawn: true,
}])("current pending choice $beta/$withdrawn", ({ beta, withdrawn }) => {
	let input = resolutionInput(beta);
	pendingChoice(input, withdrawn);
	expect(replay(input.state.events)).toEqual(input.state);
	let { context, entry, role } = resolutionFrame(input);
	let result = runResolution(context, entry, role);
	if (withdrawn) expect(result?.proposed?.type).toBe("settle.suggested");
	else {
		expect(result).toBeUndefined();
		expect(entry.outcome.status).toBe(beta ? "review" : "ignored");
		expect(entry.outcome.gate).toBe(
			beta ? "competing choice needs review" : "settle already pending",
		);
	}
});
test("current competing-target set blocks an otherwise valid choice", () => {
	let { context, entry, role } = resolutionFrame();
	context.candidateRun!.competingMessageTargets.add("provider");
	expect(runResolution(context, entry, role)).toBeUndefined();
	expect(entry.outcome.gate).toBe("competing choice needs review");
});
test("fresh chosen answer materializes despite the earlier captured chosen ID", () => {
	let { context, entry, role } = resolutionFrame();
	expect(role.chosenOption).toBe("alpha");
	entry.candidate.answers.chosen_option = confidentChoice("beta");
	expect(runResolution(context, entry, role)).toBeUndefined();
	expect(context.events.map(event => event.type)).toEqual(["option.added", "settle.suggested"]);
	expect(context.working.threads[0]!.pendingSettle?.optionId).toBe("beta");
});
test.each(["removed", "restored"])("fresh card lookup overrides captured card: %s", variant => {
	let input = resolutionInput(true), card = input.linkedCards!.get("provider")!;
	if (variant === "restored") {
		input.linkedCards = new Map([["provider", { ...card, cardId: "stale" }]]);
	}
	let { context, entry, role } = resolutionFrame(input);
	let captured = role.linkedCard;
	context.input.linkedCards = variant === "removed" ? new Map() : new Map([["provider", card]]);
	expect(runResolution(context, entry, role)).toBeUndefined();
	expect(role.linkedCard).toBe(captured);
	if (variant === "removed") {
		expect(entry.outcome.gate).toBe("chosen option needs review");
		expect(context.events).toHaveLength(0);
	} else expect(context.events).toHaveLength(2);
});
