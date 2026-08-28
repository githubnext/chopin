import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { SendAction } from "../send-action";
import { handleResearchComposerKey, ResearchComposer, researchComposerKey } from "./research";

const QUESTION = "Which evidence supports the rollout date?";

type KeyEvent = Parameters<typeof handleResearchComposerKey>[0];
type KeyActions = Parameters<typeof handleResearchComposerKey>[1];

function target(value = QUESTION): KeyEvent["currentTarget"] {
	return {
		readOnly: false,
		value,
		selectionStart: value.length,
		selectionEnd: value.length,
		setRangeText() {},
	};
}

function event(
	calls: string[],
	overrides: Partial<Pick<KeyEvent, "ctrlKey" | "key" | "keyCode" | "metaKey" | "nativeEvent">> & {
		currentTarget?: KeyEvent["currentTarget"];
	} = {},
): KeyEvent {
	return {
		key: "Enter",
		keyCode: 13,
		metaKey: false,
		ctrlKey: false,
		nativeEvent: { isComposing: false },
		currentTarget: target(),
		preventDefault: () => calls.push("prevent"),
		stopPropagation: () => calls.push("stop"),
		...overrides,
	};
}

function actions(calls: string[], dismissible = true): KeyActions {
	return {
		dismissible,
		onChange: value => calls.push(value),
		onDismiss: () => calls.push("dismiss"),
		onSubmit: () => calls.push("submit"),
	};
}

