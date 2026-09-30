import { roomSourceBinding } from "./room-source.fixture";
import type { Question } from "../../packages/protocol/index";

declare global {
	interface Window {
		openCardProbe: {
			observe(value: unknown): void;
			mountCard(id?: string, source?: boolean): void;
			unmountCard(): void;
			ready(): boolean;
			peers(handles: string[]): void;
			meta(id: string, meta: Question.CardMeta): void;
			snapshot(): { id: string; ids: string[]; meta?: Question.CardMeta };
			errors: string[];
			opens: string[];
			signals: Array<{ kind: string; payload: { id: string } }>;
		};
	}
}

export let observeOpenCard =
	"\twindow.openCardProbe.observe({ questions, cardMeta, showCardSource });\n";

// The existing actual Room binding is reused unchanged; the auxiliary editor shares its stores.
export let openCardBinding = roomSourceBinding + `
import { useLayoutEffect } from "react";
import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { RichTextPlugin } from "@lexical/react/LexicalRichTextPlugin";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { Realm, RealmContext } from "@mdxeditor/gurx";
import { $getRoot } from "lexical";
import { $createQuestionnaireNode, registry } from "@chopin/dialect";
import { create as createDraft } from "@chopin/question";
import { register } from "../../../packages/editor/src/widgets";
import { QuestionnaireObserver } from "../../../packages/editor/src/questionnaires";
import { widgets$ } from "../../../packages/editor/src/widget-options";
import type { Transport } from "../../../packages/editor/src/transport";
register();
let openSnapshot;
let openRoot;
let openEditor;
let activeId = "card-1";
let openReady = false;
let openListeners = new Map<string, Set<(frame: unknown) => void>>();
let peerHandles: string[] = [];
let openDefinition = { questions: [{ id: "q1", header: "Rollout", question: "Choose rollout",
 multiple: false, options: [{ id: "o1", label: "Pilot", description: "" }, { id: "o2", label: "Broad", description: "" }] }] };
function openValue(id: string) { return { id, thread: id === "card-1" ? "thread-1" : "thread-2", status: "open",
 questions: [{ id: "q1", header: "Rollout", prompt: "Choose rollout", multiple: false,
 options: [{ id: "o1", label: "Pilot" }, { id: "o2", label: "Broad" }] }] }; }
let openWire: Transport = {
 on<T>(kind: string, callback: (frame: T) => void) {
  let set = openListeners.get(kind) ?? new Set(); openListeners.set(kind, set);
  let handler = callback as (frame: unknown) => void; set.add(handler); return () => { set.delete(handler); };
 },
 send(kind, payload) {
  if(kind !== "question:presence" || !["card-1", "card-2"].includes(payload?.id as string) || Object.keys(payload!).length !== 1)
   throw new Error("Unexpected open-card mutation " + kind + " " + JSON.stringify(payload));
  window.openCardProbe.signals.push({ kind, payload: { id: payload!.id as string } });
 },
 ask<T>(kind: string, payload?: Record<string, unknown>): Promise<T> {
  if(kind !== "question:open" || !["card-1", "card-2"].includes(payload?.id as string) || Object.keys(payload!).length !== 1)
   throw new Error("Unexpected open-card request " + kind + " " + JSON.stringify(payload));
  window.openCardProbe.opens.push(payload!.id as string);
  return Promise.resolve({ open: true, definition: openDefinition, model: [...createDraft(openDefinition).toBinary()], revision: 0,
   presence: peerHandles.map((handle,index) => ({ client: "peer-"+index, handle, question: "q1" })) } as T);
 },
};
function OpenSeed() {
 let [editor] = useLexicalComposerContext();
 useLayoutEffect(() => {
  openEditor = editor;
  editor.update(() => { $getRoot().clear().append($createQuestionnaireNode(openValue(activeId))); }, { discrete: true });
  openReady = true;
  return () => { openReady = false; openEditor = undefined; };
 }, [editor]);
 return null;
}
window.openCardProbe = {
 errors: [], opens: [], signals: [],
 observe(value) { openSnapshot = value; },
 mountCard(id = "card-1", source = true) {
  this.unmountCard(); activeId = id;
  let realm = new Realm();
  realm.pub(widgets$, { questions: openSnapshot.questions, cardMeta: openSnapshot.cardMeta,
   connected: true, canEdit: false, wire: openWire, onCardSource: source ? openSnapshot.showCardSource : undefined });
  openRoot = createRoot(document.querySelector("#open-card"));
  openRoot.render(<RealmContext.Provider value={realm}><main className="plan"><section className="plan-document" data-open-card-host>
   <LexicalComposer initialConfig={{ namespace: "native-open-card", nodes: registry().nodes, editable: false,
    onError: error => { window.openCardProbe.errors.push(error.message); throw error; } }}>
    <RichTextPlugin contentEditable={<ContentEditable className="plan-content" aria-label="Open card document" />}
     placeholder={null} ErrorBoundary={LexicalErrorBoundary} />
    <OpenSeed /><QuestionnaireObserver store={openSnapshot.questions} />
   </LexicalComposer>
  </section></main></RealmContext.Provider>);
 },
 unmountCard() { openRoot?.unmount(); openRoot = undefined; },
 ready() { return openReady; },
 peers(handles) {
  let previous = peerHandles; peerHandles = handles;
  for(let index=0;index<Math.max(previous.length,handles.length);index++)
   for(let callback of openListeners.get("question:presence") ?? [])
    callback({ id: activeId, client: "peer-"+index, handle: handles[index], question: handles[index] ? "q1" : undefined });
 },
 meta(id, meta) { window.roomSourceProbe.receive({ kind: "question:meta", id, meta, ts: 1 }); },
 snapshot() { return { id: activeId, ids: openSnapshot.questions.snapshot().map(entry => entry.id), meta: openSnapshot.cardMeta.get(activeId) }; },
};
`;
