import { type Decision, demoRepo, type Source, type Task } from "./plans";
import type { PlanState, PlanStore } from "./store";

export type Where = "end" | { after: string };

export type BeatContext = {
	instant: boolean;
	state: () => PlanState;
	set: PlanStore["set"];
	wait: (ms: number) => Promise<void>;
	say: (author: string, body: string, sources?: Source[]) => void;
	compose: (author: string, text: string) => Promise<void>;
	insert: (login: string, where: Where, text: string) => Promise<void>;
	replace: (login: string, find: string, text: string) => Promise<void>;
	/** Writes a whole block in one edit, as an agent does, rather than typing it. */
	place: (login: string, where: Where, text: string) => Promise<void>;
};

/** `cue` names the in-page action that starts the beat; it defaults to the beat's `id`. */
export type Beat = {
	id: string;
	label: string;
	cue?: string;
	run: (ctx: BeatContext) => Promise<void>;
};

let replayDecision: Decision = {
	id: "replay",
	question: "How should replay handle a conflict?",
	context:
		"The server rejects an operation whose base revision is stale. Later operations in the queue may still apply cleanly.",
	options: [
		{
			id: "stop",
			label: "Stop at the first conflict",
			description: "Simplest to reason about, but one conflict blocks every later edit.",
		},
		{
			id: "skip",
			label: "Skip it and continue",
			description:
				"Apply everything that still applies, then show one summary of the skipped edits.",
		},
		{
			id: "ask",
			label: "Ask immediately",
			description: "Pause replay and prompt for each conflict as it happens.",
		},
	],
	raisedBy: "copilot",
	raisedAt: "just now",
	selected: null,
	answer: null,
	answeredBy: null,
	applied: false,
};

let buildTasks: Task[] = [
	{
		id: "queue",
		title: "Persist pending operations in SQLite",
		detail: "Add the pending_operations table and an append-only queue API.",
		status: "drafted",
		pr: 12,
	},
	{
		id: "replay",
		title: "Replay the queue on reconnect",
		detail: "Send operations in order and skip any with a stale base revision.",
		status: "drafted",
		pr: 13,
	},
	{
		id: "summary",
		title: "Summarize skipped edits",
		detail: "One sheet listing each skipped edit with keep mine and keep theirs.",
		status: "drafted",
		pr: 14,
	},
	{
		id: "rollout",
		title: "Ship behind the offline_sync flag",
		detail: "Feature flag, conflict-rate metric, and a staged rollout.",
		status: "drafted",
		pr: 15,
	},
];

let research = [
	{
		doing: `Searching ${demoRepo} for sync code`,
		done: `Searched ${demoRepo} for sync code`,
		ms: 1800,
	},
	{ doing: "Reading src/sync/client.ts", done: "Read src/sync/client.ts", ms: 1600 },
	{ doing: "Reading src/sync/retry.ts", done: "Read src/sync/retry.ts", ms: 1200 },
	{ doing: "Reading src/store/notes.ts", done: "Read src/store/notes.ts", ms: 1100 },
	{ doing: "Reading src/db/sqlite.ts", done: "Read src/db/sqlite.ts", ms: 900 },
	{
		doing: "Checking the history of src/sync/",
		done: "Checked the history of src/sync/",
		ms: 1200,
	},
];

let researchSources: Source[] = [
	{ path: "src/sync/client.ts", lines: [14, 22] },
	{ path: "src/sync/client.ts", lines: [29, 32] },
	{ path: "src/sync/retry.ts", lines: [1, 14] },
	{ path: "src/store/notes.ts", lines: [8, 9] },
	{ path: "src/db/sqlite.ts", lines: [3, 4] },
];

let currentBehavior = `
## Current behavior

- Failed edits wait in an in-memory \`pending\` array in \`src/sync/client.ts\`, so restarting the app loses them.
- \`retryWithBackoff\` gives up after 3 attempts, about 1.5 seconds, and drops the edit with only a log line.
- A \`409 Conflict\` is resent with \`force: true\`, which silently overwrites the newer server change.
- SQLite is already bundled for search in \`src/db/sqlite.ts\`, so a durable queue needs no new dependency.
`;

let rollout = `
## Rollout

1. Ship the queue behind the \`offline_sync\` flag to internal builds.
2. Watch the replay conflict rate for one week; the target is under 0.5% of sessions.
3. Enable for 10% of public users, then everyone once crash-free sessions hold steady.
`;

function updateTask(ctx: BeatContext, id: string, patch: Partial<Task>) {
	ctx.set(state => ({
		tasks: state.tasks.map(task => (task.id === id ? { ...task, ...patch } : task)),
	}));
}

function updateDecision(ctx: BeatContext, id: string, patch: Partial<Decision>) {
	ctx.set(state => ({
		decisions: state.decisions.map(
			decision => (decision.id === id ? { ...decision, ...patch } : decision),
		),
	}));
}

