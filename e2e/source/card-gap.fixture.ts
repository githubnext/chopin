type GapFlags = { canEdit: boolean; connected: boolean; synced: boolean };
type GapSnapshot = {
	keys: string[];
	types: string[];
	texts: string[];
	expected: string[];
	initial: string[];
	selection?: { collapsed: boolean; key: string };
	yjs: {
		update: number[];
		xml: string;
		roundtrip: string;
		blocks: Array<{ type: string; text: string; state?: unknown }>;
		restoredBlocks: Array<{ type: string; text: string; state?: unknown }>;
	};
};
declare global {
	interface Window {
		cardGapFixture: {
			mount(flags: GapFlags, selection?: "caret" | "range"): void;
			flags(flags: GapFlags): void;
			plugin(mounted: boolean): void;
			seed(selection?: "caret" | "range"): void;
			ready(): boolean;
			snapshot(): GapSnapshot;
			errors: string[];
		};
	}
}
export let cardGapBinding = `
import { useLayoutEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { RichTextPlugin } from "@lexical/react/LexicalRichTextPlugin";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { Realm, RealmContext } from "@mdxeditor/gurx";
import { createYjsBinding, syncLexicalUpdateToYjs } from "@lexical/yjs";
import { $createParagraphNode, $createTextNode, $createRangeSelection, $setSelection } from "lexical";
import * as Y from "yjs";
import { $createQuestionnaireNode, $createDecisionNode, registry } from "@chopin/dialect";
import { register } from "./index";
import type { Binding, Provider } from "@lexical/yjs";
register();
let provider: Provider = { awareness: { getLocalState: () => null, getStates: () => new Map(),
 off() {}, on() {}, setLocalState() {}, setLocalStateField() {} }, connect() {}, disconnect() {},
 off() {}, on() {} } as unknown as Provider;
let gapRoot;
let gapEditor;
let gapRealm;
let gapDoc;
let gapBinding: Binding;
let gapReady = false;
let gapFlags;
let gapSelection;
let setPlugin;
let gapInitial: string[] = [];
let gapExpected: string[] = [];
function gapSharedBlocks(doc) {
 return doc.get("root", Y.XmlText).toDelta().map(operation => {
  let node = operation.insert;
  if (!(node instanceof Y.XmlText) && !(node instanceof Y.XmlElement)) throw new Error("Unexpected canonical Yjs root item");
  let attributes = node.getAttributes();
  let state = attributes.__state;
  if (state !== undefined && !(state instanceof Y.Map)) throw new Error("Unexpected canonical card state");
  return { type: attributes.__type, text: node.toString(), state: state?.toJSON() };
 });
}
function seedGap(selection) {
 gapEditor.update(() => {
  let leading = $createParagraphNode();
  let first = $createQuestionnaireNode({ id: "gap-q1", questions: [{ id: "q1", header: "First decision", prompt: "Choose first", multiple: false, options: [{ id: "o1", label: "First" }] }] });
  let a = Array.from({ length: 3 }, () => $createParagraphNode());
  let second = $createDecisionNode({ id: "gap-d1", quote: "First accepted", by: "ana", at: "2026-09-30T00:00:00Z", notes: [] });
  let prose = $createParagraphNode().append($createTextNode("Keep this exact prose."));
  let third = $createQuestionnaireNode({ id: "gap-q2", questions: [{ id: "q2", header: "Second decision", prompt: "Choose second", multiple: false, options: [{ id: "o2", label: "Second" }] }] });
  let b = Array.from({ length: 2 }, () => $createParagraphNode());
  let fourth = $createDecisionNode({ id: "gap-d2", quote: "Second accepted", by: "ben", at: "2026-09-30T00:00:00Z", notes: [] });
  let tail = [$createParagraphNode(), $createParagraphNode()];
  let children = [leading, first, ...a, second, prose, third, ...b, fourth, ...tail];
  $getRoot().clear().append(...children);
  gapInitial = children.map(node => node.getKey());
  gapExpected = [leading, first, a[0], second, prose, third, b[0], fourth, ...tail].map(node => node.getKey());
  if (selection === "caret") a[1].select();
  else if (selection === "range") {
   let range = $createRangeSelection();
   range.anchor.set(a[1].getKey(), 0, "element");
   range.focus.set(prose.getFirstChild().getKey(), 4, "text");
   $setSelection(range);
  } else $setSelection(null);
 }, { discrete: true });
}
function GapSeed() {
 let [editor] = useLexicalComposerContext();
 useLayoutEffect(() => {
  gapEditor = editor;
  gapDoc = new Y.Doc();
  gapBinding = createYjsBinding({ editor, id: "card-gap", doc: gapDoc, docMap: new Map([["card-gap", gapDoc]]) });
  let stop = editor.registerUpdateListener(({ dirtyElements, dirtyLeaves, editorState, normalizedNodes, prevEditorState, tags }) => {
   syncLexicalUpdateToYjs(gapBinding, provider, prevEditorState, editorState, dirtyElements, dirtyLeaves, normalizedNodes, tags);
  });
  seedGap(gapSelection);
  gapReady = true;
  return () => { stop(); gapDoc.destroy(); gapReady = false; gapEditor = undefined; };
 }, [editor]);
 return null;
}
function GapView() {
 let [mounted, changeMounted] = useState(true); setPlugin = changeMounted;
 return <RealmContext.Provider value={gapRealm}><main className="plan"><section className="plan-document" data-gap-host>
  <LexicalComposer initialConfig={{ namespace: "native-card-gap", nodes: registry().nodes, editable: gapFlags.canEdit,
   onError: error => { window.cardGapFixture.errors.push(error.message); throw error; } }}>
   <RichTextPlugin contentEditable={<ContentEditable className="plan-content" aria-label="Gap document" />} placeholder={null} ErrorBoundary={LexicalErrorBoundary} />
   <GapSeed /><span data-gap-plugin-mounted={String(mounted)} />{mounted && <CardGapPlugin />}
  </LexicalComposer>
 </section></main></RealmContext.Provider>;
}
window.cardGapFixture = {
 errors: [],
 mount(flags, selection) {
  gapRoot?.unmount(); this.errors = []; gapFlags = flags; gapSelection = selection; gapRealm = new Realm(); gapRealm.pub(widgets$, flags);
  gapRoot = createRoot(document.querySelector("#fixture")); gapRoot.render(<GapView />);
 },
 flags(flags) { gapFlags = flags; gapEditor.setEditable(flags.canEdit); gapRealm.pub(widgets$, flags); },
 plugin(mounted) { setPlugin(mounted); },
 seed(selection) { seedGap(selection); },
 ready() { return gapReady; },
 snapshot() {
  let lexical = gapEditor.getEditorState().read(() => {
   let children = $getRoot().getChildren(); let selection = $getSelection();
   return { keys: children.map(node => node.getKey()), types: children.map(node => node.getType()), texts: children.map(node => node.getTextContent()),
    selection: $isRangeSelection(selection) ? { collapsed: selection.isCollapsed(), key: selection.anchor.getNode().getKey() } : undefined };
  });
  let update = Y.encodeStateAsUpdate(gapDoc); let restored = new Y.Doc(); Y.applyUpdate(restored, update);
  let xml = gapDoc.get("root", Y.XmlText).toString(); let roundtrip = restored.get("root", Y.XmlText).toString();
  let blocks = gapSharedBlocks(gapDoc); let restoredBlocks = gapSharedBlocks(restored); restored.destroy();
  return { ...lexical, initial: gapInitial, expected: gapExpected, yjs: { update: [...update], xml, roundtrip, blocks, restoredBlocks } };
 },
};
`;
