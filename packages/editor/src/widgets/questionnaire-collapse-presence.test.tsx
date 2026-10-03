import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { QuestionnaireCard } from "./questionnaire";
import { presenceState } from "../transition-presence";
import type { PresenceState } from "../transition-presence";
import { DECIDED, META } from "./questionnaire-metadata.test-fixtures";

test("card presence keeps its closing content through hidden updates and cancels on reopen", () => {
	let state: PresenceState<string> = {
		immediately: false,
		input: "w",
		phase: "open",
		value: "w",
	};
	state = presenceState(state, { immediately: false, type: "sync", value: undefined });
	expect(state.phase).toBe("closing");
	expect(state.value).toBe("w");

	state = presenceState(state, { immediately: false, type: "sync", value: undefined });
	expect(state.phase).toBe("closing");
	expect(state.value).toBe("w");

	state = presenceState(state, { immediately: false, type: "sync", value: "w" });
	expect(state.phase).toBe("open");
	expect(state.value).toBe("w");
});

test("hidden card presence is closed immediately when motion is disabled", () => {
	let state = presenceState<string>({
		immediately: true,
		input: undefined,
		phase: "closed",
		value: undefined,
	}, { immediately: true, type: "sync", value: undefined });
	expect(state.phase).toBe("closed");
	expect(state.value).toBeUndefined();
});

test("a hidden card renders no visible or focusable content", () => {
	let markup = renderToStaticMarkup(createElement(QuestionnaireCard, {
		meta: { ...META, status: "discarded" },
		value: DECIDED,
	}));
	expect(markup).toMatch(/^<div[^>]*data-card-hidden=""[^>]*hidden=""[^>]*><\/div>$/);
	expect(markup).not.toContain("<button");
});

test("a hidden decision with immediate motion policy never mounts a collapse wrapper", () => {
	let markup = renderToStaticMarkup(createElement(QuestionnaireCard, {
		meta: { ...META, hasProse: true },
		motionImmediately: () => true,
		value: DECIDED,
	}));
	expect(markup).toContain('data-card-hidden=""');
	expect(markup).not.toContain("data-decision-collapsing");
});
