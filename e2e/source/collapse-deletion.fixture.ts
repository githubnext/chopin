import { decisionReaderBinding } from "./decision-reader.fixture";
import type { Question } from "../../packages/protocol/index";

declare global {
	interface Window {
		collapseFixture: {
			mount(readonly?: boolean): void;
			unmount(): void;
			ready(): boolean;
			requests: Array<{ kind: string; payload?: Record<string, unknown> }>;
			errors: string[];
			signals: Array<{ kind: string; payload: { id: string } }>;
			settle(ok: boolean): void;
			status(status: Question.CardMeta["status"], hasProse?: boolean, resolver?: string): void;
			snapshot(): {
				cards: string[];
				text: string;
				selected?: string;
				selection?: { kind: string; collapsed?: boolean };
				statuses: Array<{ id: string; status?: string }>;
			};
			selectAfter(): void;
			selectCard(): void;
			selectAfterDiscarded(): void;
			selectAcrossCard(): void;
		};
	}
}
let collapseBinding = `
import { $createQuestionnaireNode, $isQuestionnaireNode } from "@chopin/dialect";
import { $getSelection, $isRangeSelection, $createNodeSelection, $createRangeSelection, $isNodeSelection, $setSelection } from "lexical";
import { register } from "./widgets";
import { QuestionnaireObserver } from "./questionnaires";
import { QuestionnaireCard } from "./widgets/questionnaire";
import { useCardMeta } from "./card-meta";
import { DecisionDeletionPlugin } from "./widgets/decision-deletion";
import { DiscardedNavigationPlugin } from "./widgets/discarded-navigation";
import { create as createDraft } from "@chopin/question";
import type { LexicalEditor } from "lexical";
register();
let collapseRoot: Root | undefined;
let collapseReader: Reader;
let collapseEditor: LexicalEditor | undefined;
let collapseStop: (() => void) | undefined;
let collapseReply: ((value: { ok: boolean }) => void) | undefined;
let afterKey: string;
let cardKey: string;
let seedValue = { ...value, thread: "reader-thread", by: "ana" };
let draftDefinition = { questions: seedValue.questions.map(question => ({ id: question.id, header: question.header,
 question: question.prompt, multiple: question.multiple, options: question.options.map(option => ({ ...option, description: "" })) })) };
function CollapseSeed() {
 let [editor] = useLexicalComposerContext();
 useLayoutEffect(() => {
  collapseEditor = editor;
  let doc = new Y.Doc();
  let binding = createYjsBinding({ editor, id: "collapse", doc, docMap: new Map([["collapse", doc]]) });
  let stop = editor.registerUpdateListener(({ dirtyElements, dirtyLeaves, editorState, normalizedNodes, prevEditorState, tags }) => {
   syncLexicalUpdateToYjs(binding, provider, prevEditorState, editorState, dirtyElements, dirtyLeaves, normalizedNodes, tags);
  });
  editor.update(() => {
   let document = $getRoot(); document.clear();
   let before = $createParagraphNode().append($createTextNode("We use GitHub Apps for authentication."));
   let card = $createQuestionnaireNode(seedValue);
   let after = $createParagraphNode().append($createTextNode("Following detail."));
   afterKey = after.getKey(); cardKey = card.getKey();
   document.append(before, card, after, $createQuestionnaireNode({ ...seedValue, id: "discarded-card", status: "discarded" }),
    $createParagraphNode().append($createTextNode("After discarded.")));
  }, { discrete: true });
  let key = editor.getEditorState().read(() => $getRoot().getChildren()[0]!.getKey());
  collapseReader.store.attach(editor); collapseReader.store.bind(binding);
  collapseReader.store.prose([{ widget: seedValue.id, anchors: [anchor(binding, key)], orphaned: false }]);
  collapseReader.ready = true;
  return () => { stop(); collapseReader.store.attach(undefined); collapseEditor = undefined; doc.destroy(); };
 }, [editor]);
 return null;
}
function ListProjection({ readonly }: { readonly: boolean }) {
 let current = useCardMeta(collapseReader.meta, seedValue.id);
 return <aside data-list-projection><QuestionnaireCard value={seedValue} meta={current} presentation="list"
  wire={collapseReader.wire} connected={true} canEdit={!readonly} /></aside>;
}
function CollapseView({ readonly }: { readonly: boolean }) {
 return <RealmContext.Provider value={collapseReader.realm}><main className="plan" data-collapse-host>
  <section className="plan-document"><div data-plan-scroll>
   <LexicalComposer initialConfig={{ namespace: "native-collapse", nodes: registry().nodes, editable: !readonly,
    onError: error => { window.collapseFixture.errors.push(error.message); throw error; } }}>
    <RichTextPlugin contentEditable={<ContentEditable className="plan-content" aria-label="Collapse document" tabIndex={0} />}
     placeholder={null} ErrorBoundary={LexicalErrorBoundary} />
    <CollapseSeed /><QuestionnaireObserver store={collapseReader.store} /><ResolvedLayer store={collapseReader.store} />
    <DecisionDeletionPlugin /><DiscardedNavigationPlugin />
   </LexicalComposer>
  </div></section><ListProjection readonly={readonly} />
 </main></RealmContext.Provider>;
}
window.collapseFixture = {
 requests: [], errors: [], signals: [],
 mount(readonly = false) {
  this.unmount(); this.requests = []; this.errors = []; this.signals = [];
  let listeners = new Map<string, Set<(frame: unknown) => void>>();
  let wire: Transport = {
   on<T>(kind: string, callback: (frame: T) => void) { let set = listeners.get(kind) ?? new Set(); listeners.set(kind, set);
    let handler = callback as (frame: unknown) => void; set.add(handler); return () => { set.delete(handler); }; },
   send(kind, payload) {
    if (kind !== "question:presence" || payload?.id !== seedValue.id || Object.keys(payload).length !== 1)
     throw new Error("Unexpected native draft write " + kind + " " + JSON.stringify(payload));
    window.collapseFixture.signals.push({ kind, payload: { id: seedValue.id } });
   },
   ask<T>(kind: string, payload?: Record<string, unknown>): Promise<T> {
    if (kind === "question:open") return Promise.resolve({ open: true, definition: draftDefinition,
     model: [...createDraft(draftDefinition).toBinary()], revision: 0, presence: [] } as T);
    window.collapseFixture.requests.push({ kind, payload });
    if (collapseReply) throw new Error("Unexpected concurrent request");
    return new Promise<T>(resolve => { collapseReply = reply => resolve(reply as T); });
   },
  };
  let cardMeta = new NativeCardMetaStore(); collapseStop = cardMeta.listen(wire);
  let frame = (kind: string, value: unknown) => { for(let callback of listeners.get(kind) ?? []) callback(value); };
  frame("question:metas", { cards: [{ id: seedValue.id, meta }, { id: "discarded-card", meta: { ...meta, status: "discarded" } }] });
  let store = new NativeQuestionnaireStore(); let realm = new Realm();
  realm.pub(widgets$, { questions: store, cardMeta, connected: true, canEdit: !readonly, wire });
  collapseReader = { realm, store, meta: cardMeta, wire, frame, ready: false };
  collapseRoot = createRoot(document.querySelector("#fixture")!); collapseRoot.render(<CollapseView readonly={readonly} />);
 },
 unmount() { collapseRoot?.unmount(); collapseRoot = undefined; collapseStop?.(); collapseReply = undefined; },
 ready() { return !!collapseReader?.ready; },
 settle(ok) { let done = collapseReply; collapseReply = undefined; if (!done) throw new Error("No held collapse request"); done({ ok }); },
 status(status, hasProse = true, resolver = meta.resolver) { collapseReader.frame("question:meta", { id: seedValue.id, meta: { ...meta, status, hasProse, resolver } }); },
 snapshot() { return collapseEditor!.getEditorState().read(() => {
  let selection = $getSelection();
  return { cards: $getRoot().getChildren().filter($isQuestionnaireNode).map(node => node.getId()),
   statuses: $getRoot().getChildren().filter($isQuestionnaireNode).map(node => ({ id: node.getId(), status: node.getQuestionnaire().status })),
   selection: $isRangeSelection(selection) ? { kind: "range", collapsed: selection.isCollapsed() } : $isNodeSelection(selection) ? { kind: "node" } : undefined,
   text: $getRoot().getTextContent(), selected: $isRangeSelection(selection) ? selection.anchor.getNode().getTextContent() : undefined };
 }); },
 selectAfter() { collapseEditor!.update(() => { $getRoot().getChildren().find(node => node.getKey() === afterKey)!.selectStart(); }, { discrete: true }); },
 selectAfterDiscarded() { collapseEditor!.update(() => { $getRoot().getChildren().at(-1)!.selectStart(); }, { discrete: true }); },
 selectAcrossCard() { collapseEditor!.update(() => {
  let before = $getRoot().getChildren()[0]!.getFirstChild()!;
  let after = $getRoot().getChildren().find(node => node.getKey() === afterKey)!.getFirstChild()!;
  let selection = $createRangeSelection();
  selection.anchor.set(before.getKey(), before.getTextContentSize(), "text");
  selection.focus.set(after.getKey(), 0, "text");
  $setSelection(selection);
 }, { discrete: true }); },
 selectCard() { collapseEditor!.update(() => { let selection = $createNodeSelection(); selection.add(cardKey); $setSelection(selection); }, { discrete: true }); },
};
`;
export let collapseDeletionBinding = decisionReaderBinding + "\n" + collapseBinding;
