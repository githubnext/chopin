import type { Draft } from "../../packages/question/src/draft";

declare global {
	interface Window {
		terminalOriginFixture: {
			mount(mode: "suggestion" | "legacy-custom" | "discarded" | "cancelled" | "gallery"): void;
			suggestion(present: boolean): void;
			empty(): void;
			snapshot(): Draft;
			additions(): { question: string; label: string }[];
			publishOption(): void;
			acknowledgeOption(): void;
		};
	}
}

export let terminalOriginBinding = `
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { appendOption, decision } from "../../../question/src/schema";
import { AUTH } from "../../../question/src/react/question-view.test-fixtures";
import { DECIDED, META } from "./questionnaire-metadata.test-fixtures";
let terminalRoot = createRoot(document.querySelector("#fixture"));
let terminalGeneration = 0;
function SuggestionFixture({ legacy = false }) {
 let [definition, setDefinition] = useState(AUTH);
 let additions = useRef([]);
 let pending = useRef();
 let [draft, setDraft] = useState({ mode: legacy ? "custom" : "choices", choice: null, options: { a: false, b: false }, custom: legacy ? "Another approach" : "" });
 let [suggested, setSuggested] = useState(legacy ? undefined : { optionId: "b", revision: 7 });
 window.terminalOriginFixture.suggestion = present => setSuggested(present ? { optionId: "b", revision: 8 } : undefined);
 window.terminalOriginFixture.empty = () => setDraft({ mode: "choices", choice: null, options: { a: false, b: false }, custom: "" });
 window.terminalOriginFixture.snapshot = () => structuredClone(draft);
 window.terminalOriginFixture.additions = () => structuredClone(additions.current);
 window.terminalOriginFixture.publishOption = () => {
  if (!pending.current) throw new Error("No pending option to publish");
  setDefinition(pending.current.definition);
 };
 window.terminalOriginFixture.acknowledgeOption = () => {
  if (!pending.current) throw new Error("No pending option to acknowledge");
  pending.current.resolve({ ok: true });
  pending.current = undefined;
 };
 return createElement(QuestionView, { definition, drafts: { q: draft }, suggested,
  onChange: (_, change) => setDraft(previous => ({ ...previous, ...change })),
  onSubmit: () => {},
  onAddOption: (question, label) => {
   additions.current.push({ question, label });
   let result = appendOption(decision(definition), { question, label, key: "native-option-0001" }, "native-added");
   if (!result.ok) return Promise.resolve({ ok: false, message: result.message });
   return new Promise(resolve => { pending.current = { definition: result.definition, resolve }; });
  } });
}
function DiscardedFixture() {
 return createElement(QuestionnaireCard, { value: DECIDED, presentation: "list",
  meta: { ...META, status: "discarded", resolver: "bea" }, connected: false, canEdit: false });
}
function CancelledFixture() {
 return createElement(QuestionView, { definition: AUTH, drafts: {}, status: "cancelled", resolver: "ana" });
}
function TerminalGallery() {
 return createElement("div", { className: "flex flex-wrap gap-4" },
  createElement("section", { className: "w-80" }, createElement(SuggestionFixture)),
  createElement("section", { className: "w-80" }, createElement(DiscardedFixture)),
  createElement("section", { className: "w-80" }, createElement(CancelledFixture)));
}
window.terminalOriginFixture = {
 mount(mode) {
  let component = mode === "suggestion" || mode === "legacy-custom" ? SuggestionFixture : mode === "discarded" ? DiscardedFixture
   : mode === "cancelled" ? CancelledFixture : TerminalGallery;
  terminalRoot.render(createElement(component, { key: ++terminalGeneration, legacy: mode === "legacy-custom" }));
 },
 suggestion() { throw new Error("Suggestion controls not mounted"); },
 empty() { throw new Error("Suggestion controls not mounted"); },
 snapshot() { throw new Error("Suggestion controls not mounted"); },
 additions() { throw new Error("Suggestion controls not mounted"); },
 publishOption() { throw new Error("Suggestion controls not mounted"); },
 acknowledgeOption() { throw new Error("Suggestion controls not mounted"); },
};
`;
