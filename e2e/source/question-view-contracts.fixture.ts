import type { Draft } from "../../packages/question/src/draft";

type Mode =
	| "open"
	| "empty"
	| "linked"
	| "unlinked"
	| "discarded-single"
	| "discarded-multiple"
	| "legacy-custom"
	| "readonly-shared"
	| "readonly-sidebar";
type Event = { kind: "enter" | "leave" | "select"; question: string };

declare global {
	interface Window {
		questionViewContractsFixture: {
			mount(mode: Mode): void;
			sharing(): { opens: number; mutations: number; errors: string[] };
			resetEvents(): void;
			snapshot(): { draft: Draft; events: Event[]; submitted: number; discarded: number };
		};
	}
}

export let questionViewContractsBinding = `
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { AUTH } from "../../../question/src/react/question-view.test-fixtures";
import { DecisionPrompt } from "../../../../apps/web/src/chat/decision-entry";
let contractsRoot = createRoot(document.querySelector("#fixture"));
let contractsGeneration = 0;
let contractsEvents = [];
let contractsSubmitted = 0;
let contractsDiscarded = 0;
const DISCARDED_MULTIPLE = {
 questions: [AUTH.questions[0], {
  id: "scope",
  header: "Scope",
  question: "What belongs in the first cut?",
  multiple: true,
  options: [{ id: "anchors", label: "Anchors", description: "" }],
 }],
};
let sharing = { opens: 0, mutations: 0, errors: [] };
const sharingValue = { id: "readonly-shared-card", questions: AUTH.questions.map(question => ({
 ...question, prompt: question.question })) };
const sharingMeta = { status: "open", origin: "conversation", involved: [], history: [],
 optionOrigins: {}, hasProse: false, refining: false, proseOrphaned: false,
 suggested: { optionId: "b", revision: 0, messageIds: ["fixture-suggestion"] } };
const sharingWire = {
 ask(kind) {
  if (kind === "question:open") {
   sharing.opens++;
   if (sharing.opens === 8) { sharing.errors.push("question-open limit"); contractsRoot.unmount(); }
  } else sharing.mutations++;
  return new Promise(() => {});
 },
 send(kind) { if (kind !== "question:presence") sharing.mutations++; },
 on() { return () => {}; },
};
function ReadonlySharingFixture({ mode }) {
 return createElement("div", null,
  createElement("section", { "aria-label": "Document" }, createElement(Undecided, { value: sharingValue, wire: sharingWire, connected: true,
   canEdit: false, meta: sharingMeta })),
  mode === "readonly-sidebar" ? createElement("section", { "aria-label": "Decisions" },
   createElement(QuestionnaireCard, { value: sharingValue, wire: sharingWire, connected: false,
    canEdit: false, meta: sharingMeta, presentation: "list", motionImmediately: () => true }))
  : createElement(DecisionPrompt, { value: sharingValue, wire: sharingWire, connected: true,
   canEdit: false, meta: sharingMeta, latest: true, onOpenCard() {}, entry: {
    id: "readonly-prompt", author: { kind: "system" }, text: "Ready to decide", ts: 1,
    decision: { questionnaireId: sharingValue.id, kind: "prompt", generation: 0 } } }));
}
function DiscardedContractsFixture({ mode }) {
 return createElement(SidecarCard, { label: "Decision", padded: false },
  createElement(QuestionView, {
   definition: mode === "discarded-multiple" ? DISCARDED_MULTIPLE : AUTH,
   drafts: {}, resolver: "ben", status: "discarded",
   onSubmit: () => contractsSubmitted++, onDiscard: () => contractsDiscarded++ }));
}
function ContractsFixture({ mode }) {
 let [draft, setDraft] = useState({ mode: mode === "legacy-custom" ? "custom" : "choices",
  choice: mode === "empty" || mode === "legacy-custom" ? null : "b",
  options: { a: false, b: false }, custom: mode === "legacy-custom" ? "Another auth approach" : "" });
 window.questionViewContractsFixture.snapshot = () => ({ draft: structuredClone(draft),
  events: structuredClone(contractsEvents), submitted: contractsSubmitted, discarded: contractsDiscarded });
 return createElement(SidecarCard, { label: "Decision", padded: false },
  createElement(QuestionView, { definition: AUTH, drafts: { q: draft },
   aside: createElement(PresenceFaces, { handles: ["ana", "bea", "ana"], label: "In this decision" }),
   places: { q: mode === "linked" ? 2 : 0 },
   onChange: (_, change) => setDraft(previous => ({ ...previous, ...change })),
   onSubmit: () => contractsSubmitted++, onDiscard: () => contractsDiscarded++,
   onAddOption: async () => ({ ok: true }),
   onQuestionEnter: question => contractsEvents.push({ kind: "enter", question }),
   onQuestionLeave: question => contractsEvents.push({ kind: "leave", question }),
   onQuestionSelect: question => contractsEvents.push({ kind: "select", question }) }));
}
window.questionViewContractsFixture = {
 mount(mode) {
  contractsEvents = []; contractsSubmitted = 0; contractsDiscarded = 0;
  sharing = { opens: 0, mutations: 0, errors: [] };
  let component = (mode === "readonly-shared" || mode === "readonly-sidebar") ? ReadonlySharingFixture : mode === "discarded-single" || mode === "discarded-multiple"
   ? DiscardedContractsFixture : ContractsFixture;
  contractsRoot.render(createElement(component, { mode, key: ++contractsGeneration }));
 },
 sharing() { return structuredClone(sharing); },
 resetEvents() { contractsEvents = []; },
 snapshot() { throw new Error("QuestionView contracts not mounted"); },
};
`;