describe("research composer", () => {
	it("maps textarea keys to submit, newline, dismissal, or no action", () => {
		expect(researchComposerKey({
			key: "Enter",
			metaKey: false,
			ctrlKey: false,
			isComposing: false,
		})).toBe("submit");
		expect(researchComposerKey({
			key: "Enter",
			metaKey: true,
			ctrlKey: false,
			isComposing: false,
		})).toBe("newline");
		expect(researchComposerKey({
			key: "Enter",
			metaKey: false,
			ctrlKey: true,
			isComposing: false,
		})).toBe("newline");
		expect(researchComposerKey({
			key: "Enter",
			metaKey: false,
			ctrlKey: false,
			isComposing: true,
		})).toBe("ignore");
		expect(researchComposerKey({
			key: "Escape",
			metaKey: false,
			ctrlKey: false,
			isComposing: false,
		})).toBe("dismiss");
	});

	it("inserts a modifier-Enter newline at the textarea selection", () => {
		let calls: string[] = [];
		let textarea = {
			readOnly: false,
			value: "Evidence here",
			selectionStart: 8,
			selectionEnd: 13,
			setRangeText(replacement: string, start: number, end: number, selectionMode?: SelectionMode) {
				this.value = `${this.value.slice(0, start)}${replacement}${this.value.slice(end)}`;
				this.selectionStart = this.selectionEnd = start + replacement.length;
				calls.push(selectionMode ?? "");
			},
		};

		handleResearchComposerKey(
			event(calls, { currentTarget: textarea, metaKey: true }),
			actions(calls),
		);

		expect(textarea.value).toBe("Evidence\n");
		expect(textarea.selectionStart).toBe(9);
		expect(calls).toEqual(["prevent", "stop", "end", "Evidence\n"]);
	});

	it("does not insert a modifier-Enter newline into locked recovery text", () => {
		let calls: string[] = [];
		let textarea = {
			...target(),
			readOnly: true,
			setRangeText() {
				calls.push("mutate");
			},
		};

		handleResearchComposerKey(
			event(calls, { currentTarget: textarea, metaKey: true }),
			actions(calls, false),
		);

		expect(textarea.value).toBe(QUESTION);
		expect(calls).toEqual(["prevent", "stop"]);
	});

	it("prevents plain Enter and submits without changing the question", () => {
		let calls: string[] = [];
		let textarea = {
			...target(),
			setRangeText: () => calls.push("mutate"),
		};

		handleResearchComposerKey(event(calls, { currentTarget: textarea }), actions(calls));

		expect(calls).toEqual(["prevent", "stop", "submit"]);
	});

	it("leaves composing Enter untouched, including the final keyCode 229 event", () => {
		for (
			let composing of [
				{ nativeEvent: { isComposing: true }, keyCode: 13 },
				{ nativeEvent: { isComposing: false }, keyCode: 229 },
			]
		) {
			let calls: string[] = [];
			handleResearchComposerKey(event(calls, composing), actions(calls));
			expect(calls).toEqual([]);
		}
	});

	it("renders one accessible circular send action", () => {
		let markup = renderToStaticMarkup(createElement(SendAction, {
			label: "Start research",
			onClick() {},
		}));

		expect(markup).toContain('aria-label="Start research"');
		expect(markup).toContain('title="Start research"');
		expect(markup).toContain("send-action btn btn-icon btn-primary rounded-full");
		expect(markup).toContain('aria-hidden="true"');
		expect(markup).toContain('width="16" height="16"');
	});

	it("keeps one exact brief actionable after a failed create", () => {
		let markup = renderToStaticMarkup(createElement(ResearchComposer, {
			question: QUESTION,
			error: "Research could not be started.",
			onCancel() {},
			onChange() {},
			onSubmit() {},
		}));

		expect(markup).toContain("Research question");
		expect(markup).toContain(QUESTION);
		expect(markup).toContain("Research could not be started.");
		expect(markup).toContain("Start research");
		expect(markup).toContain("Discard research question");
		expect(markup).not.toContain(">Cancel<");
		expect((markup.match(/textarea/g) ?? []).length).toBe(2);
	});

	it("locks the question and controls while submission is in flight", () => {
		let markup = renderToStaticMarkup(createElement(ResearchComposer, {
			question: QUESTION,
			onCancel() {},
			onChange() {},
			onSubmit() {},
			submitting: true,
		}));

		expect(markup).toMatch(/<textarea[^>]*disabled=""/);
		expect((markup.match(/<button[^>]*disabled=""/g) ?? []).length).toBe(1);
		expect(markup).toContain('aria-label="Start research"');
		expect(markup).toContain('aria-busy="true"');
		expect(markup).not.toContain("Starting…");
		expect(markup).not.toContain("Discard research question");
	});

	it("explains why submission is unavailable without a collaboration anchor", () => {
		let markup = renderToStaticMarkup(createElement(ResearchComposer, {
			question: QUESTION,
			blocked: "Connect to the document before starting research.",
			onCancel() {},
			onChange() {},
			onSubmit() {},
		}));

		expect(markup).toContain("Connect to the document before starting research.");
		expect(markup).toMatch(/<button[^>]*aria-label="Start research"[^>]*disabled=""/);
	});

	it("exposes no placement or cancellation mutation for read-only created recovery", () => {
		let markup = renderToStaticMarkup(createElement(ResearchComposer, {
			question: QUESTION,
			blocked: "Reconnect with edit access to place this research.",
			cancelDisabled: true,
			cancelLabel: "Cancel research",
			dismissible: false,
			questionLocked: true,
			submitLabel: "Place research",
			onCancel() {},
			onChange() {},
			onSubmit() {},
		}));

		expect(markup).toContain("Place research");
		expect(markup).toContain("Cancel research");
		expect(markup).toMatch(/<textarea[^>]*readOnly=""/);
		expect((markup.match(/disabled=""/g) ?? []).length).toBe(2);
	});

	it("turns Escape into a composer dismissal", () => {
		let calls: string[] = [];
		handleResearchComposerKey(
			event(calls, { key: "Escape", keyCode: 27 }),
			{ ...actions(calls), onDismiss: () => calls.push("escape") },
		);
		expect(calls).toEqual(["prevent", "stop", "escape"]);
	});

	it("does not dismiss an in-flight composer on Escape", () => {
		let calls: string[] = [];
		handleResearchComposerKey(
			event(calls, { key: "Escape", keyCode: 27 }),
			{ ...actions(calls, false), onDismiss: () => calls.push("escape") },
		);
		expect(calls).toEqual(["prevent", "stop"]);
	});
});
