import type { Question } from "../../packages/protocol/index";

declare global {
	interface Window {
		evidenceFixture: {
			writes: string[];
			sources: string[];
			token: number;
			mount(editable?: boolean): void;
			unmount(): void;
			status(status: Question.CardMeta["status"] | undefined): void;
			replace(): void;
			empty(): void;
			long(): void;
			hide(): void;
			sourceText(text: string): void;
		};
	}
}

export let evidenceFixtureSource = `import { createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { QuestionnaireCard } from "../../../../packages/editor/src/widgets/questionnaire";
import { create } from "../../../../packages/question/src/draft";
import { EvidencePopover, EvidenceSummary } from "../conversation-plan/evidence-popover";
import { evidenceCounts } from "../conversation-plan/evidence";
import { META } from "../../../../packages/editor/src/widgets/questionnaire-metadata.test-fixtures";
import type { Questionnaire } from "@chopin/dialect";
import type { Question } from "@chopin/protocol";
import type { EvidenceRow } from "../conversation-plan/evidence";

declare global {
	interface Window {
		evidenceFixture: {
			writes: string[]; sources: string[]; token: number;
			mount(editable?: boolean): void; unmount(): void;
			status(status: Question.CardMeta["status"] | undefined): void;
			replace(): void; empty(): void; long(): void; hide(): void;
			sourceText(text: string): void;
		};
	}
}

let definition = {
	questions: [{ id: "q", header: "Auth", question: "What auth system should we use?", multiple: false,
		options: [{ id: "a", label: "Auth0", description: "" }, { id: "b", label: "GitHub Apps", description: "" }] }],
};
let value: Questionnaire = { id: "native-evidence-card", thread: "native-evidence-thread", questions: [{
	id: "q", header: "Auth", prompt: "What auth system should we use?", multiple: false,
	options: [{ id: "a", label: "Auth0" }, { id: "b", label: "GitHub Apps" }],
}] };
let quote = "People already have GitHub accounts.";
let source = { messageId: "native-source", author: { kind: "member" as const, handle: "mina" },
	quote, start: 0, end: quote.length, role: "reason" as const };
let rows: EvidenceRow[] = [{ optionId: "b", label: "GitHub Apps", origin: "chat", supporters: ["mina"],
	opposers: ["lee"], items: [{ id: "native-reason", kind: "reason", text: quote, sources: [source] }] }];
let entries: Chat.Entry[] = Array.from({ length: 16 }, (_, index) => ({ id: \`native-\${index}\`,
	author: { kind: "member", handle: "mina" }, text: \`Earlier message \${index}.\`, ts: index + 1 }));
entries[5] = { ...entries[5]!, id: source.messageId, text: quote };
let wire: Transport = {
	on: () => () => {},
	send(kind) { window.evidenceFixture.writes.push(kind); },
	async ask<T>(kind: string): Promise<T> {
		if (kind !== "question:open") throw new Error(\`Unexpected fixture mutation \${kind}\`);
		return { open: true, definition, model: [...create(definition).toBinary()], revision: 0, presence: [] } as T;
	},
};
let root = createRoot(document.querySelector("#fixture")!);
let generation = 0;
function Fixture({ editable }: { editable: boolean }) {
	let [meta, setMeta] = useState<Question.CardMeta | undefined>({ ...META, thread: value.thread, status: "open" });
	let [evidence, setEvidence] = useState(rows);
	let [visible, setVisible] = useState(true);
	let [destination, setDestination] = useState<ChatDestination>();
	let [sourceText, setSourceText] = useState(quote);
	window.evidenceFixture.status = status => setMeta(status ? { ...META, thread: value.thread, status } : undefined);
	window.evidenceFixture.replace = () => setEvidence(current => current.map(row => ({ ...row, supporters: ["mina", "jules"] })));
	window.evidenceFixture.empty = () => setEvidence([]);
	window.evidenceFixture.long = () => setEvidence(current => current.map(row => ({ ...row,
		items: Array.from({ length: 30 }, (_, index) => ({ id: \`reason-\${index}\`, kind: "reason", text: \`Evidence \${index}.\`, sources: [source] })) })));
	window.evidenceFixture.hide = () => setVisible(false);
	window.evidenceFixture.sourceText = setSourceText;
	return <main>
		<section className="plan-document"><div data-plan-scroll>
			{visible && <QuestionnaireCard value={value} meta={meta} connected canEdit={editable} wire={wire}
				onCardSource={() => window.evidenceFixture.sources.push("card-source")}
				evidence={evidence.length ? { summary: <EvidenceSummary counts={evidenceCounts(evidence)} />,
					content: <EvidencePopover rows={evidence} onSource={next => {
						window.evidenceFixture.sources.push(next.source.quote);
						setDestination({ ...next, token: ++window.evidenceFixture.token });
					}} /> } : null} />}
			<div style={{ height: 900 }} />
		</div></section>
		<section className="native-chat"><Transcript active entries={entries.map(entry => entry.id === source.messageId ? { ...entry, text: sourceText } : entry)}
			handle="mina" onWithdraw={() => {}} queued={[]} sourceDestination={destination} /></section>
		<button id="outside">Outside fixture</button>
	</main>;
}
window.evidenceFixture = {
	writes: [], sources: [], token: 0,
	mount(editable = false) { root.render(<Fixture key={++generation} editable={editable} />); },
	unmount() { root.unmount(); },
	status() {}, replace() {}, empty() {}, long() {}, hide() {}, sourceText() {},
};
`;
