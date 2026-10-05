import { describe, expect, it } from "bun:test";
import { createHeadlessEditor } from "@lexical/headless";
import { createYjsBinding, syncLexicalUpdateToYjs, syncYjsChangesToLexical } from "@lexical/yjs";
import { $createParagraphNode, $createTextNode, $getNodeByKey, $getRoot } from "lexical";
import * as Y from "yjs";

import { importPlan, registry } from "@chopin/dialect";

import { collectPlanState, QuestionnaireStore } from "./questionnaires";

import type { Binding, Provider } from "@lexical/yjs";
import type { LexicalEditor } from "lexical";
import type { Plan } from "@chopin/protocol";
import type { PlanQuestionnaireState } from "./questionnaires";

const REGISTRY = registry();
const QUESTIONNAIRE = `<Questionnaire id="01K0N4TR8K7JGM4R1J7PW4R8YJ">\n`
	+ `<Question id="01K0N4V4E7Y6P4MJ5WD8XZF3B2" header="Rollout" `
	+ `prompt="How should we deploy?" multiple="false">\n`
	+ `<Option id="01K0N4W3B7P27CBAEC7A8C8WEA" label="Canary" />\n`
	+ `</Question>\n`
	+ `</Questionnaire>\n`;

function open(source: string): LexicalEditor {
	let editor = createHeadlessEditor({
		nodes: REGISTRY.nodes,
		onError(err) {
			throw err;
		},
	});
	importPlan(editor, source, { registry: REGISTRY });
	return editor;
}

function state(source: string) {
	let editor = open(source);
	return read(editor);
}

function read(editor: LexicalEditor): PlanQuestionnaireState {
	let value: PlanQuestionnaireState | undefined;
	editor.getEditorState().read(() => {
		value = collectPlanState();
	});
	if (!value) throw new Error("could not read plan questionnaire state");
	return value;
}

describe("plan questionnaire state", () => {
	it("keeps a questionnaire-only document out of plan content", () => {
		expect(state("")).toEqual({ entries: [], hasPlanContent: false });

		let emptyParagraph = open("");
		emptyParagraph.update(() => {
			$getRoot().append($createParagraphNode());
		}, { discrete: true });
		expect(read(emptyParagraph)).toEqual({ entries: [], hasPlanContent: false });

		expect(state(QUESTIONNAIRE)).toMatchObject({
			entries: [{ id: "01K0N4TR8K7JGM4R1J7PW4R8YJ" }],
			hasPlanContent: false,
		});
	});

	it("recognises ordinary plan blocks as plan content", () => {
		for (
			let source of [
				"The renderer caches tiles for 60 seconds.\n",
				"| Name |\n| ---- |\n| API  |\n",
				"![Diagram](https://example.com/diagram.png)\n",
				"```ts\nlet answer = 42;\n```\n",
			]
		) {
			expect(state(source)).toEqual({ entries: [], hasPlanContent: true });
		}
	});

	it("confirms an empty snapshot only after a synced Lexical read", async () => {
		let editor = open("");
		let store = new QuestionnaireStore();
		store.attach(editor);
		expect(store.readySnapshot()).toBe(false);

		// The document write immediately before sync belongs to the confirmed snapshot.
		editor.update(() => {
			$getRoot().append($createParagraphNode().append($createTextNode("Loaded prose")));
		});
		store.setDocumentSynced(true);
		await new Promise(resolve => setTimeout(resolve, 0));
		expect(store.readySnapshot()).toBe(true);
		expect(store.contentSnapshot()).toBe(true);

		store.setDocumentSynced(true);
		expect(store.readySnapshot()).toBe(true);
		store.setDocumentSynced(false);
		expect(store.readySnapshot()).toBe(true);
		store.resetDocument();
		expect(store.readySnapshot()).toBe(false);
	});

	it("cancels a queued confirmation when the provider closes", () => {
		let pending: (() => void) | undefined;
		let editor = {
			update(callback: () => void) {
				pending = callback;
			},
		} as unknown as LexicalEditor;
		let store = new QuestionnaireStore();
		store.attach(editor);
		store.setDocumentSynced(true);
		store.setDocumentSynced(false);
		pending?.();
		expect(store.readySnapshot()).toBe(false);
	});
});

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

function proseRoom(
	source = "First paragraph.\n\nSecond paragraph.\n\nThird paragraph.\n",
): { editor: LexicalEditor; binding: Binding; keys: string[] } {
	let editor = createHeadlessEditor({
		nodes: REGISTRY.nodes,
		onError: error => {
			throw error;
		},
	});
	let doc = new Y.Doc();
	let binding = createYjsBinding({ editor, id: "plan", doc, docMap: new Map([["plan", doc]]) });
	editor.registerUpdateListener(
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
	importPlan(editor, source, { registry: REGISTRY });
	let keys: string[] = [];
	editor.getEditorState().read(() => {
		keys = $getRoot().getChildren().map(node => node.getKey());
	});
	return { editor, binding, keys };
}

function proseAnchor(binding: Binding, key: string): Plan.Anchor {
	let type = binding.collabNodeMap.get(key)?.getSharedType();
	if (!type) throw new Error(`no collaborative block ${key}`);
	let binary = "";
	for (let byte of Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(type, 0, -1))) {
		binary += String.fromCharCode(byte);
	}
	return { epoch: "e1", position: btoa(binary), digest: "sha256:paragraph" };
}

