import { describe, expect, it } from "bun:test";
import { createHeadlessEditor } from "@lexical/headless";
import { createYjsBinding, syncLexicalUpdateToYjs, syncYjsChangesToLexical } from "@lexical/yjs";
import { $getRoot, $isElementNode } from "lexical";
import * as Y from "yjs";

import { exportPlan, importPlan } from "../convert";
import { parse } from "../parse";
import { registry } from "../registry";
import { validate } from "../validate";
import * as Containers from "./containers";

import type { Binding, Provider } from "@lexical/yjs";
import type { LexicalEditor, TextNode } from "lexical";

const REGISTRY = registry();

const ID = "01K0N4TR8K7JGM4R1J7PW4R8YJ";
const ID2 = "01K0N4V4E7Y6P4MJ5WD8XZF3B2";
const ID3 = "01K0N4W3B7P27CBAEC7A8C8WEA";
const RESEARCH_ID = "8f4d193b-2018-4977-b404-0092bb911676";

function editor(): LexicalEditor {
	return createHeadlessEditor({
		nodes: REGISTRY.nodes,
		onError(err) {
			throw err;
		},
	});
}

function through(source: string): string {
	let instance = editor();
	importPlan(instance, source, { registry: REGISTRY });
	return exportPlan(instance, { registry: REGISTRY });
}

/** Canonical output must be a fixed point. */
function canonical(source: string): string {
	let once = through(source);
	expect(through(once)).toBe(once);
	return once;
}

function attributes(initial: Record<string, string>): HTMLElement {
	let values = new Map(Object.entries(initial));
	let dataset = { planType: initial["data-plan-type"] } as DOMStringMap;
	return {
		dataset,
		getAttribute(name: string) {
			return values.get(name) ?? null;
		},
		removeAttribute(name: string) {
			values.delete(name);
			if (name === "data-plan-type") delete dataset.planType;
		},
		setAttribute(name: string, value: string) {
			values.set(name, value);
			if (name === "data-plan-type") dataset.planType = value;
		},
	} as unknown as HTMLElement;
}

const CALLOUT = `<Callout id="${ID}" type="warning" title="Careful">\n\nBody text.\n\n</Callout>\n`;

const TABS = `<Tabs id="${ID}">\n`
	+ `<Tab id="${ID2}" label="macOS">\n\nRun it.\n\n</Tab>\n`
	+ `<Tab id="${ID3}" label="Web">\n\n- a\n- b\n\n</Tab>\n`
	+ `</Tabs>\n`;

