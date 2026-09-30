import type { Question } from "../../packages/protocol/index";

type ReaderRequest = { reader: number; kind: string; payload?: Record<string, unknown> };
declare global {
	interface Window {
		decisionReaderFixture: {
			mount(readonly?: boolean, count?: number): void;
			unmount(): void;
			requests: ReaderRequest[];
			sources: string[];
			errors: string[];
			ready(): boolean;
			settle(ok: boolean): void;
			status(reader: number, status: Question.CardMeta["status"]): void;
		};
	}
}

export let decisionReaderBinding = `import { createRoot } from "react-dom/client";
import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { RichTextPlugin } from "@lexical/react/LexicalRichTextPlugin";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { Realm, RealmContext } from "@mdxeditor/gurx";
import { createYjsBinding, syncLexicalUpdateToYjs } from "@lexical/yjs";
import { $createParagraphNode, $createTextNode, $getRoot } from "lexical";
import * as Y from "yjs";
import { registry } from "@chopin/dialect";
import { QuestionnaireStore as NativeQuestionnaireStore } from "./questionnaires";
import { CardMetaStore as NativeCardMetaStore } from "./card-meta";
import type { Root } from "react-dom/client";
import type { Binding, Provider } from "@lexical/yjs";
import type { Transport } from "./transport";

type ReaderRequest = { reader: number; kind: string; payload?: Record<string, unknown> };
type Reader = { realm: Realm; store: NativeQuestionnaireStore; meta: NativeCardMetaStore; wire: Transport;
	frame: (kind: string, value: unknown) => void; ready: boolean };
declare global {
	interface Window {
		decisionReaderFixture: {
			mount(readonly?: boolean, count?: number): void;
			unmount(): void;
			requests: ReaderRequest[];
			sources: string[];
			errors: string[];
			ready(): boolean;
			settle(ok: boolean): void;
			status(reader: number, status: Question.CardMeta["status"]): void;
		};
	}
}
let root: Root | undefined;
let readers: Reader[] = [];
let stops: Array<() => void> = [];
let settle: ((value: { ok: boolean }) => void) | undefined;
let value: Questionnaire = { id: "reader-card", status: "decided", questions: [{
	id: "reader-question", header: "Authentication", prompt: "Which authentication?", multiple: false,
	options: [{ id: "github", label: "GitHub Apps" }, { id: "auth0", label: "Auth0" }],
	choices: ["github"], answer: "GitHub Apps",
}] };
let meta: Question.CardMeta = { status: "decided", origin: "conversation", thread: "reader-thread",
	owner: "ana", resolver: "ana", decidedAt: 1790766000, involved: ["ana"], history: [],
	optionOrigins: {}, refining: false, hasProse: true, proseOrphaned: false };
let provider: Provider = { awareness: { getLocalState: () => null, getStates: () => new Map(),
	off() {}, on() {}, setLocalState() {}, setLocalStateField() {} }, connect() {}, disconnect() {},
	off() {}, on() {} } as unknown as Provider;
function anchor(binding: Binding, key: string) {
	let type = binding.collabNodeMap.get(key)?.getSharedType();
	if (!type) throw new Error("No real collaborative paragraph");
	let position = Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(type, 0, -1));
	return { epoch: "reader-epoch", digest: "sha256:reader", position: btoa(String.fromCharCode(...position)) };
}
function Seed({ reader }: { reader: Reader }) {
	let [editor] = useLexicalComposerContext();
	useLayoutEffect(() => {
		let doc = new Y.Doc();
		let binding = createYjsBinding({ editor, id: "reader", doc, docMap: new Map([["reader", doc]]) });
		let stop = editor.registerUpdateListener(({ dirtyElements, dirtyLeaves, editorState, normalizedNodes, prevEditorState, tags }) => {
			syncLexicalUpdateToYjs(binding, provider, prevEditorState, editorState, dirtyElements, dirtyLeaves, normalizedNodes, tags);
		});
		editor.update(() => {
			let document = $getRoot();
			document.clear();
			for (let index = 0; index < 24; index++) document.append($createParagraphNode().append($createTextNode(
				index === 3 ? "We use GitHub Apps for authentication." : \`Reader context paragraph \${index}.\`
			)));
		}, { discrete: true });
		let key = editor.getEditorState().read(() => $getRoot().getChildren()[3]!.getKey());
		reader.store.attach(editor);
		reader.store.bind(binding);
		reader.store.set({ entries: [{ id: value.id, value }], hasPlanContent: true });
		reader.store.prose([{ widget: value.id, anchors: [anchor(binding, key)], orphaned: false }]);
		reader.ready = true;
		return () => { stop(); reader.store.attach(undefined); doc.destroy(); };
	}, [editor, reader]);
	return null;
}
function ReaderView({ reader, index, readonly }: { reader: Reader; index: number; readonly: boolean }) {
	return <RealmContext.Provider value={reader.realm}>
		<section className="plan-document" data-reader={index}>
			<div data-plan-scroll>
				<LexicalComposer initialConfig={{ namespace: \`native-reader-\${index}\`, nodes: registry().nodes,
					editable: !readonly, onError: error => { window.decisionReaderFixture.errors.push(error.message); throw error; } }}>
					<RichTextPlugin contentEditable={<ContentEditable className="plan-content" aria-label={\`Reader \${index} document\`} />}
						placeholder={null} ErrorBoundary={LexicalErrorBoundary} />
					<Seed reader={reader} />
					<DecisionLayer store={reader.store} />
				</LexicalComposer>
			</div>
		</section>
	</RealmContext.Provider>;
}
window.decisionReaderFixture = {
	requests: [], sources: [], errors: [],
	mount(readonly = true, count = 1) {
		this.unmount(); this.requests = []; this.sources = []; this.errors = [];
		readers = Array.from({ length: count }, (_, index) => {
			let listeners = new Map<string, Set<(value: unknown) => void>>();
			let wire: Transport = {
				on<T>(kind: string, callback: (frame: T) => void) {
					let handlers = listeners.get(kind) ?? new Set(); listeners.set(kind, handlers);
					let handler = callback as (frame: unknown) => void; handlers.add(handler);
					return () => { handlers.delete(handler); };
				},
				send() { throw new Error("Unexpected native reader send"); },
				ask<T>(kind: string, payload?: Record<string, unknown>) {
					window.decisionReaderFixture.requests.push({ reader: index, kind, payload });
					if (settle) throw new Error("Unexpected concurrent reader request");
					return new Promise<T>(resolve => { settle = reply => resolve(reply as T); });
				},
			};
			let cardMeta = new NativeCardMetaStore(); stops.push(cardMeta.listen(wire));
			let frame = (kind: string, frame: unknown) => { for (let listener of listeners.get(kind) ?? []) listener(frame); };
			frame("question:metas", { cards: [{ id: value.id, meta }] });
			let store = new NativeQuestionnaireStore(); let realm = new Realm();
			realm.pub(widgets$, { cardMeta, questions: store, canEdit: !readonly, connected: true, wire,
				onCardSource: id => window.decisionReaderFixture.sources.push(\`\${index}:\${id}\`) });
			return { realm, store, meta: cardMeta, wire, frame, ready: false };
		});
		root = createRoot(document.querySelector("#fixture")!);
		root.render(<main className="plan" data-reader-host>{readers.map((reader, index) => <ReaderView key={index} reader={reader} index={index} readonly={readonly} />)}</main>);
	},
	unmount() { root?.unmount(); root = undefined; for (let stop of stops) stop(); stops = []; settle = undefined; },
	ready() { return readers.length > 0 && readers.every(reader => reader.ready); },
	settle(ok) { let done = settle; settle = undefined; if (!done) throw new Error("No held reader request"); done({ ok }); },
	status(index, status) { readers[index]!.frame("question:meta", { id: value.id, meta: { ...meta, status } }); },
};
`;
