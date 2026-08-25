import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createHeadlessEditor } from "@lexical/headless";
import {
	$createNodeSelection,
	$createParagraphNode,
	$createRangeSelection,
	$createTextNode,
	$getNodeByKey,
	$getRoot,
	$getSelection,
	$isNodeSelection,
	$isRangeSelection,
	$setSelection,
	COMMAND_PRIORITY_LOW,
	DELETE_CHARACTER_COMMAND,
	DELETE_LINE_COMMAND,
	DELETE_WORD_COMMAND,
	REMOVE_TEXT_COMMAND,
} from "lexical";

import { $createResearchNode, registry } from "@chopin/dialect";
import { register } from "./index";

import type { ComponentType } from "react";
import type { Research } from "@chopin/protocol";

const REQUEST_BASE: Research.RequestViewBase = {
	id: "workspace-one",
	channelId: "document-one",
	question: "Which evidence supports the rollout date?",
	sources: [{ title: "Release notes", url: "https://example.com/releases" }],
	createdAt: "2026-08-24T09:00:00.000Z",
	updatedAt: "2026-08-24T09:01:00.000Z",
};

const BASE: Research.RequestView = { ...REQUEST_BASE, state: "running", stage: "searching" };

function atStage(stage: Research.RequestStage): Research.RequestView {
	if (stage === "failed") {
		return { ...REQUEST_BASE, state: "failed", stage, error: "Research could not be completed." };
	}
	if (stage === "cancelled") return { ...REQUEST_BASE, state: "cancelled", stage };
	if (stage === "ready") {
		return {
			...REQUEST_BASE,
			state: "completed",
			stage,
			child: {
				id: "child-one",
				title: "Rollout evidence",
				slug: "rollout-evidence",
				summary: "Validated report summary",
				sourceCount: 1,
			},
		};
	}
	return { ...REQUEST_BASE, state: "running", stage };
}

type CardProps = {
	request: Research.RequestView;
	openButtonRef?: (button: HTMLButtonElement | null) => void;
	onCancel?: () => void;
	onOpen?: (opener: HTMLElement) => void;
	onRemove?: () => void;
	onRetry?: () => void;
};

type ComposerProps = {
	blocked?: string;
	cancelDisabled?: boolean;
	cancelLabel?: string;
	dismissible?: boolean;
	error?: string;
	onCancel: () => void;
	onChange: (value: string) => void;
	onEscape?: () => void;
	onSubmit: () => void;
	question: string;
	questionLocked?: boolean;
	submitLabel?: string;
	submitting?: boolean;
};

type ComposerKeyHandler = (
	event: {
		key: string;
		metaKey: boolean;
		ctrlKey: boolean;
		nativeEvent: { isComposing: boolean };
		currentTarget: {
			readOnly: boolean;
			value: string;
			selectionStart: number;
			selectionEnd: number;
			setRangeText(
				replacement: string,
				start: number,
				end: number,
				selectionMode: string,
			): void;
		};
		preventDefault(): void;
		stopPropagation(): void;
	},
	actions: {
		dismissible: boolean;
		onChange: (value: string) => void;
		onDismiss: () => void;
		onSubmit: () => void;
	},
) => void;

type Store = {
	subscribe(listener: () => void): () => void;
	retain(id: string): () => void;
	get(id: string): Research.RequestView | undefined;
	mutating(id: string): boolean;
	refresh(id: string): void;
	create(question: string, requestId: string): Promise<Research.RequestView>;
	cancel(id: string): Promise<Research.RequestView>;
	retry(id: string): Promise<Research.RequestView>;
	opener(id: string, current?: HTMLElement | null): { readonly current: HTMLElement | null };
	open(child: Research.ReadyChild, opener: { readonly current: HTMLElement | null }): void;
};

async function deletionGuard() {
	let module = await import("./research") as unknown as {
		registerResearchDeletion?: (
			editor: ReturnType<typeof createHeadlessEditor>,
			store: Store,
		) => () => void;
	};
	expect(typeof module.registerResearchDeletion).toBe("function");
	return module.registerResearchDeletion;
}

function mutableStore(request: Research.RequestView | undefined): {
	set(next: Research.RequestView | undefined): void;
	setMutating(next: boolean): void;
	store: Store;
} {
	let current = request;
	let mutating = false;
	return {
		set: next => current = next,
		setMutating: next => mutating = next,
		store: {
			subscribe: () => () => {},
			retain: () => () => {},
			get: () => current,
			mutating: () => mutating,
			refresh() {},
			create: async () => current ?? BASE,
			cancel: async () => current ?? BASE,
			retry: async () => current ?? BASE,
			opener: () => ({ current: null }),
			open() {},
		},
	};
}