export let script: Beat[] = [
	{
		id: "research-ask",
		label: "monalisa asks Copilot to research the sync code",
		cue: "comment",
		async run(ctx) {
			ctx.set({ tab: "plan" });
			await ctx.wait(400);
			await ctx.compose(
				"monalisa",
				"@copilot how do offline edits work in `src/sync/` today? Add a summary of the current behavior to the plan.",
			);
		},
	},
	{
		id: "research",
		label: "Copilot researches the codebase and summarizes it",
		async run(ctx) {
			ctx.set(state => ({
				viewers: [...state.viewers.filter(login => login !== "copilot"), "copilot"],
			}));
			let finished = (count: number) => research.slice(0, count).map(step => step.done);
			for (let [index, step] of research.entries()) {
				ctx.set({ activity: { login: "copilot", text: step.doing, steps: finished(index) } });
				await ctx.wait(step.ms);
			}
			ctx.set({
				activity: { login: "copilot", text: "Writing a summary", steps: finished(research.length) },
			});
			await ctx.wait(900);
			ctx.set({ activity: null });
			await ctx.insert(
				"copilot",
				{ after: "Edit freely; it keeps the prose consistent with every decision.\n" },
				currentBehavior,
			);
			await ctx.wait(400);
			ctx.say(
				"copilot",
				"Added **Current behavior** to the plan. In short: failed edits only live in memory, retries give up after about 1.5 seconds, and a `409` is resent with `force: true`. That explains both symptoms in #142.",
				researchSources,
			);
		},
	},
	{
		id: "ask",
		label: "monalisa asks Copilot for a rollout plan",
		cue: "comment",
		async run(ctx) {
			ctx.set({ tab: "plan" });
			await ctx.wait(400);
			await ctx.compose(
				"monalisa",
				"@copilot add a rollout plan with a feature flag, and call out anything we still need to decide.",
			);
		},
	},
	{
		id: "draft",
		label: "Copilot drafts the rollout and raises a decision",
		async run(ctx) {
			ctx.set(state => ({
				activity: { login: "copilot", text: "Copilot is reading the plan" },
				viewers: [...state.viewers.filter(login => login !== "copilot"), "copilot"],
			}));
			await ctx.wait(1400);
			ctx.say("copilot", "On it. Adding a **Rollout** section now.");
			await ctx.wait(600);
			await ctx.insert("copilot", "end", rollout);
			await ctx.wait(500);
			ctx.set(state => ({ decisions: [...state.decisions, replayDecision] }));
			ctx.say(
				"copilot",
				"Added **Rollout**. One call is needed before we build: how should replay handle a conflict? It's in **Decisions**.",
			);
		},
	},
	{
		id: "theo",
		label: "theo-nguyen edits alongside Copilot",
		async run(ctx) {
			ctx.set(state => ({
				viewers: [...state.viewers.filter(login => login !== "theo-nguyen"), "theo-nguyen"],
			}));
			await ctx.wait(900);
			await ctx.insert(
				"theo-nguyen",
				{ after: 'beyond a single "keep mine / keep theirs" prompt.' },
				"\n- Syncing in the background while the app is closed.",
			);
			await ctx.wait(400);
			ctx.say(
				"theo-nguyen",
				"Added background sync as a non-goal. iOS limits make that its own project.",
			);
		},
	},
	{
		id: "decide",
		label: "monalisa makes the decision",
		async run(ctx) {
			ctx.set({ tab: "decisions" });
			await ctx.wait(1200);
			updateDecision(ctx, "replay", { selected: "skip" });
			await ctx.wait(1000);
			updateDecision(ctx, "replay", { answer: "skip", answeredBy: "monalisa" });
			await ctx.wait(1000);
		},
	},
	{
		id: "apply",
		label: "Copilot rewrites Design to match",
		async run(ctx) {
			ctx.set({ activity: { login: "copilot", text: "Copilot is updating the plan" } });
			await ctx.wait(900);
			ctx.set({ tab: "plan" });
			await ctx.wait(700);
			await ctx.replace(
				"copilot",
				"and the client asks the person to choose.",
				"so replay skips that operation, applies the rest of the queue, and then shows one summary of the skipped edits.",
			);
			updateDecision(ctx, "replay", { applied: true });
			ctx.say(
				"copilot",
				"Updated **Design** to match @monalisa's decision: replay skips conflicts and summarizes them at the end. Nothing is left to decide, so this plan is ready to build.",
			);
		},
	},
	{
		id: "build",
		label: "monalisa builds the plan",
		async run(ctx) {
			ctx.set({ tab: "build" });
			await ctx.wait(1200);
			ctx.set({
				status: "Building",
				activity: { login: "copilot", text: "Copilot is splitting the plan into tasks" },
			});
			await ctx.wait(900);
			for (let task of buildTasks) {
				ctx.set(state => ({ tasks: [...state.tasks, task] }));
				await ctx.wait(450);
			}
			ctx.set({ activity: null });
			ctx.say("copilot", "Split the plan into 4 tasks. Starting a coding agent for each.");
		},
	},
	{
		id: "prs",
		label: "Copilot opens pull requests",
		async run(ctx) {
			for (let task of buildTasks) {
				updateTask(ctx, task.id, { status: "working" });
				await ctx.wait(250);
			}
			for (let task of buildTasks) {
				await ctx.wait(1300);
				updateTask(ctx, task.id, { status: "open" });
			}
			ctx.say(
				"copilot",
				"Opened 4 pull requests: #12, #13, #14, and #15. Each one links back to this plan.",
			);
			await ctx.wait(1500);
			updateTask(ctx, "queue", { status: "merged" });
			ctx.say("dana-okafor", "Reviewed and merged #12. Nice work, everyone.");
		},
	},
];
