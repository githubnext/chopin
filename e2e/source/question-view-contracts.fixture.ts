import type { Draft } from "../../packages/question/src/draft";

type Mode = "open" | "empty" | "linked" | "unlinked" | "discarded-single" | "discarded-multiple";
type Event = { kind: "enter" | "leave" | "select"; question: string };

declare global {
	interface Window {
		questionViewContractsFixture: {
			mount(mode: Mode): void;
			resetEvents(): void;
			snapshot(): { draft: Draft; events: Event[]; submitted: number; discarded: number };
		};
	}
}

export let questionViewContractsBinding = `
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { AUTH } from "../../../question/src/react/question-view.test-fixtures";
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
function DiscardedContractsFixture({ mode }) {
 return createElement(SidecarCard, { label: "Decision", padded: false },
  createElement(QuestionView, {
   definition: mode === "discarded-multiple" ? DISCARDED_MULTIPLE : AUTH,
   drafts: {}, resolver: "ben", status: "discarded",
   onSubmit: () => contractsSubmitted++, onDiscard: () => contractsDiscarded++ }));
}
function ContractsFixture({ mode }) {
 let [draft, setDraft] = useState({ mode: "choices", choice: mode === "empty" ? null : "b",
  options: { a: false, b: false }, custom: "" });
 window.questionViewContractsFixture.snapshot = () => ({ draft: structuredClone(draft),
  events: structuredClone(contractsEvents), submitted: contractsSubmitted, discarded: contractsDiscarded });
 return createElement(SidecarCard, { label: "Decision", padded: false },
  createElement(QuestionView, { definition: AUTH, drafts: { q: draft },
   aside: createElement(People, { handles: ["ana", "bea", "ana"] }),
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
  let component = mode === "discarded-single" || mode === "discarded-multiple"
   ? DiscardedContractsFixture : ContractsFixture;
  contractsRoot.render(createElement(component, { mode, key: ++contractsGeneration }));
 },
 resetEvents() { contractsEvents = []; },
 snapshot() { throw new Error("QuestionView contracts not mounted"); },
};
`;