function deletionEditor() {
	let editor = createHeadlessEditor({
		nodes: registry().nodes,
		onError: error => {
			throw error;
		},
	});
	editor.registerCommand(
		DELETE_CHARACTER_COMMAND,
		backward => {
			let selection = $getSelection();
			if ($isNodeSelection(selection)) selection.deleteNodes();
			else if ($isRangeSelection(selection)) selection.deleteCharacter(backward);
			else return false;
			return true;
		},
		COMMAND_PRIORITY_LOW,
	);
	editor.registerCommand(
		DELETE_WORD_COMMAND,
		backward => {
			let selection = $getSelection();
			if (!$isRangeSelection(selection)) return false;
			selection.deleteWord(backward);
			return true;
		},
		COMMAND_PRIORITY_LOW,
	);
	editor.registerCommand(
		DELETE_LINE_COMMAND,
		backward => {
			let selection = $getSelection();
			if (!$isRangeSelection(selection)) return false;
			selection.deleteLine(backward);
			return true;
		},
		COMMAND_PRIORITY_LOW,
	);
	editor.registerCommand(
		REMOVE_TEXT_COMMAND,
		() => {
			let selection = $getSelection();
			if (!$isRangeSelection(selection)) return false;
			selection.removeText();
			return true;
		},
		COMMAND_PRIORITY_LOW,
	);
	return editor;
}

function selectResearch(editor: ReturnType<typeof createHeadlessEditor>): string {
	let key = "";
	editor.update(() => {
		let node = $createResearchNode(BASE.id);
		$getRoot().append(node);
		key = node.getKey();
		let selection = $createNodeSelection();
		selection.add(key);
		$setSelection(selection);
	}, { discrete: true });
	return key;
}

async function components() {
	let module = await import("./research").catch(() => ({}));
	let card = (module as { ResearchCard?: ComponentType<CardProps> }).ResearchCard;
	let composer = (module as { ResearchComposer?: ComponentType<ComposerProps> }).ResearchComposer;
	expect(typeof card).toBe("function");
	expect(typeof composer).toBe("function");
	return { card, composer };
}

async function composerKeyHandler(): Promise<ComposerKeyHandler | undefined> {
	let module = await import("./research") as unknown as {
		handleResearchComposerKey?: ComposerKeyHandler;
	};
	expect(typeof module.handleResearchComposerKey).toBe("function");
	return module.handleResearchComposerKey;
}

