import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createHeadlessEditor } from "@lexical/headless";
import { $getRoot } from "lexical";

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
	retain(id: string): () => void;
	get(id: string): Research.RequestView | undefined;
	create(question: string, requestId: string): Promise<Research.RequestView>;
	cancel(id: string): Promise<Research.RequestView>;
	retry(id: string): Promise<Research.RequestView>;
	opener(id: string, current?: HTMLElement | null): { readonly current: HTMLElement | null };
	open(child: Research.ReadyChild, opener: { readonly current: HTMLElement | null }): void;
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
