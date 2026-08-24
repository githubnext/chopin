import { describe, expect, it } from "bun:test";
import { createHeadlessEditor } from "@lexical/headless";
import {
	$createParagraphNode,
	$createTextNode,
	$getRoot,
	$getSelection,
	$isRangeSelection,
} from "lexical";

import { exportPlan, registry } from "@chopin/dialect";

import type { LexicalEditor, RangeSelection } from "lexical";
import type { Research } from "@chopin/protocol";

import { decide, trigger } from "./slash";

/** Defaults to a local, armed, settled keystroke; each case varies one thing. */
function when(over: Partial<Parameters<typeof decide>[0]> = {}) {
	return decide({
		typed: "",
		open: false,
		armed: true,
		remote: false,
		composing: false,
		...over,
	});
}

/** Reads the caret from a `|` marker, so the cases stay legible. */
function at(source: string): string | undefined {
	let offset = source.indexOf("|");
	return trigger(source.replace("|", ""), offset);
}

describe("slash menu trigger", () => {
	it("opens on a slash that starts a block", () => {
		expect(at("/|")).toBe("");
		expect(at("/head|")).toBe("head");
	});

	it("opens on a slash that starts a word", () => {
		expect(at("Rollout /|")).toBe("");
		expect(at("Rollout /table|")).toBe("table");
	});

	it("stays shut inside the paths and URLs a plan is full of", () => {
		expect(at("src/index.ts|")).toBeUndefined();
		expect(at("See https://example.com|")).toBeUndefined();
		expect(at("and/or|")).toBeUndefined();
		expect(at("24/7|")).toBeUndefined();
		expect(at("clients/vm/src|")).toBeUndefined();
	});

	it("closes once the query becomes prose", () => {
		expect(at("/heading one|")).toBeUndefined();
		expect(at("/ |")).toBeUndefined();
	});

	it("ignores slashes the caret has moved away from", () => {
		// Editing earlier in a line that happens to contain a trigger.
		expect(at("Deploy| /table")).toBeUndefined();
		// The caret sits before the slash it would otherwise match.
		expect(at("|/table")).toBeUndefined();
	});

	it("reads the nearest trigger behind the caret", () => {
		expect(at("/first then /second|")).toBe("second");
	});

	it("has nothing to offer without a slash", () => {
		expect(at("Rollout plan|")).toBeUndefined();
		expect(at("|")).toBeUndefined();
	});
});

describe("slash menu commands", () => {
	it("discovers the research composer by research and web search", async () => {
		let module = await import("./slash");
		let available = (module as unknown as {
			availableCommands?: (query: string) => Array<{ id: string }>;
		}).availableCommands;
		expect(available?.("research").map(command => command.id)).toEqual(["research"]);
		expect(available?.("web search").map(command => command.id)).toEqual(["research"]);
	});

	it("opens the local composer instead of inserting a document node immediately", async () => {
		let module = await import("./slash");
		let command = module.availableCommands("research")[0] as unknown as {
			run(editor: LexicalEditor, actions: { research(): void }): void;
		};
		let opened = 0;
		command.run({} as LexicalEditor, { research: () => opened++ });
		expect(opened).toBe(1);
	});

	it("inserts a durable reference at the selection saved before the request", async () => {
		let schema = registry();
		let editor = createHeadlessEditor({
			nodes: schema.nodes,
			onError: error => {
				throw error;
			},
		});
		let saved: RangeSelection | undefined;
		editor.update(() => {
			let text = $createTextNode("Before after");
			$getRoot().append($createParagraphNode().append(text));
			text.select(7, 7);
			let selection = $getSelection();
			if ($isRangeSelection(selection)) saved = selection.clone();
		}, { discrete: true });
		editor.update(() => $getRoot().selectEnd(), { discrete: true });

		let module = await import("./slash");
		let insert = (module as unknown as {
			insertResearchReference?: (
				editor: LexicalEditor,
				selection: RangeSelection,
				id: string,
			) => boolean;
		}).insertResearchReference;
		expect(typeof insert).toBe("function");
		if (!insert || !saved) return;
		expect(insert(editor, saved, "workspace-one")).toBe(true);

		let source = exportPlan(editor, { registry: schema });
		expect(source).toContain("Before");
		expect(source).toContain('<Research id="workspace-one" />');
		expect(source).toContain("after");
		expect(source.indexOf("Before")).toBeLessThan(source.indexOf("<Research"));
		expect(source.indexOf("<Research")).toBeLessThan(source.indexOf("after"));
	});

	it("does not insert a dead reference when durable creation fails", async () => {
		let schema = registry();
		let editor = createHeadlessEditor({
			nodes: schema.nodes,
			onError: error => {
				throw error;
			},
		});
		let saved: RangeSelection | undefined;
		editor.update(() => {
			let text = $createTextNode("Keep this");
			$getRoot().append($createParagraphNode().append(text));
			text.selectEnd();
			let selection = $getSelection();
			if ($isRangeSelection(selection)) saved = selection.clone();
		}, { discrete: true });
		let module = await import("./slash");
		let create = (module as unknown as {
			createResearchReference?: (
				editor: LexicalEditor,
				selection: RangeSelection,
				question: string,
				requestId: string,
				persist: (question: string, requestId: string) => Promise<Research.RequestView>,
			) => Promise<Research.RequestView>;
		}).createResearchReference;
		expect(typeof create).toBe("function");
		if (!create || !saved) return;
		await expect(create(
			editor,
			saved,
			"  Keep this brief exactly.  ",
			"request-one",
			async () => {
				throw new Error("offline");
			},
		)).rejects.toThrow("offline");
		expect(exportPlan(editor, { registry: schema })).toBe("Keep this\n");
	});
});

describe("slash menu gate", () => {
	it("opens for a slash the author typed", () => {
		expect(when()).toBe("open");
		expect(when({ typed: "head" })).toBe("open");
	});

	it("stays shut for a slash that arrived with someone else's edit", () => {
		// An agent turn writing `/workspace/project` recovers the caret into it.
		expect(when({ remote: true })).toBe("ignore");
	});

	it("stays shut when the caret merely moves next to a slash", () => {
		// Clicking after an existing `/` commits an update like any other.
		expect(when({ armed: false })).toBe("ignore");
	});

	it("keeps filtering an open menu whatever caused the update", () => {
		// A peer editing elsewhere must not dismiss the menu being typed into.
		expect(when({ open: true, armed: false })).toBe("open");
		expect(when({ open: true, armed: false, remote: true })).toBe("open");
	});

	it("closes as soon as the trigger is gone, whoever removed it", () => {
		expect(when({ typed: undefined })).toBe("close");
		expect(when({ typed: undefined, open: true })).toBe("close");
		expect(when({ typed: undefined, open: true, remote: true })).toBe("close");
	});

	it("waits out composition rather than acting on half-typed input", () => {
		expect(when({ composing: true })).toBe("ignore");
		// Not even to close: the text mid-composition is not a decision yet.
		expect(when({ composing: true, typed: undefined, open: true })).toBe("ignore");
	});
});
