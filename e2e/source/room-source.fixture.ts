import type { PlanQuestionnaireState } from "../../packages/editor/src/questionnaires";
import type { ConversationPlan } from "../../packages/protocol/index";

type Destination = { itemId: string; token: number; source: ConversationPlan.SourceRef };

declare global {
	interface Window {
		roomSourceProbe: {
			sockets: Array<{ receive: (frame: unknown) => void }>;
			expiries: Array<() => void>;
			expiryHandles: number[];
			clearedExpiryHandles: number[];
			observe: (value: unknown) => void;
			snapshot: () => { room?: string; destination?: Destination };
			mount: () => void;
			changeRoom: (room: string) => void;
			setChild: (child: boolean) => void;
			unmount: () => void;
			showSource: (messageId: string) => void;
			evidence: (id: string) => { type: string; rows: unknown[] } | null;
			renderEvidence: (id: string) => void;
			receive: (frame: unknown) => void;
			setQuestions: (state: PlanQuestionnaireState) => void;
			resetConversation: () => void;
		};
	}
}

export let observeRoomSource =
	"\twindow.roomSourceProbe.observe({ room, sourceDestination, showSource, showEvidence, questions, cardMeta, conversationStore });\n";
export let navigationProviderBinding =
	"\nexport let RoomSourceNavigationProvider = NavigationDocument.Provider;\n";

export let roomSourceBinding = `import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { RoomSourceNavigationProvider } from "./navigation-shell";

class InertSocket extends EventTarget {
 static CONNECTING = 0; static OPEN = 1; static CLOSED = 3;
 readyState = 0;
 constructor(url) { super(); window.roomSourceProbe.sockets.push(this); this.url = url; }
 send() { throw new Error("The inert test socket cannot send network requests"); }
 close() { this.readyState = 3; }
 receive(frame) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(frame) })); }
}
window.WebSocket = InertSocket;
let nativeTimeout = window.setTimeout.bind(window);
window.setTimeout = (callback, delay, ...args) => {
 if (delay === 3000 && typeof callback === "function") window.roomSourceProbe.expiries.push(callback);
 let handle = nativeTimeout(callback, delay, ...args);
 if (delay === 3000 && typeof callback === "function") window.roomSourceProbe.expiryHandles.push(handle);
 return handle;
};
let nativeClearTimeout = window.clearTimeout.bind(window);
window.clearTimeout = handle => {
 if (window.roomSourceProbe.expiryHandles.includes(handle)) window.roomSourceProbe.clearedExpiryHandles.push(handle);
 return nativeClearTimeout(handle);
};
let probeRoot;
let evidenceRoot;
let snapshot;
let roomName = "room-a";
let context = {
 onDocumentChanged() {}, onDocumentAction() {}, onDocumentDeleted() {},
 async onDocumentLoaded() {}, onDocumentRouteSettled() {},
 onRepositoryAccessChanged() {}, onResearchChildOpen() {}, onResearchChildPublished() {},
};
let props = {
 agent: false, canEdit: false, canManage: false, handle: "ana", userId: "fixture-user",
 label: "Source timer fixture", slug: "source-timer-fixture", updatedAt: "2026-09-30T00:00:00Z",
 descriptionRevision: 0,
 repository: { id: "fixture-repository", owner: "fixture", name: "fixture", fullName: "fixture/fixture", private: true, url: "https://github.invalid/fixture/fixture", defaultBranch: "main", permissions: { pull: true, push: false, admin: false } },
 presentation: { type: "document" },
};
function renderRoom() {
 probeRoot.render(createElement(RoomSourceNavigationProvider, { value: context },
  createElement(RoomWorkspace, { ...props, room: roomName })));
}
window.roomSourceProbe = {
 sockets: [],
 expiries: [],
 expiryHandles: [],
 clearedExpiryHandles: [],
 observe(value) { snapshot = value; },
 snapshot() { return { room: snapshot?.room, destination: snapshot?.sourceDestination }; },
 mount() {
  probeRoot?.unmount();
  this.sockets = [];
  this.expiries = [];
  this.expiryHandles = [];
  this.clearedExpiryHandles = [];
  roomName = "room-a";
  probeRoot = createRoot(document.querySelector("#fixture"));
  evidenceRoot = createRoot(document.querySelector("#evidence-probe"));
  localStorage.setItem("chopin:view:document", "plan");
  renderRoom();
 },
 changeRoom(room) { roomName = room; renderRoom(); },
 setChild(child) {
  props.presentation = child
   ? { type: "child", label: "Research", onClose() {} }
   : { type: "document" };
  renderRoom();
 },
 unmount() { probeRoot.unmount(); evidenceRoot.unmount(); },
 showSource(messageId) {
  snapshot.showSource({ itemId: "thread-1", source: {
   messageId, author: { kind: "member", handle: "ana" }, role: "reason",
   quote: "pilot", start: 0, end: 5,
  }});
 },
 evidence(id) {
  let element = snapshot.showEvidence(id);
  return element ? { type: element.type.name, rows: element.props.rows } : null;
 },
 renderEvidence(id) { evidenceRoot.render(snapshot.showEvidence(id)); },
 receive(frame) { this.sockets.at(-1).receive(frame); },
 setQuestions(state) { snapshot.questions.set(state); },
 resetConversation() { snapshot.conversationStore.reset(); },
};
`;