describe("structural components", () => {
	it("round-trips one externally owned research reference", () => {
		let isResearch = (Containers as unknown as {
			$isResearchNode?: (node: unknown) => boolean;
		}).$isResearchNode;
		expect(typeof isResearch).toBe("function");
		if (!isResearch) return;
		let source = `<Research id="${RESEARCH_ID}" />\n`;
		expect(validate(parse(source))).toEqual({ ok: true });
		expect(canonical(source)).toBe(source);

		let instance = editor();
		importPlan(instance, source, { registry: REGISTRY });
		instance.getEditorState().read(() => {
			let research = $getRoot().getFirstChild();
			expect(isResearch(research)).toBe(true);
			if (!isResearch(research)) return;
			let reference = research as unknown as { getId(): string; exportJSON(): unknown };
			expect(reference.getId()).toBe(RESEARCH_ID);
			expect(reference.exportJSON()).toMatchObject({ planId: RESEARCH_ID });
		});
	});

	it("round-trips a callout with its attributes", () => {
		let out = canonical(CALLOUT);
		expect(out).toContain(`id="${ID}"`);
		expect(out).toContain('type="warning"');
		expect(out).toContain('title="Careful"');
		expect(out).toContain("Body text.");
	});

	it("round-trips tabs with labels and block content", () => {
		let out = canonical(TABS);
		expect(out).toContain('label="macOS"');
		expect(out).toContain('label="Web"');
		expect(out).toContain("- a");
	});

	it("keeps nesting stable several levels deep", () => {
		let deep = `<Tabs id="${ID}">\n`
			+ `<Tab id="${ID2}" label="Deep">\n\n`
			+ `<Callout id="${ID3}" type="note">\n\n`
			+ `| a | b |\n| - | - |\n| 1 | 2 |\n\n- list\n\n`
			+ `</Callout>\n\n</Tab>\n</Tabs>\n`;
		expect(canonical(deep)).toContain("| a | b |");
	});

	it("omits optional attributes that are unset", () => {
		let out = canonical(`<Callout id="${ID}" type="note">\n\nx\n\n</Callout>\n`);
		expect(out).not.toContain("title=");
	});

	it("builds element nodes with ordinary children, not decorators", () => {
		let instance = editor();
		importPlan(instance, TABS, { registry: REGISTRY });

		instance.getEditorState().read(() => {
			let tabs = $getRoot().getFirstChild();
			expect(Containers.$isTabsNode(tabs)).toBe(true);
			if (!$isElementNode(tabs)) return;

			let children = tabs.getChildren();
			expect(children).toHaveLength(2);
			expect(children.every(Containers.$isTabNode)).toBe(true);

			let first = children[0];
			expect($isElementNode(first) && first.getChildren()[0]?.getType()).toBe("paragraph");
		});
	});

	it("keeps NodeState-backed DOM attributes synchronized after an edit", () => {
		let instance = editor();
		importPlan(instance, TABS + CALLOUT, { registry: REGISTRY });

		let previous = instance.getEditorState().read(() => {
			let tabs = $getRoot().getFirstChild();
			let tab = $isElementNode(tabs) ? tabs.getFirstChild() : null;
			let callout = $getRoot().getLastChild();
			return {
				callout: Containers.$isCalloutNode(callout) ? callout : null,
				tab: Containers.$isTabNode(tab) ? tab : null,
			};
		});
		let tabDOM = attributes({ "aria-label": "macOS" });
		let calloutDOM = attributes({ "aria-label": "Careful", "data-plan-type": "warning" });

		instance.update(
			() => {
				let tabs = $getRoot().getFirstChild();
				let tab = $isElementNode(tabs) ? tabs.getFirstChild() : null;
				let callout = $getRoot().getLastChild();
				if (Containers.$isTabNode(tab)) tab.setLabel("Linux");
				if (Containers.$isCalloutNode(callout)) callout.setCalloutType("tip").setTitle("");
			},
			{ discrete: true },
		);

		instance.getEditorState().read(() => {
			let tabs = $getRoot().getFirstChild();
			let tab = $isElementNode(tabs) ? tabs.getFirstChild() : null;
			let callout = $getRoot().getLastChild();
			expect(Containers.$isTabNode(tab)).toBe(true);
			expect(Containers.$isCalloutNode(callout)).toBe(true);
			if (!Containers.$isTabNode(tab) || !previous.tab) return;
			if (!Containers.$isCalloutNode(callout) || !previous.callout) return;

			tab.updateDOM(previous.tab, tabDOM);
			callout.updateDOM(previous.callout, calloutDOM);
		});

		expect(tabDOM.getAttribute("aria-label")).toBe("Linux");
		expect(calloutDOM.dataset.planType).toBe("tip");
		expect(calloutDOM.getAttribute("aria-label")).toBeNull();
	});
});

// -- collaboration ---------------------------------------------------------

const PROVIDER = {
	awareness: {
		getLocalState: () => null,
		getStates: () => new Map(),
		off() {},
		on() {},
		setLocalState() {},
		setLocalStateField() {},
	},
	connect() {},
	disconnect() {},
	off() {},
	on() {},
} as unknown as Provider;

type Peer = { editor: LexicalEditor; doc: Y.Doc; binding: Binding };

function peer(): Peer {
	let instance = editor();
	let doc = new Y.Doc();
	let binding = createYjsBinding({
		editor: instance,
		id: "plan",
		doc,
		docMap: new Map([["plan", doc]]),
	});

	instance.registerUpdateListener(
		({ dirtyElements, dirtyLeaves, editorState, normalizedNodes, prevEditorState, tags }) => {
			if (tags.has("skip-collab")) return;
			syncLexicalUpdateToYjs(
				binding,
				PROVIDER,
				prevEditorState,
				editorState,
				dirtyElements,
				dirtyLeaves,
				normalizedNodes,
				tags,
			);
		},
	);

	binding.root.getSharedType().observeDeep((events, transaction) => {
		if (transaction.origin !== binding) syncYjsChangesToLexical(binding, PROVIDER, events, false);
	});

	return { editor: instance, doc, binding };
}

