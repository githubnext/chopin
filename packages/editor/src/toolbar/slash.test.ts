import { describe, expect, it } from "bun:test";
import { createHeadlessEditor } from "@lexical/headless";
import { createYjsBinding, syncLexicalUpdateToYjs, syncYjsChangesToLexical } from "@lexical/yjs";
import {
	$createParagraphNode,
	$createTextNode,
	$getRoot,
	$getSelection,
	$isElementNode,
	$isRangeSelection,
	$isTextNode,
} from "lexical";

import * as Y from "yjs";

import { exportPlan, importPlan, registry } from "@chopin/dialect";

import type { Binding, Provider } from "@lexical/yjs";
import type { LexicalEditor } from "lexical";
import type { Research } from "@chopin/protocol";

import { decide, trigger } from "./slash";

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

const ANCHOR = { top: 1, right: 2, bottom: 3, left: 4, width: 5, height: 6 };
const REQUEST: Research.RequestView = {
	id: "07aeae6d-073d-4560-a9f4-bb8e4d954a46",
	channelId: "document-one",
	question: "Keep this question",
	state: "running",
	stage: "queued",
	sources: [],
	createdAt: "2026-08-24T09:00:00.000Z",
	updatedAt: "2026-08-24T09:00:00.000Z",
};

function peer(): { editor: LexicalEditor; doc: Y.Doc; binding: Binding } {
	let editor = createHeadlessEditor({
		nodes: registry().nodes,
		onError: error => {
			throw error;
		},
	});
	let doc = new Y.Doc();
	let binding = createYjsBinding({ editor, id: "plan", doc, docMap: new Map([["plan", doc]]) });
	editor.registerUpdateListener(
		({ dirtyElements, dirtyLeaves, editorState, normalizedNodes, prevEditorState, tags }) => {
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
	return { editor, doc, binding };
}

function connect(a: Y.Doc, b: Y.Doc) {
	a.on("update", (update, origin) => {
		if (origin !== b) Y.applyUpdate(b, update, a);
	});
	b.on("update", (update, origin) => {
		if (origin !== a) Y.applyUpdate(a, update, b);
	});
}

async function settle(): Promise<void> {
	for (let i = 0; i < 5; i++) await new Promise(resolve => setTimeout(resolve, 0));
}

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

	it("keeps the multi-word web search alias reachable", () => {
		expect(at("/web |")).toBe("web ");
		expect(at("/web s|")).toBe("web s");
		expect(at("/web search|")).toBe("web search");
		expect(at("/web search more|")).toBeUndefined();
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
	it("does not consume a second trigger during submission or created recovery", async () => {
		let module = await import("./research") as unknown as {
			beginResearchDraft?: (
				drafts: {
					canOpen(): boolean;
					open(anchor: typeof ANCHOR, position?: Y.RelativePosition): boolean;
				},
				consume: () => { anchor: typeof ANCHOR; position?: Y.RelativePosition } | undefined,
			) => boolean;
		};
		let { ResearchDraftStore } = await import("../research-draft");
		let drafts = new ResearchDraftStore();
		let original = Y.createRelativePositionFromTypeIndex(new Y.Doc().getText("original"), 0);
		expect(drafts.open(ANCHOR, original)).toBe(true);
		drafts.change(REQUEST.question);
		let resolve!: (request: Research.RequestView) => void;
		let create = new Promise<Research.RequestView>(done => resolve = done);
		let running = drafts.start(() => create);
		let requestId = drafts.get()?.submitted?.requestId;
		let consumed = 0;
		let attempt = () =>
			module.beginResearchDraft!(drafts, () => {
				consumed++;
				return {
					anchor: { ...ANCHOR, top: 99 },
					position: Y.createRelativePositionFromTypeIndex(
						new Y.Doc().getText("replacement"),
						0,
					),
				};
			});

		expect(typeof module.beginResearchDraft).toBe("function");
		if (!module.beginResearchDraft) return;
		expect(attempt()).toBe(false);
		expect(consumed).toBe(0);
		expect(drafts.get()?.submitted?.requestId).toBe(requestId);

		resolve(REQUEST);
		await running;
		expect(drafts.get()?.created).toEqual(REQUEST);
		expect(attempt()).toBe(false);
		expect(consumed).toBe(0);
		expect(drafts.get()?.question).toBe(REQUEST.question);
		expect(drafts.get()?.submitted?.requestId).toBe(requestId);
		expect(drafts.get()?.position).toBe(original);
	});

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
		let command = module.availableCommands("research")[0]!;
		let opened = 0;
		if (command.kind !== "action") throw new Error("research must be an action command");
		command.run({
			dispatchCommand(_command, action: { consume(): boolean }) {
				if (action.consume()) opened++;
				return true;
			},
		} as LexicalEditor, { anchor: ANCHOR, consume: () => true });
		expect(opened).toBe(1);
	});

	it("rebases the saved insertion point across preceding collaborative edits", async () => {
		let a = peer();
		let b = peer();
		connect(a.doc, b.doc);
		importPlan(a.editor, "Before after\n");
		await settle();

		let module = await import("./research") as unknown as {
			captureResearchPosition?: (binding: Binding) => Y.RelativePosition | undefined;
			insertResearchReference?: (
				editor: LexicalEditor,
				binding: Binding,
				position: Y.RelativePosition,
				id: string,
			) => boolean;
		};
		expect(typeof module.captureResearchPosition).toBe("function");
		expect(typeof module.insertResearchReference).toBe("function");
		if (!module.captureResearchPosition || !module.insertResearchReference) return;
		let saved: Y.RelativePosition | undefined;
		a.editor.update(() => {
			let paragraph = $getRoot().getFirstChild();
			let text = $isElementNode(paragraph) ? paragraph.getFirstChild() : undefined;
			if (!$isTextNode(text)) return;
			text.select(7, 7);
			saved = module.captureResearchPosition?.(a.binding);
		}, { discrete: true });
		expect(saved).toBeDefined();

		b.editor.update(() => {
			let paragraph = $getRoot().getFirstChild();
			let text = $isElementNode(paragraph) ? paragraph.getFirstChild() : undefined;
			if ($isRangeSelection($getSelection())) $getRoot().selectEnd();
			if ($isTextNode(text)) text.setTextContent(`Earlier ${text.getTextContent()}`);
			paragraph?.insertBefore($createParagraphNode().append($createTextNode("New block")));
		}, { discrete: true });
		await settle();

		expect(module.insertResearchReference(
			a.editor,
			a.binding,
			saved!,
			"8f4d193b-2018-4977-b404-0092bb911676",
		)).toBe(true);
		await settle();
		let source = exportPlan(a.editor);
		expect(source).toBe(
			'New block\n\nEarlier Before&#x20;\n\n<Research id="8f4d193b-2018-4977-b404-0092bb911676" />\n\nafter\n',
		);
		expect(exportPlan(b.editor)).toBe(source);
	});

	it("reports an insertion failure and places the same request at a new cursor", async () => {
		let target = peer();
		importPlan(target.editor, "Keep this\n");
		await settle();
		let module = await import("./research") as unknown as {
			captureResearchPosition(binding: Binding): Y.RelativePosition | undefined;
			insertResearchReference(
				editor: LexicalEditor,
				binding: Binding,
				position: Y.RelativePosition,
				id: string,
			): boolean;
		};
		let foreign = new Y.Doc();
		let invalid = Y.createRelativePositionFromTypeIndex(foreign.getText("gone"), 0);
		let request: Research.RequestView = {
			id: "07aeae6d-073d-4560-a9f4-bb8e4d954a46",
			channelId: "document-one",
			question: "  Keep this brief exactly.  ",
			state: "running",
			stage: "queued",
			sources: [],
			createdAt: "2026-08-24T09:00:00.000Z",
			updatedAt: "2026-08-24T09:00:00.000Z",
		};
		expect(module.insertResearchReference(
			target.editor,
			target.binding,
			invalid,
			request.id,
		)).toBe(false);
		expect(exportPlan(target.editor)).toBe("Keep this\n");

		let saved: Y.RelativePosition | undefined;
		target.editor.update(() => {
			$getRoot().selectEnd();
			saved = module.captureResearchPosition(target.binding);
		}, { discrete: true });
		expect(module.insertResearchReference(
			target.editor,
			target.binding,
			saved!,
			request.id,
		)).toBe(true);
		expect(exportPlan(target.editor)).toContain(`<Research id="${request.id}" />`);
	});

	it("restores editor focus when the research composer is dismissed", async () => {
		let module = await import("./research") as unknown as {
			dismissResearchComposer?: (editor: Pick<LexicalEditor, "focus">, dismiss: () => void) => void;
		};
		expect(typeof module.dismissResearchComposer).toBe("function");
		if (!module.dismissResearchComposer) return;
		let calls: string[] = [];
		module.dismissResearchComposer(
			{ focus: () => calls.push("focus") },
			() => calls.push("dismiss"),
		);
		expect(calls).toEqual(["dismiss", "focus"]);
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
