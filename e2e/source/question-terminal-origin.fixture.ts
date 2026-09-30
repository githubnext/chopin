import type { Draft } from "../../packages/question/src/draft";

declare global {
	interface Window {
		terminalOriginFixture: {
			mount(mode: "suggestion" | "discarded" | "cancelled" | "gallery"): void;
			suggestion(present: boolean): void;
			empty(): void;
			snapshot(): Draft;
		};
	}
}

export let terminalOriginBinding = `
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { AUTH } from "../../../question/src/react/question-view.test-fixtures";
import { DECIDED, META } from "./questionnaire-metadata.test-fixtures";
let terminalRoot = createRoot(document.querySelector("#fixture"));
let terminalGeneration = 0;
function SuggestionFixture() {
 let [draft, setDraft] = useState({ mode: "choices", choice: null, options: { a: false, b: false }, custom: "" });
 let [suggested, setSuggested] = useState({ optionId: "b", revision: 7 });
 window.terminalOriginFixture.suggestion = present => setSuggested(present ? { optionId: "b", revision: 8 } : undefined);
 window.terminalOriginFixture.empty = () => setDraft({ mode: "choices", choice: null, options: { a: false, b: false }, custom: "" });
 window.terminalOriginFixture.snapshot = () => structuredClone(draft);
 return createElement(QuestionView, { definition: AUTH, drafts: { q: draft }, suggested,
  onChange: (_, change) => setDraft(previous => ({ ...previous, ...change })) });
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
  let component = mode === "suggestion" ? SuggestionFixture : mode === "discarded" ? DiscardedFixture
   : mode === "cancelled" ? CancelledFixture : TerminalGallery;
  terminalRoot.render(createElement(component, { key: ++terminalGeneration }));
 },
 suggestion() { throw new Error("Suggestion controls not mounted"); },
 empty() { throw new Error("Suggestion controls not mounted"); },
 snapshot() { throw new Error("Suggestion controls not mounted"); },
};
`;