describe("research composer", () => {
	it("maps textarea keys to submit, newline, dismissal, or no action", async () => {
		let module = await import("./research") as unknown as {
			researchComposerKey?: (event: {
				key: string;
				metaKey: boolean;
				ctrlKey: boolean;
				isComposing: boolean;
			}) => string;
		};
		expect(typeof module.researchComposerKey).toBe("function");
		if (!module.researchComposerKey) return;

		expect(module.researchComposerKey({
			key: "Enter",
			metaKey: false,
			ctrlKey: false,
			isComposing: false,
		})).toBe("submit");
		expect(module.researchComposerKey({
			key: "Enter",
			metaKey: true,
			ctrlKey: false,
			isComposing: false,
		})).toBe("newline");
		expect(module.researchComposerKey({
			key: "Enter",
			metaKey: false,
			ctrlKey: true,
			isComposing: false,
		})).toBe("newline");
		expect(module.researchComposerKey({
			key: "Enter",
			metaKey: false,
			ctrlKey: false,
			isComposing: true,
		})).toBe("ignore");
		expect(module.researchComposerKey({
			key: "Escape",
			metaKey: false,
			ctrlKey: false,
			isComposing: false,
		})).toBe("dismiss");
	});

	it("inserts a modifier-Enter newline at the textarea selection", async () => {
		let handle = await composerKeyHandler();
		if (!handle) return;
		let calls: string[] = [];
		let textarea = {
			readOnly: false,
			value: "Evidence here",
			selectionStart: 8,
			selectionEnd: 13,
			setRangeText(replacement: string, start: number, end: number, selectionMode: string) {
				this.value = `${this.value.slice(0, start)}${replacement}${this.value.slice(end)}`;
				this.selectionStart = this.selectionEnd = start + replacement.length;
				calls.push(selectionMode);
			},
		};

		handle({
			key: "Enter",
			metaKey: true,
			ctrlKey: false,
			nativeEvent: { isComposing: false },
			currentTarget: textarea,
			preventDefault: () => calls.push("prevent"),
			stopPropagation: () => calls.push("stop"),
		}, {
			dismissible: true,
			onChange: value => calls.push(value),
			onDismiss: () => calls.push("dismiss"),
			onSubmit: () => calls.push("submit"),
		});

		expect(textarea.value).toBe("Evidence\n");
		expect(textarea.selectionStart).toBe(9);
		expect(calls).toEqual(["prevent", "stop", "end", "Evidence\n"]);
	});

	it("does not insert a modifier-Enter newline into locked recovery text", async () => {
		let handle = await composerKeyHandler();
		if (!handle) return;
		let calls: string[] = [];
		let textarea = {
			readOnly: true,
			value: BASE.question,
			selectionStart: BASE.question.length,
			selectionEnd: BASE.question.length,
			setRangeText() {
				calls.push("mutate");
			},
		};

		handle({
			key: "Enter",
			metaKey: true,
			ctrlKey: false,
			nativeEvent: { isComposing: false },
			currentTarget: textarea,
			preventDefault: () => calls.push("prevent"),
			stopPropagation: () => calls.push("stop"),
		}, {
			dismissible: false,
			onChange: () => calls.push("change"),
			onDismiss: () => calls.push("dismiss"),
			onSubmit: () => calls.push("submit"),
		});

		expect(textarea.value).toBe(BASE.question);
		expect(calls).toEqual(["prevent", "stop"]);
	});

	it("renders one accessible circular send action", async () => {
		let module = await import("../send-action").catch(() => ({}));
		let Action = (module as {
			SendAction?: ComponentType<{
				label: string;
				onClick: () => void;
			}>;
		}).SendAction;
		expect(typeof Action).toBe("function");
		if (!Action) return;
		let markup = renderToStaticMarkup(createElement(Action, {
			label: "Start research",
			onClick() {},
		}));

		expect(markup).toContain('aria-label="Start research"');
		expect(markup).toContain('title="Start research"');
		expect(markup).toContain("send-action btn btn-icon btn-primary rounded-full");
		expect(markup).toContain('aria-hidden="true"');
	});

	it("keeps one exact brief actionable after a failed create", async () => {
		let { composer: Composer } = await components();
		if (!Composer) return;
		let markup = renderToStaticMarkup(createElement(Composer, {
			question: BASE.question,
			error: "Research could not be started.",
			onCancel() {},
			onChange() {},
			onSubmit() {},
		}));

		expect(markup).toContain("Research question");
		expect(markup).toContain(BASE.question);
		expect(markup).toContain("Research could not be started.");
		expect(markup).toContain("Start research");
		expect(markup).toContain("Discard research question");
		expect(markup).not.toContain(">Cancel<");
		expect((markup.match(/textarea/g) ?? []).length).toBe(2);
	});

	it("locks the question and controls while submission is in flight", async () => {
		let { composer: Composer } = await components();
		if (!Composer) return;
		let markup = renderToStaticMarkup(createElement(Composer, {
			question: BASE.question,
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

	it("explains why submission is unavailable without a collaboration anchor", async () => {
		let { composer: Composer } = await components();
		if (!Composer) return;
		let markup = renderToStaticMarkup(createElement(Composer, {
			question: BASE.question,
			blocked: "Connect to the document before starting research.",
			onCancel() {},
			onChange() {},
			onSubmit() {},
		}));

		expect(markup).toContain("Connect to the document before starting research.");
		expect(markup).toMatch(/<button[^>]*aria-label="Start research"[^>]*disabled=""/);
	});

	it("exposes no placement or cancellation mutation for read-only created recovery", async () => {
		let { composer: Composer } = await components();
		if (!Composer) return;
		let markup = renderToStaticMarkup(createElement(Composer, {
			question: BASE.question,
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

	it("turns Escape into a composer dismissal", async () => {
		let handle = await composerKeyHandler();
		if (!handle) return;
		let calls: string[] = [];
		handle({
			key: "Escape",
			metaKey: false,
			ctrlKey: false,
			nativeEvent: { isComposing: false },
			currentTarget: {} as Parameters<ComposerKeyHandler>[0]["currentTarget"],
			preventDefault: () => calls.push("prevent"),
			stopPropagation: () => calls.push("stop"),
		}, {
			dismissible: true,
			onChange: () => calls.push("change"),
			onDismiss: () => calls.push("escape"),
			onSubmit: () => calls.push("submit"),
		});
		expect(calls).toEqual(["prevent", "stop", "escape"]);
	});

	it("does not dismiss an in-flight composer on Escape", async () => {
		let handle = await composerKeyHandler();
		if (!handle) return;
		let calls: string[] = [];
		handle(
			{
				key: "Escape",
				metaKey: false,
				ctrlKey: false,
				nativeEvent: { isComposing: false },
				currentTarget: {} as Parameters<ComposerKeyHandler>[0]["currentTarget"],
				preventDefault: () => calls.push("prevent"),
				stopPropagation: () => calls.push("stop"),
			},
			{
				dismissible: false,
				onChange: () => calls.push("change"),
				onDismiss: () => calls.push("escape"),
				onSubmit: () => calls.push("submit"),
			},
		);
		expect(calls).toEqual(["prevent", "stop"]);
	});
});

describe("research card", () => {
	it("shows pending stage and discovered sources without a partial summary", async () => {
		let { card: Card } = await components();
		if (!Card) return;
		let markup = renderToStaticMarkup(createElement(Card, {
			request: BASE,
			onCancel() {},
			onRemove() {},
		}));

		expect(markup).toContain(BASE.question);
		expect(markup).toContain("Searching");
		expect(markup).toContain("Release notes");
		expect(markup).toContain("https://example.com/releases");
		expect(markup).toContain("Cancel research");
		expect(markup).not.toContain("Remove research reference");
		expect(markup).not.toContain("summary");
	});

	it("shows only the safe failure and retry action after failure", async () => {
		let { card: Card } = await components();
		if (!Card) return;
		let markup = renderToStaticMarkup(createElement(Card, {
			request: {
				...BASE,
				state: "failed",
				stage: "failed",
				error: "Research could not be completed.",
			},
			onRemove() {},
			onRetry() {},
		}));

		expect(markup).toContain("Research failed");
		expect(markup).toContain("Research could not be completed.");
		expect(markup).toContain("Retry research");
		expect(markup).not.toContain("Cancel research");
	});

	it("shows the published child metadata with one open affordance", async () => {
		let { card: Card } = await components();
		if (!Card) return;
		let markup = renderToStaticMarkup(createElement(Card, {
			request: {
				...BASE,
				state: "completed",
				stage: "ready",
				child: {
					id: "child-one",
					title: "Rollout evidence",
					slug: "rollout-evidence",
					summary: "Public evidence supports the planned rollout date.",
					sourceCount: 1,
				},
			},
			onOpen() {},
			onRemove() {},
		}));

		expect(markup).toContain("Research ready");
		expect(markup).toContain("Rollout evidence");
		expect(markup).toContain("Public evidence supports the planned rollout date.");
		expect(markup).toContain("1 source");
		expect(markup).toContain("Researched by Planner");
		expect(markup).toContain("Open Rollout evidence");
		expect(markup.match(/Open Rollout evidence/g)).toHaveLength(1);
		expect(markup).not.toContain("Expand");
	});

	it("names zero and plural published sources", async () => {
		let { card: Card } = await components();
		if (!Card) return;
		let ready = {
			...BASE,
			state: "completed" as const,
			stage: "ready" as const,
			child: {
				id: "child-one",
				title: "Rollout evidence",
				slug: "rollout-evidence",
				summary: "A complete report.",
				sourceCount: 0,
			},
		};
		let zero = renderToStaticMarkup(createElement(Card, { request: ready, onOpen() {} }));
		let plural = renderToStaticMarkup(createElement(Card, {
			request: { ...ready, child: { ...ready.child, sourceCount: 3 } },
			onOpen() {},
		}));

		expect(zero).toContain("No sources");
		expect(plural).toContain("3 sources");
	});
});

describe("active research deletion", () => {
	it("blocks deletion while publication is still in progress", async () => {
		let state = mutableStore({ ...BASE, stage: "publishing" });
		let editor = deletionEditor();
		let register = await deletionGuard();
		if (!register) return;
		register(editor, state.store);
		let key = selectResearch(editor);

		expect(editor.dispatchCommand(DELETE_CHARACTER_COMMAND, true)).toBe(true);
		editor.update(() => {}, { discrete: true });
		editor.getEditorState().read(() => expect($getNodeByKey(key)).not.toBeNull());
	});

	it("fails closed while the initial request load is unresolved", async () => {
		let state = mutableStore(undefined);
		let editor = deletionEditor();
		let register = await deletionGuard();
		if (!register) return;
		register(editor, state.store);
		let key = selectResearch(editor);

		expect(editor.dispatchCommand(DELETE_CHARACTER_COMMAND, true)).toBe(true);
		editor.update(() => {}, { discrete: true });
		editor.getEditorState().read(() => expect($getNodeByKey(key)).not.toBeNull());
	});

	it("allows deletion only after a removable terminal snapshot loads", async () => {
		for (let stage of ["failed", "cancelled", "ready"] as const) {
			let state = mutableStore(atStage(stage));
			let editor = deletionEditor();
			let register = await deletionGuard();
			if (!register) return;
			register(editor, state.store);
			let key = selectResearch(editor);

			expect(editor.dispatchCommand(DELETE_CHARACTER_COMMAND, true)).toBe(true);
			editor.update(() => {}, { discrete: true });
			editor.getEditorState().read(() => expect($getNodeByKey(key)).toBeNull());
		}
	});

	it("blocks terminal deletion from retry start through failure or queued success", async () => {
		for (let outcome of ["failure", "success"] as const) {
			let state = mutableStore(atStage("failed"));
			let editor = deletionEditor();
			let register = await deletionGuard();
			if (!register) return;
			register(editor, state.store);
			let key = selectResearch(editor);
			state.setMutating(true);

			expect(editor.dispatchCommand(DELETE_CHARACTER_COMMAND, true)).toBe(true);
			editor.update(() => {}, { discrete: true });
			editor.getEditorState().read(() => expect($getNodeByKey(key)).not.toBeNull());

			state.setMutating(false);
			if (outcome === "success") state.set({ ...BASE, state: "pending", stage: "queued" });
			expect(editor.dispatchCommand(DELETE_CHARACTER_COMMAND, true)).toBe(true);
			editor.update(() => {}, { discrete: true });
			editor.getEditorState().read(() =>
				outcome === "failure"
					? expect($getNodeByKey(key)).toBeNull()
					: expect($getNodeByKey(key)).not.toBeNull()
			);
		}
	});

	it("blocks a selected active reference until cancellation makes removal explicit", async () => {
		let state = mutableStore(BASE);
		let editor = deletionEditor();
		let register = await deletionGuard();
		if (!register) return;
		let unregister = register(editor, state.store);
		let key = selectResearch(editor);

		expect(editor.dispatchCommand(DELETE_CHARACTER_COMMAND, true)).toBe(true);
		editor.getEditorState().read(() => expect($getNodeByKey(key)).not.toBeNull());

		state.set({ ...BASE, state: "cancelled", stage: "cancelled" });
		expect(editor.dispatchCommand(DELETE_CHARACTER_COMMAND, true)).toBe(true);
		editor.update(() => {}, { discrete: true });
		editor.getEditorState().read(() => expect($getNodeByKey(key)).toBeNull());
		unregister();
	});

	it("blocks collapsed Backspace, Delete, word, and line removal beside active research", async () => {
		let state = mutableStore(BASE);
		let editor = deletionEditor();
		let register = await deletionGuard();
		if (!register) return;
		register(editor, state.store);
		let key = "";
		let beforeKey = "";
		let afterKey = "";
		editor.update(() => {
			let before = $createParagraphNode().append($createTextNode("Before"));
			let node = $createResearchNode(BASE.id);
			let after = $createParagraphNode().append($createTextNode("After"));
			$getRoot().append(before, node, after);
			key = node.getKey();
			beforeKey = before.getKey();
			afterKey = after.getKey();
		}, { discrete: true });

		let selectAfterStart = () =>
			editor.update(() => {
				$getNodeByKey(afterKey)?.selectStart();
			}, { discrete: true });
		let selectBeforeEnd = () =>
			editor.update(() => {
				$getNodeByKey(beforeKey)?.selectEnd();
			}, { discrete: true });
		selectAfterStart();
		expect(editor.dispatchCommand(DELETE_CHARACTER_COMMAND, true)).toBe(true);
		selectBeforeEnd();
		expect(editor.dispatchCommand(DELETE_CHARACTER_COMMAND, false)).toBe(true);
		selectAfterStart();
		expect(editor.dispatchCommand(DELETE_WORD_COMMAND, true)).toBe(true);
		selectBeforeEnd();
		expect(editor.dispatchCommand(DELETE_LINE_COMMAND, false)).toBe(true);
		editor.getEditorState().read(() => expect($getNodeByKey(key)).not.toBeNull());
	});

	it("blocks a range removal that includes active research", async () => {
		let state = mutableStore(BASE);
		let editor = deletionEditor();
		let register = await deletionGuard();
		if (!register) return;
		register(editor, state.store);
		let key = "";
		editor.update(() => {
			let root = $getRoot();
			let node = $createResearchNode(BASE.id);
			root.append(
				$createParagraphNode().append($createTextNode("Before")),
				node,
				$createParagraphNode().append($createTextNode("After")),
			);
			key = node.getKey();
			let selection = $createRangeSelection();
			selection.anchor.set(root.getKey(), 0, "element");
			selection.focus.set(root.getKey(), 2, "element");
			$setSelection(selection);
		}, { discrete: true });

		expect(editor.dispatchCommand(REMOVE_TEXT_COMMAND, null)).toBe(true);
		editor.getEditorState().read(() => expect($getNodeByKey(key)).not.toBeNull());
	});
});

describe("research reference", () => {
	it("carries the ready-card opener through the store contract", async () => {
		let module = await import("./research");
		let open = (module as unknown as {
			openResearch?: (
				store: Store,
				id: string,
				child: Research.ReadyChild,
				opener: HTMLElement,
			) => void;
		}).openResearch;
		expect(typeof open).toBe("function");
		if (!open) return;
		let received: [Research.ReadyChild, { readonly current: HTMLElement | null }] | undefined;
		let token = { current: null as HTMLElement | null };
		let store: Store = {
			subscribe: () => () => {},
			retain: () => () => {},
			get: () => BASE,
			mutating: () => false,
			refresh() {},
			create: async () => BASE,
			cancel: async () => BASE,
			retry: async () => BASE,
			opener: (_id, current) => {
				if (current !== undefined) token.current = current;
				return token;
			},
			open: (child, opener) => received = [child, opener],
		};
		let child = {
			id: "child-one",
			title: "Rollout evidence",
			slug: "rollout-evidence",
			summary: "A complete report.",
			sourceCount: 1,
		};
		let opener = { focus() {} } as HTMLElement;

		open(store, "workspace-one", child, opener);

		expect(received).toEqual([child, token]);
		expect(token.current).toBe(opener);
	});

	it("defines one explicit state-to-actions policy", async () => {
		let module = await import("./research");
		let actions = (module as unknown as {
			researchActions?: (
				request: Research.RequestView | undefined,
				canEdit: boolean,
			) => { cancel: boolean; open: boolean; remove: boolean; retry: boolean };
		}).researchActions;
		expect(typeof actions).toBe("function");
		if (!actions) return;
		let expected: Array<[
			Research.RequestStage | "loading",
			{ cancel: boolean; open: boolean; remove: boolean; retry: boolean },
		]> = [
			["loading", { cancel: false, open: false, remove: false, retry: false }],
			["queued", { cancel: true, open: false, remove: false, retry: false }],
			["searching", { cancel: true, open: false, remove: false, retry: false }],
			["analyzing", { cancel: true, open: false, remove: false, retry: false }],
			["writing", { cancel: true, open: false, remove: false, retry: false }],
			["publishing", { cancel: false, open: false, remove: false, retry: false }],
			["failed", { cancel: false, open: false, remove: true, retry: true }],
			["cancelled", { cancel: false, open: false, remove: true, retry: true }],
			["ready", { cancel: false, open: true, remove: true, retry: false }],
		];
		for (let [stage, want] of expected) {
			let request = stage === "loading" ? undefined : atStage(stage);
			expect(actions(request, true)).toEqual(want);
		}
		expect(actions(atStage("ready"), false)).toEqual({
			cancel: false,
			open: true,
			remove: false,
			retry: false,
		});
		expect(actions(atStage("failed"), false)).toEqual({
			cancel: false,
			open: false,
			remove: false,
			retry: false,
		});
	});

	it("registers the dialect node renderer", async () => {
		register();
		let schema = registry();
		let editor = createHeadlessEditor({
			nodes: schema.nodes,
			onError: error => {
				throw error;
			},
		});
		let decorated: unknown;
		editor.update(() => {
			let node = $createResearchNode(BASE.id);
			$getRoot().append(node);
			decorated = node.decorate();
		}, { discrete: true });
		expect(decorated).not.toBeNull();
	});

	it("derives mutable state from the injected store", async () => {
		let module = await import("./research");
		let Reference = (module as unknown as {
			ResearchReference?: ComponentType<{ id: string; onRemove: () => void; store: Store }>;
		}).ResearchReference;
		expect(typeof Reference).toBe("function");
		if (!Reference) return;
		let store: Store = {
			subscribe: () => () => {},
			retain: () => () => {},
			get: id => id === BASE.id ? BASE : undefined,
			mutating: () => false,
			refresh() {},
			create: async () => BASE,
			cancel: async () => BASE,
			retry: async () => BASE,
			opener: () => ({ current: null }),
			open() {},
		};
		let markup = renderToStaticMarkup(createElement(Reference, {
			id: BASE.id,
			onRemove() {},
			store,
		}));
		expect(markup).toContain(BASE.question);
		expect(markup).toContain("Searching");
	});

	it("keeps terminal card actions disabled from shared retry mutation state", async () => {
		let module = await import("./research");
		let Reference = (module as unknown as {
			ResearchReference?: ComponentType<{ id: string; onRemove: () => void; store: Store }>;
		}).ResearchReference;
		expect(typeof Reference).toBe("function");
		if (!Reference) return;
		let failed = atStage("failed");
		let store: Store = {
			subscribe: () => () => {},
			retain: () => () => {},
			get: () => failed,
			mutating: () => true,
			refresh() {},
			create: async () => failed,
			cancel: async () => failed,
			retry: async () => failed,
			opener: () => ({ current: null }),
			open() {},
		};

		let markup = renderToStaticMarkup(createElement(Reference, {
			id: BASE.id,
			onRemove() {},
			store,
		}));
		expect(markup).toMatch(/aria-label="Retry research"[^>]*disabled/);
		expect(markup).toMatch(/aria-label="Remove research reference"[^>]*disabled/);
	});

	it("subscribes safely to a class store whose method depends on this", async () => {
		let module = await import("./research");
		let subscribe = (module as unknown as {
			subscribeResearch?: (store: Store, listener: () => void) => () => void;
		}).subscribeResearch;
		let Reference = (module as unknown as {
			ResearchReference?: ComponentType<{ id: string; onRemove: () => void; store: Store }>;
		}).ResearchReference;
		expect(typeof subscribe).toBe("function");
		expect(typeof Reference).toBe("function");
		if (!Reference || !subscribe) return;
		class ClassStore implements Store {
			listeners = new Set<() => void>();
			retained: string[] = [];
			subscribe(listener: () => void) {
				this.listeners.add(listener);
				return () => this.listeners.delete(listener);
			}
			get() {
				return BASE;
			}
			mutating() {
				return false;
			}
			refresh() {}
			retain(id: string) {
				this.retained.push(id);
				return () => this.retained.splice(this.retained.indexOf(id), 1);
			}
			async create() {
				return BASE;
			}
			async cancel() {
				return BASE;
			}
			async retry() {
				return BASE;
			}
			opener() {
				return { current: null };
			}
			open() {}
		}
		let store = new ClassStore();
		let off = subscribe(store, () => {});
		expect(store.listeners.size).toBe(1);
		off();
		expect(store.listeners.size).toBe(0);
		let markup = renderToStaticMarkup(createElement(Reference, {
			id: BASE.id,
			onRemove() {},
			store,
		}));
		expect(markup).toContain(BASE.question);
	});

	it("retains and releases the reference id through the store contract", async () => {
		let module = await import("./research");
		let retain = (module as unknown as {
			retainResearch?: (store: Store, id: string) => () => void;
		}).retainResearch;
		expect(typeof retain).toBe("function");
		if (!retain) return;
		let retained = new Set<string>();
		let store = {
			subscribe: () => () => {},
			retain: (id: string) => {
				retained.add(id);
				return () => retained.delete(id);
			},
			get: () => BASE,
			mutating: () => false,
			refresh() {},
			create: async () => BASE,
			cancel: async () => BASE,
			retry: async () => BASE,
			opener: () => ({ current: null }),
			open() {},
		};

		let release = retain(store, BASE.id);
		expect(retained).toEqual(new Set([BASE.id]));
		release();
		expect(retained).toEqual(new Set());
	});
});
