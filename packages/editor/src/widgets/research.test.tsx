import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createHeadlessEditor } from "@lexical/headless";
import { $getRoot } from "lexical";

import { $createResearchNode, registry } from "@chopin/dialect";
import { register } from "./index";

import type { ComponentType } from "react";
import type { Research } from "@chopin/protocol";

const BASE: Research.RequestView = {
	id: "workspace-one",
	channelId: "document-one",
	question: "Which evidence supports the rollout date?",
	state: "running",
	stage: "searching",
	sources: [{ title: "Release notes", url: "https://example.com/releases" }],
	createdAt: "2026-08-24T09:00:00.000Z",
	updatedAt: "2026-08-24T09:01:00.000Z",
};

type CardProps = {
	request: Research.RequestView;
	onCancel?: () => void;
	onOpen?: () => void;
	onRemove?: () => void;
	onRetry?: () => void;
};

type ComposerProps = {
	blocked?: string;
	cancelDisabled?: boolean;
	error?: string;
	onCancel: () => void;
	onChange: (value: string) => void;
	onEscape?: () => void;
	onSubmit: () => void;
	question: string;
	submitLabel?: string;
	submitting?: boolean;
};

type Store = {
	subscribe(listener: () => void): () => void;
	get(id: string): Research.RequestView | undefined;
	refresh(id: string): void;
	create(question: string, requestId: string): Promise<Research.RequestView>;
	cancel(id: string): Promise<Research.RequestView>;
	retry(id: string, question: string): Promise<Research.RequestView>;
	open(child: Research.ReadyChild): void;
};

async function components() {
	let module = await import("./research").catch(() => ({}));
	let card = (module as { ResearchCard?: ComponentType<CardProps> }).ResearchCard;
	let composer = (module as { ResearchComposer?: ComponentType<ComposerProps> }).ResearchComposer;
	expect(typeof card).toBe("function");
	expect(typeof composer).toBe("function");
	return { card, composer };
}

describe("research composer", () => {
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
		expect(markup).toContain("Cancel");
		expect((markup.match(/textarea/g) ?? []).length).toBe(2);
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
		expect(markup).toMatch(/<button[^>]*disabled=""[^>]*type="submit"/);
	});

	it("exposes no placement or cancellation mutation for read-only created recovery", async () => {
		let { composer: Composer } = await components();
		if (!Composer) return;
		let markup = renderToStaticMarkup(createElement(Composer, {
			question: BASE.question,
			blocked: "Reconnect with edit access to place this research.",
			cancelDisabled: true,
			submitLabel: "Place research",
			onCancel() {},
			onChange() {},
			onSubmit() {},
		}));

		expect(markup).toContain("Place research");
		expect((markup.match(/disabled=""/g) ?? []).length).toBe(2);
	});

	it("turns Escape into a composer dismissal", async () => {
		let module = await import("./research") as unknown as {
			handleResearchComposerKey?: (
				event: { key: string; preventDefault(): void; stopPropagation(): void },
				onEscape: () => void,
			) => void;
		};
		expect(typeof module.handleResearchComposerKey).toBe("function");
		if (!module.handleResearchComposerKey) return;
		let calls: string[] = [];
		module.handleResearchComposerKey({
			key: "Escape",
			preventDefault: () => calls.push("prevent"),
			stopPropagation: () => calls.push("stop"),
		}, () => calls.push("escape"));
		expect(calls).toEqual(["prevent", "stop", "escape"]);
	});

	it("does not dismiss an in-flight composer on Escape", async () => {
		let module = await import("./research") as unknown as {
			handleResearchComposerKey?: (
				event: { key: string; preventDefault(): void; stopPropagation(): void },
				onEscape: () => void,
				dismissible?: boolean,
			) => void;
		};
		expect(typeof module.handleResearchComposerKey).toBe("function");
		if (!module.handleResearchComposerKey) return;
		let calls: string[] = [];
		module.handleResearchComposerKey(
			{
				key: "Escape",
				preventDefault: () => calls.push("prevent"),
				stopPropagation: () => calls.push("stop"),
			},
			() => calls.push("escape"),
			false,
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

	it("opens the ready child without an expand action or report summary", async () => {
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
					summary: "This must stay out of the inline card.",
					sourceCount: 1,
				},
			},
			onOpen() {},
			onRemove() {},
		}));

		expect(markup).toContain("Research ready");
		expect(markup).toContain("Open Rollout evidence");
		expect(markup).not.toContain("This must stay out of the inline card.");
		expect(markup).not.toContain("Expand");
	});
});

describe("research reference", () => {
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
			let request = stage === "loading" ? undefined : { ...BASE, stage };
			expect(actions(request, true)).toEqual(want);
		}
		expect(actions({ ...BASE, stage: "ready" }, false)).toEqual({
			cancel: false,
			open: true,
			remove: false,
			retry: false,
		});
		expect(actions({ ...BASE, stage: "failed" }, false)).toEqual({
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
			get: id => id === BASE.id ? BASE : undefined,
			refresh() {},
			create: async () => BASE,
			cancel: async () => BASE,
			retry: async () => BASE,
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
			subscribe(listener: () => void) {
				this.listeners.add(listener);
				return () => this.listeners.delete(listener);
			}
			get() {
				return BASE;
			}
			refresh() {}
			async create() {
				return BASE;
			}
			async cancel() {
				return BASE;
			}
			async retry() {
				return BASE;
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

	it("retries the same authoritative request with its exact question", async () => {
		let module = await import("./research");
		let retry = (module as unknown as {
			retryResearch?: (
				store: Store,
				request: Research.RequestView,
			) => Promise<Research.RequestView>;
		}).retryResearch;
		expect(typeof retry).toBe("function");
		if (!retry) return;
		let received: [string, string] | undefined;
		let store: Store = {
			subscribe: () => () => {},
			get: () => BASE,
			refresh() {},
			create: async () => BASE,
			cancel: async () => BASE,
			retry: async (id, question) => {
				received = [id, question];
				return BASE;
			},
			open() {},
		};
		await retry(store, BASE);
		expect(received).toEqual([BASE.id, BASE.question]);
	});
});
