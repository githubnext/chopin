export const researchOffersFixture = String.raw`
import { createRoot } from "react-dom/client";
import * as Draft from "@chopin/draft";
import type { Wire } from "../wire";
import type { ResearchRequestStore } from "../research-requests";

let source: ConversationPlan.ResearchSource = { messageId: "original", author: { kind: "member", handle: "ana" }, quote: "Investigate Jev alternatives.", start: 0, end: 28 };
let offer: ConversationPlan.ResearchOffer = {
	id: "offer", needId: "topic", contextId: "scope", source, brief: source.quote, status: "offered",
	workflow: { version: 1, revision: 0, generation: 0, generationBrief: source.quote, mode: "automatic", placementMessageId: "original", sources: [source], context: { messages: [], decisions: [] }, published: true, preparation: "ready", editedBy: [], additions: [] },
};
let entries: Chat.Entry[] = [
	{ id: "original", author: source.author, text: source.quote, ts: 1 },
	{ id: "middle", author: { kind: "member", handle: "bo" }, text: "An unrelated message", ts: 2 },
	{ id: "later", author: { kind: "member", handle: "ana" }, text: "Include self-hosted options.", ts: 3 },
];
let state: ConversationPlan.State = { schemaVersion: 2, revision: 1, events: [], threads: [], queue: [], analysis: [], research: { queue: [], analysis: [], retries: [] }, researchOffers: [offer] };
let snapshot = { state, canAct: true, canExecute: true };
let listeners = new Set<() => void>();
let held = false;
let pending: Array<() => void> = [];
let started: string[] = [];
let requests: string[] = [];
function publish() {
	state = { ...state, revision: state.revision + 1, researchOffers: [structuredClone(offer)] };
	snapshot = { ...snapshot, state };
	for (let listener of listeners) listener();
}
function edit(operation: ConversationPlan.ResearchEdit["operation"]) {
	if (offer.status !== "offered") return;
	if (operation.kind === "begin" && !offer.workflow!.draft) {
		offer.workflow!.draft = Draft.binary(Draft.create(offer.brief));
		offer.workflow!.mode = "human";
	} else if (operation.kind === "patch") {
		let model = Draft.apply(Draft.restore(offer.workflow!.draft!), operation.patch);
		offer.workflow!.draft = Draft.binary(model);
		offer.brief = Draft.read(model);
	}
	offer.workflow!.revision++;
	publish();
}
function View({ handle }: { handle: string }) {
	let value = useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => snapshot);
	let controls: ResearchOfferControls = {
		links: {}, busy: new Set(), errors: {}, canAct: value.canAct, canExecute: value.canExecute, canCheckLink: false,
		store: { subscribe: () => () => {}, get: () => undefined, retain: () => () => {} } as unknown as ResearchRequestStore,
		wire: wires[handle],
		onAction: (_id, choice) => {
			if (choice === "research") { started.push(offer.brief); offer.status = "accepted"; }
			if (choice === "dismiss") offer.status = "dismissed";
			publish();
		},
		onRetryLink() {},
	};
	return <section aria-label={handle}><Transcript active entries={entries} queued={[]} handle={handle} onWithdraw={() => {}} conversationPlan={value.state} researchOffers={controls} /></section>;
}
function wire(): Wire {
	return {
		connected: true,
		on: () => () => {}, send() {},
		ask: (_kind: string, payload: ConversationPlan.ResearchEdit) => new Promise(resolve => {
			requests.push(payload.operation.kind);
			let execute = () => { edit(payload.operation); resolve({ offer: structuredClone(offer), revision: state.revision }); };
			if (held && payload.operation.kind === "patch") pending.push(execute); else execute();
		}),
	} as unknown as Wire;
}
let wires: Record<string, Wire> = { ana: wire(), bo: wire() };
window.researchOffersProbe = {
	hold() { held = true; },
	release() { held = false; for (let execute of pending.splice(0)) execute(); },
	move() { offer.workflow!.placementMessageId = "later"; offer.workflow!.revision++; publish(); },
	remote(text: string) {
		let model = Draft.restore(offer.workflow!.draft!).fork();
		edit({ kind: "patch", patch: Draft.change(model, text)! });
	},
	capabilities(canAct: boolean, canExecute: boolean) { snapshot = { ...snapshot, canAct, canExecute }; publish(); },
	snapshot() { return { brief: offer.brief, started: [...started], requests: [...requests], pending: pending.length }; },
};
createRoot(document.getElementById("fixture")!).render(<><View handle="ana" /><View handle="bo" /></>);
`;
