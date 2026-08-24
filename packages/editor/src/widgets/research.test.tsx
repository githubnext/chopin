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
	onRemove: () => void;
	onRetry?: () => void;
};

type ComposerProps = {
	error?: string;
	onCancel: () => void;
	onChange: (value: string) => void;
	onSubmit: () => void;
	question: string;
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
		expect(markup).toContain("Remove research reference");
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
