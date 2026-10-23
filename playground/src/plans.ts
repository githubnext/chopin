export type PlanStatus = "Draft" | "In review" | "Building" | "Shipped";

/** A file Copilot read while researching, optionally narrowed to the lines it cites. */
export type Source = { path: string; lines?: [number, number] };

export type Message = { id: string; author: string; body: string; at: string; sources?: Source[] };

export type DecisionOption = { id: string; label: string; description: string };

export type Decision = {
	id: string;
	question: string;
	context: string;
	options: DecisionOption[];
	raisedBy: string;
	raisedAt: string;
	selected: string | null;
	answer: string | null;
	answeredBy: string | null;
	applied: boolean;
};

export type TaskStatus = "drafted" | "working" | "open" | "merged";

export type Task = {
	id: string;
	title: string;
	detail: string;
	status: TaskStatus;
	pr: number | null;
};

export type Plan = {
	number: number;
	slug: string;
	title: string;
	status: PlanStatus;
	updated: string;
	updatedBy: string;
	collaborators: string[];
	body: string;
	messages: Message[];
	decisions: Decision[];
	tasks: Task[];
};

export let demoRepo = "monalisa/notes";

export let demoSlug = "offline-sync";

let offlineSyncBody = `## Summary

The mobile app loses edits made while offline. This plan proposes a local operation queue that replays edits when the device reconnects, without changing the server API.

> **Note:** Copilot drafted this plan from the conversation in #142 and the existing \`sync/\` module. Edit freely; it keeps the prose consistent with every decision.

## Goals

- Edits made offline survive an app restart.
- Reconnecting never silently overwrites a newer server change.
- No new server endpoints for the first release.

## Non-goals

- Real-time collaboration between two offline devices.
- Conflict resolution UI beyond a single "keep mine / keep theirs" prompt.

## Design

Each edit becomes an operation with a client-generated ID, the base revision it was made against, and its payload. Operations are appended to an on-device queue backed by SQLite.

\`\`\`ts
type PendingOperation = {
  id: string;
  baseRevision: number;
  kind: "update" | "delete";
  payload: unknown;
};
\`\`\`

On reconnect, the client replays the queue in order. The server rejects an operation whose base revision is stale, and the client asks the person to choose.
`;

let storageDecision: Decision = {
	id: "storage",
	question: "Where should the pending queue live?",
	context: "The queue must survive an app restart and hold a few thousand operations.",
	options: [
		{ id: "sqlite", label: "SQLite", description: "Already bundled; transactional appends." },
		{
			id: "file",
			label: "JSON file",
			description: "Simplest, but rewrites the whole file on every edit.",
		},
	],
	raisedBy: "copilot",
	raisedAt: "2 hours ago",
	selected: "sqlite",
	answer: "sqlite",
	answeredBy: "dana-okafor",
	applied: true,
};

export let plans: Plan[] = [
	{
		number: 4,
		slug: demoSlug,
		title: "Offline sync for the mobile app",
		status: "Draft",
		updated: "12 minutes ago",
		updatedBy: "monalisa",
		collaborators: ["monalisa", "dana-okafor"],
		body: offlineSyncBody,
		messages: [
			{
				id: "m1",
				author: "dana-okafor",
				body:
					"Offline edits are our top support issue this month. Can we get a plan together before Thursday's planning sync?",
				at: "2 hours ago",
			},
			{
				id: "m2",
				author: "copilot",
				body:
					"I drafted **Summary**, **Goals**, and **Design** from #142 and the `sync/` module. Mention @copilot here when you want changes.",
				at: "2 hours ago",
			},
		],
		decisions: [storageDecision],
		tasks: [],
	},
	{
		number: 3,
		slug: "rate-limiter",
		title: "Replace the API rate limiter with token buckets",
		status: "In review",
		updated: "yesterday",
		updatedBy: "dana-okafor",
		collaborators: ["dana-okafor", "monalisa", "theo-nguyen"],
		body: "## Summary\n\nMove rate limiting from fixed windows to per-token buckets.\n",
		messages: [],
		decisions: [
			{
				id: "bucket-state",
				question: "Where should bucket state live?",
				context: "Buckets are checked on every API request across 12 application hosts.",
				options: [
					{
						id: "redis",
						label: "Redis",
						description: "Shared and exact, but adds a network hop to every request.",
					},
					{
						id: "local",
						label: "In process",
						description: "Fast, but each host enforces its own share of the limit.",
					},
				],
				raisedBy: "dana-okafor",
				raisedAt: "yesterday",
				selected: null,
				answer: null,
				answeredBy: null,
				applied: false,
			},
		],
		tasks: [],
	},
	{
		number: 2,
		slug: "onboarding",
		title: "First-run onboarding checklist",
		status: "Building",
		updated: "3 days ago",
		updatedBy: "rosa-alvarez",
		collaborators: ["rosa-alvarez", "theo-nguyen"],
		body: "## Summary\n\nGuide new users through their first repository.\n",
		messages: [],
		decisions: [
			{
				id: "placement",
				question: "Where should the checklist appear?",
				context: "New users land on the dashboard after signing up.",
				options: [
					{
						id: "sidebar",
						label: "Dashboard sidebar",
						description: "Always visible, easy to dismiss.",
					},
					{
						id: "dialog",
						label: "Dialog on first sign-in",
						description: "Hard to miss, easy to lose.",
					},
				],
				raisedBy: "copilot",
				raisedAt: "4 days ago",
				selected: "sidebar",
				answer: "sidebar",
				answeredBy: "rosa-alvarez",
				applied: true,
			},
		],
		tasks: [],
	},
	{
		number: 1,
		slug: "search-latency",
		title: "Cut search latency below 200 ms",
		status: "Shipped",
		updated: "last week",
		updatedBy: "monalisa",
		collaborators: ["monalisa", "dana-okafor"],
		body: "## Summary\n\nCache tokenized queries and precompute facets.\n",
		messages: [],
		decisions: [
			{
				id: "cache",
				question: "Where should tokenized queries be cached?",
				context: "Most searches repeat within a few minutes.",
				options: [
					{ id: "memory", label: "Application memory", description: "Fastest; lost on deploy." },
					{ id: "redis", label: "Redis", description: "Survives deploys; one extra hop." },
				],
				raisedBy: "copilot",
				raisedAt: "2 weeks ago",
				selected: "memory",
				answer: "memory",
				answeredBy: "monalisa",
				applied: true,
			},
		],
		tasks: [],
	},
];

export function findPlan(slug: string | null) {
	return plans.find(plan => plan.slug === slug);
}

/** A plan's address, numbered within the repository like an issue. */
export function planPath(plan: Plan, tab?: "decisions" | "build") {
	return `/${demoRepo}/plans/${plan.number}${tab ? `?tab=${tab}` : ""}`;
}

export function displayName(login: string) {
	return login === "copilot" ? "Copilot" : login;
}

export function sourceUrl({ path, lines }: Source) {
	let anchor = lines ? `#L${lines[0]}${lines[1] > lines[0] ? `-L${lines[1]}` : ""}` : "";
	return `/${demoRepo}/blob/main/${path}${anchor}`;
}

export function avatarUrl(login: string) {
	return `/_dotcom/avatars/${login}?s=80`;
}