function prose(widget: string, anchor: Plan.Anchor, orphaned = false): Plan.ProseAnchors {
	return { widget, anchors: [anchor], orphaned };
}

describe("decided prose targets", () => {
	it("resolves a pre-binding snapshot in document order and ignores orphaned prose", () => {
		let { binding, keys } = proseRoom();
		let store = new QuestionnaireStore();
		let updates = 0;
		store.subscribe(() => updates++);
		store.prose([
			prose("third", proseAnchor(binding, keys[2]!)),
			prose("removed", proseAnchor(binding, keys[1]!), true),
			prose("first", proseAnchor(binding, keys[0]!)),
		]);
		store.bind(binding);

		expect(store.proseTargets()).toEqual([
			{ widget: "first", key: keys[0] },
			{ widget: "third", key: keys[2] },
		]);
		expect(store.proseKey("removed")).toBeUndefined();
		expect(updates).toBe(1);
	});

	it("uses saved prose for each reader despite a later conflicting question link", () => {
		let { binding, editor, keys } = proseRoom(
			`Monitoring prose.\n\n${QUESTIONNAIRE}\nChecklist.\n`,
		);
		let widget = "01K0N4TR8K7JGM4R1J7PW4R8YJ";
		let question = "01K0N4V4E7Y6P4MJ5WD8XZF3B2";
		let store = new QuestionnaireStore();
		store.set(read(editor));
		store.bind(binding);
		store.anchors([{
			widget,
			questions: {
				[question]: { anchors: [proseAnchor(binding, keys[2]!)], pending: false },
			},
		}]);
		store.prose([prose(widget, proseAnchor(binding, keys[0]!))]);
		expect(store.blocks(widget, question)).toEqual([keys[0]]);
		expect(store.counts(widget)).toEqual({ [question]: 1 });

		store.prose([prose(widget, proseAnchor(binding, keys[0]!), true)]);
		expect(store.blocks(widget, question)).toEqual([]);
		expect(store.counts(widget)).toEqual({ [question]: 0 });
	});

	it("clears old targets and snapshots across teardown and rebind", () => {
		let first = proseRoom();
		let second = proseRoom();
		let store = new QuestionnaireStore();
		store.attach(first.editor);
		store.bind(first.binding);
		store.prose([prose("old", proseAnchor(first.binding, first.keys[0]!))]);
		expect(store.proseKey("old")).toBe(first.keys[0]);

		store.attach(undefined);
		store.bind(undefined);
		store.prose([prose("late-old", proseAnchor(first.binding, first.keys[1]!))]);
		store.attach(second.editor);
		store.bind(second.binding);
		expect(store.proseTargets()).toEqual([]);

		store.prose([prose("new", proseAnchor(second.binding, second.keys[2]!))]);
		expect(store.proseTargets()).toEqual([{ widget: "new", key: second.keys[2] }]);
	});

	it("discards a pending snapshot when an epoch resets before binding", () => {
		let { binding, keys } = proseRoom();
		let store = new QuestionnaireStore();
		store.prose([prose("old", proseAnchor(binding, keys[0]!))]);

		store.bind(undefined);
		store.bind(binding);

		expect(store.proseTargets()).toEqual([]);
	});

	it("reorders moved prose and drops a deleted paragraph on refresh", () => {
		let { binding, editor, keys } = proseRoom();
		let store = new QuestionnaireStore();
		store.bind(binding);
		store.prose([
			prose("first", proseAnchor(binding, keys[0]!)),
			prose("third", proseAnchor(binding, keys[2]!)),
		]);

		editor.update(() => {
			$getRoot().getChildren()[0]!.insertBefore($getRoot().getChildren()[2]!);
		}, { discrete: true });
		store.prose([
			prose("first", proseAnchor(binding, keys[0]!)),
			prose("third", proseAnchor(binding, keys[2]!)),
		]);
		store.refreshProse();
		expect(store.proseTargets()).toEqual([
			{ widget: "third", key: keys[2] },
			{ widget: "first", key: keys[0] },
		]);

		editor.update(() => {
			$getNodeByKey(keys[0]!)?.remove();
		}, { discrete: true });
		store.refreshProse();
		expect(store.proseTargets()).toEqual([{ widget: "third", key: keys[2] }]);
	});

	it("re-resolves anchors received before the collaborative block reaches Lexical", async () => {
		let source = proseRoom();
		let target = proseRoom("");
		let store = new QuestionnaireStore();
		store.bind(target.binding);
		let pending: Parameters<typeof syncYjsChangesToLexical>[2] = [];
		target.binding.root.getSharedType().observeDeep(events => {
			pending = events.filter(event => event.delta !== undefined) as typeof pending;
		});

		Y.applyUpdate(target.binding.doc, Y.encodeStateAsUpdate(source.binding.doc));
		store.prose([prose("late", proseAnchor(source.binding, source.keys[1]!))]);
		expect(store.proseKey("late")).toBeUndefined();

		syncYjsChangesToLexical(target.binding, PROVIDER, pending, false, () => {});
		await new Promise(resolve => setTimeout(resolve, 0));
		store.refreshProse();
		let text: string | undefined;
		target.editor.getEditorState().read(() => {
			text = $getNodeByKey(store.proseKey("late") ?? "")?.getTextContent();
		});
		expect(text).toBe("Second paragraph.");
	});
});
