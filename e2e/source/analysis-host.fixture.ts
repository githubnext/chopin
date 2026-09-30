import type { ExcerptCorrectionAction } from "../../apps/web/src/conversation-plan/analysis-action";

type Command = "correction" | "analysis" | "job";
export type HostMode = "editable" | "readonly";
declare global {
	interface Window {
		analysisHostFixture: {
			mount(mode?: HostMode): void;
			unmount(): void;
			hold(kind: Command, enabled: boolean): void;
			rejectNext(kind: Command): void;
			settle(kind: Command, accepted: boolean): void;
			append(): void;
			version(version: number): void;
			editable(enabled: boolean): void;
			corrections: ExcerptCorrectionAction[];
			analyses: Array<{ messageId: string; actionId: string }>;
			jobs: string[];
			cards: string[];
		};
	}
}

export let analysisHostBinding = `
import { createElement } from "react";
import { createRoot } from "react-dom/client";

let analysisHostText = "Prefix: S3 needs encryption. S3 is available.";
let analysisHostQuote = "S3 needs encryption. S3 is available.";
let analysisHostThread: ConversationPlan.Thread = {
 id: "host-thread", question: "Where should we store data?", questionSources: [],
 questionAuthoring: "quoted", status: "exploring", questionnaireId: "host-card", version: 7,
 contributions: [{ id: "host-option", kind: "option", text: "S3", authoring: "quoted", sources: [], actor: { kind: "classifier" } }],
 stances: [], stanceHistory: [], decisionHistory: [], candidates: [],
};
let analysisHostRecord: ConversationPlan.AnalysisRecord = {
 messageId: "host-review", questionSetVersion: "fixture-v1", modelVersion: "fixture-m1",
 status: "unlinked", passes: [], eventIds: [], outcomes: [{
  start: analysisHostText.indexOf(analysisHostQuote), end: analysisHostText.length,
  status: "review", gate: "target needs review", eventIds: [],
 }],
};
let analysisHostEntries: Chat.Entry[] = Array.from({ length: 16 }, (_, index) => ({
 id: \`host-background-\${index}\`, author: { kind: "member", handle: "ana" },
 text: \`Earlier context \${index}.\`, ts: index + 1,
}));
analysisHostEntries.push(
 { id: "host-review", author: { kind: "member", handle: "ana" }, text: analysisHostText, ts: 17 },
 { id: "host-retry", author: { kind: "member", handle: "ben" }, text: "The analysis needs a retry.", ts: 18 },
 { id: "host-jobs", author: { kind: "member", handle: "cy" }, text: "A Planner job failed to update this card.", ts: 19 },
);
let analysisHostJobs: ConversationPlan.Job[] = ["refine", "heading"].map((kind, index) => ({
 id: \`host-job-\${index}\`, kind: kind as "refine" | "heading", target: "host-card",
 trigger: "host-jobs", status: "failed", attempts: 1,
 reason: "Controlled failure before publication.", output: "No changes published.",
 at: "2026-09-30T10:00:00Z",
}));
let analysisHostHolds = new Set<string>();
let analysisHostRejects = new Set<string>();
let analysisHostPending = new Map<string, { resolve: () => void; reject: (error: Error) => void }>();
async function analysisHostAcknowledge(kind: string): Promise<void> {
 if (analysisHostRejects.delete(kind)) throw new Error("Controlled acknowledgement rejection");
 if (analysisHostHolds.has(kind)) await new Promise<void>((resolve, reject) => {
  if (analysisHostPending.has(kind)) throw new Error("Unexpected concurrent UI command");
  analysisHostPending.set(kind, { resolve, reject });
 });
}
let analysisHostRoot = createRoot(document.querySelector("#fixture")!);
let analysisHostGeneration = 0;
function AnalysisHost({ mode }: { mode: "editable" | "readonly" }) {
 let [entries, setEntries] = useState(analysisHostEntries);
 let [canEdit, setEditable] = useState(mode === "editable");
 let [version, setVersion] = useState(7);
 window.analysisHostFixture.editable = setEditable;
 window.analysisHostFixture.version = setVersion;
 window.analysisHostFixture.append = () => setEntries(current => [...current, {
  id: \`appended-\${current.length}\`, author: { kind: "member", handle: "ana" },
  text: "A new message while the analysis remains pinned.", ts: current.length + 1,
 }]);
 let state: ConversationPlan.State = {
  schemaVersion: 1, revision: 9, events: [], queue: [],
  threads: [{ ...analysisHostThread, version }],
  analysis: [analysisHostRecord, {
   messageId: "host-retry", questionSetVersion: "fixture-v1", modelVersion: "fixture-m1",
   status: "failed", passes: [], eventIds: [], error: "Controlled analysis failure.",
  }],
 };
 let addExcerpt = async (action: ExcerptCorrectionAction) => {
  window.analysisHostFixture.corrections.push(action);
  await analysisHostAcknowledge("correction");
 };
 let retryAnalysis = async (messageId: string, actionId: string) => {
  window.analysisHostFixture.analyses.push({ messageId, actionId });
  await analysisHostAcknowledge("analysis");
 };
 let retryJob = async (jobId: string) => {
  window.analysisHostFixture.jobs.push(jobId);
  await analysisHostAcknowledge("job");
 };
 return <main>
  <section className="analysis-host-chat">
   <Transcript active entries={entries} queued={[]} handle="ana" onWithdraw={() => {}}
    canEdit={canEdit} conversationPlan={state} conversationPlanJobs={analysisHostJobs}
    onCardLink={link => window.analysisHostFixture.cards.push(link.threadId)}
    onAddExcerpt={addExcerpt} onRetryAnalysis={retryAnalysis} onRetryJob={retryJob} />
   <div className="chat-composer"><textarea aria-label="Isolated host composer" /></div>
  </section>
  <button id="host-outside">Outside host</button>
 </main>;
}
window.analysisHostFixture = {
 corrections: [], analyses: [], jobs: [], cards: [],
 mount(mode = "editable") {
  this.corrections = []; this.analyses = []; this.jobs = []; this.cards = [];
  analysisHostHolds.clear(); analysisHostRejects.clear(); analysisHostPending.clear();
  analysisHostRoot.render(<AnalysisHost key={++analysisHostGeneration} mode={mode} />);
 },
 unmount() { analysisHostRoot.unmount(); },
 hold(kind, enabled) { if (enabled) analysisHostHolds.add(kind); else analysisHostHolds.delete(kind); },
 rejectNext(kind) { analysisHostRejects.add(kind); },
 settle(kind, accepted) {
  let pending = analysisHostPending.get(kind);
  if (!pending) throw new Error("No controlled acknowledgement is pending");
  analysisHostPending.delete(kind);
  if (accepted) pending.resolve(); else pending.reject(new Error("Controlled held acknowledgement rejection"));
 },
 append() {}, version() {}, editable() {},
};
`;