async function settle(): Promise<void> {
	for (let i = 0; i < 5; i++) await new Promise(resolve => setTimeout(resolve, 0));
}

/** Edit the first text node inside the nth tab. */
function writeTab(instance: LexicalEditor, index: number, value: string) {
	instance.update(
		() => {
			let tabs = $getRoot().getFirstChild();
			if (!$isElementNode(tabs)) return;
			let tab = tabs.getChildren()[index];
			if (!$isElementNode(tab)) return;
			let paragraph = tab.getFirstChild();
			if (!$isElementNode(paragraph)) return;
			(paragraph.getFirstChild() as TextNode | null)?.setTextContent(value);
		},
		{ discrete: true },
	);
}

describe("container collaboration", () => {
	it("merges concurrent edits in different tabs", async () => {
		let a = peer();
		let b = peer();

		let held: Array<{ from: Y.Doc; update: Uint8Array }> = [];
		let paused = false;
		let deliver = (from: Y.Doc, update: Uint8Array) => {
			let target = from === a.doc ? b.doc : a.doc;
			Y.applyUpdate(target, update, "relay");
		};
		for (let doc of [a.doc, b.doc]) {
			doc.on("update", (update: Uint8Array, origin: unknown) => {
				if (origin === "relay") return;
				if (paused) held.push({ from: doc, update });
				else deliver(doc, update);
			});
		}

		importPlan(
			a.editor,
			`<Tabs id="${ID}">\n`
				+ `<Tab id="${ID2}" label="One">\n\nfirst\n\n</Tab>\n`
				+ `<Tab id="${ID3}" label="Two">\n\nsecond\n\n</Tab>\n`
				+ `</Tabs>\n`,
			{ registry: REGISTRY },
		);
		await settle();

		// Both peers edit different tabs before either sees the other's change.
		paused = true;
		writeTab(a.editor, 0, "edited-by-A");
		writeTab(b.editor, 1, "edited-by-B");
		paused = false;
		for (let { from, update } of held) deliver(from, update);
		await settle();

		let left = exportPlan(a.editor, { registry: REGISTRY });
		let right = exportPlan(b.editor, { registry: REGISTRY });

		expect(left).toBe(right);
		expect(left).toContain("edited-by-A");
		expect(left).toContain("edited-by-B");
	});

	it("keeps callout attributes through a sync", async () => {
		let a = peer();
		let b = peer();
		a.doc.on("update", (update: Uint8Array, origin: unknown) => {
			if (origin !== "relay") Y.applyUpdate(b.doc, update, "relay");
		});

		importPlan(a.editor, CALLOUT, { registry: REGISTRY });
		await settle();

		b.editor.getEditorState().read(() => {
			let callout = $getRoot().getFirstChild();
			expect(Containers.$isCalloutNode(callout)).toBe(true);
			if (!Containers.$isCalloutNode(callout)) return;
			expect(callout.getId()).toBe(ID);
			expect(callout.getCalloutType()).toBe("warning");
			expect(callout.getTitle()).toBe("Careful");
		});
	});

	it("keeps an atomic research reference through a sync and export", async () => {
		let a = peer();
		let b = peer();
		a.doc.on("update", (update: Uint8Array, origin: unknown) => {
			if (origin !== "relay") Y.applyUpdate(b.doc, update, "relay");
		});

		importPlan(a.editor, `<Research id="${RESEARCH_ID}" />\n`, { registry: REGISTRY });
		await settle();

		b.editor.getEditorState().read(() => {
			let research = $getRoot().getFirstChild();
			expect(Containers.$isResearchNode(research)).toBe(true);
			if (Containers.$isResearchNode(research)) expect(research.getId()).toBe(RESEARCH_ID);
		});
		expect(exportPlan(b.editor, { registry: REGISTRY })).toBe(
			`<Research id="${RESEARCH_ID}" />\n`,
		);
	});
});
