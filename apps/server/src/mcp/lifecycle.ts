import type { LifecycleInput, VerificationEvidence } from "../tasks/lifecycle";

export type LifecycleArguments = LifecycleInput & { id: string };

type Schema = Record<string, unknown>;
type Definition = {
	description: string;
	properties: Record<string, Schema>;
	required: string[];
	parse(value: Record<string, unknown>, required: string[]): LifecycleArguments | undefined;
};

const ID = { type: "string", minLength: 1, maxLength: 128 };
const TASK = { type: "string", minLength: 1, maxLength: 128 };
const KEY = { type: "string", minLength: 1, maxLength: 128 };
const TEXT = { type: "string", minLength: 1, maxLength: 5000 };

function bounded(value: unknown, maximum: number): string | undefined {
	return typeof value === "string" && value.trim() && Array.from(value).length <= maximum
		? value
		: undefined;
}

function boundedStrings(value: unknown, maximum: number, minimum = 0): string[] | undefined {
	if (!Array.isArray(value) || value.length < minimum) return undefined;
	let restored: string[] = [];
	for (let item of value) {
		let text = bounded(item, maximum);
		if (!text) return undefined;
		restored.push(text);
	}
	return restored;
}

function base(value: Record<string, unknown>, required: string[]) {
	if (
		Object.keys(value).length !== required.length
		|| required.some(key => !Object.hasOwn(value, key))
	) return undefined;
	let id = bounded(value.id, 128);
	let runId = bounded(value.runId, 128);
	let idempotencyKey = bounded(value.idempotencyKey, 128);
	return id && runId && idempotencyKey ? { id, runId, idempotencyKey } : undefined;
}

function task(value: Record<string, unknown>, required: string[]) {
	let common = base(value, required);
	let taskId = bounded(value.taskId, 128);
	return common && taskId ? { ...common, taskId } : undefined;
}

function verificationEvidence(value: unknown): VerificationEvidence[] | undefined {
	if (!Array.isArray(value) || value.length === 0) return undefined;
	let evidence: VerificationEvidence[] = [];
	for (let entry of value) {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) return undefined;
		let item = entry as Record<string, unknown>;
		if (
			Object.keys(item).length !== 2
			|| !Object.hasOwn(item, "taskId")
			|| !Object.hasOwn(item, "evidence")
		) return undefined;
		let taskId = bounded(item.taskId, 128);
		let entries = boundedStrings(item.evidence, 5000, 1);
		if (!taskId || !entries) return undefined;
		evidence.push({ taskId, evidence: entries });
	}
	return evidence;
}

const definitions = {
	start_task: {
		description: "Mark one dependency-ready task as in progress for the active implementation run.",
		properties: { id: ID, runId: ID, taskId: TASK, idempotencyKey: KEY },
		required: ["id", "runId", "taskId", "idempotencyKey"],
		parse(value, required) {
			let input = task(value, required);
			return input ? { ...input, kind: "start" } : undefined;
		},
	},
	block_task: {
		description:
			"Record a task-level blocker while keeping the active implementation run and graph lock.",
		properties: { id: ID, runId: ID, taskId: TASK, reason: TEXT, idempotencyKey: KEY },
		required: ["id", "runId", "taskId", "reason", "idempotencyKey"],
		parse(value, required) {
			let input = task(value, required);
			let reason = bounded(value.reason, 5000);
			return input && reason ? { ...input, kind: "block", reason } : undefined;
		},
	},
	report_pr: {
		description: "Report the open, merged, or closed pull request for an implementation task.",
		properties: {
			id: ID,
			runId: ID,
			taskId: TASK,
			url: { type: "string", minLength: 1, maxLength: 2048 },
			state: { enum: ["open", "merged", "closed"] },
			idempotencyKey: KEY,
		},
		required: ["id", "runId", "taskId", "url", "state", "idempotencyKey"],
		parse(value, required) {
			let input = task(value, required);
			let url = bounded(value.url, 2048);
			let state = value.state;
			return input && url && (state === "open" || state === "merged" || state === "closed")
				? { ...input, kind: "report_pr", url, state }
				: undefined;
		},
	},
	complete_task: {
		description: "Complete an implementation task after reporting its pull request and summary.",
		properties: { id: ID, runId: ID, taskId: TASK, summary: TEXT, idempotencyKey: KEY },
		required: ["id", "runId", "taskId", "summary", "idempotencyKey"],
		parse(value, required) {
			let input = task(value, required);
			let summary = bounded(value.summary, 5000);
			return input && summary ? { ...input, kind: "complete", summary } : undefined;
		},
	},
	report_verification: {
		description:
			"After every task is complete, report graph-wide verification evidence; failures return named tasks to work.",
		properties: {
			id: ID,
			runId: ID,
			passed: { type: "boolean" },
			summary: TEXT,
			reviewerMethod: TEXT,
			evidence: {
				type: "array",
				minItems: 1,
				items: {
					type: "object",
					properties: {
						taskId: TASK,
						evidence: { type: "array", minItems: 1, items: TEXT },
					},
					required: ["taskId", "evidence"],
					additionalProperties: false,
				},
			},
			tasksNeedingWork: { type: "array", items: TASK },
			idempotencyKey: KEY,
		},
		required: [
			"id",
			"runId",
			"passed",
			"summary",
			"reviewerMethod",
			"evidence",
			"tasksNeedingWork",
			"idempotencyKey",
		],
		parse(value, required) {
			let common = base(value, required);
			let summary = bounded(value.summary, 5000);
			let reviewerMethod = bounded(value.reviewerMethod, 5000);
			let evidence = verificationEvidence(value.evidence);
			let tasksNeedingWork = boundedStrings(value.tasksNeedingWork, 128);
			return common
					&& typeof value.passed === "boolean"
					&& summary
					&& reviewerMethod
					&& evidence
					&& tasksNeedingWork
				? {
					...common,
					kind: "report_verification",
					passed: value.passed,
					summary,
					reviewerMethod,
					evidence,
					tasksNeedingWork,
				}
				: undefined;
		},
	},
	request_revision: {
		description:
			"End the active implementation run and release its graph when scope, acceptance criteria, or dependencies must change.",
		properties: { id: ID, runId: ID, reason: TEXT, idempotencyKey: KEY },
		required: ["id", "runId", "reason", "idempotencyKey"],
		parse(value, required) {
			let input = base(value, required);
			let reason = bounded(value.reason, 5000);
			return input && reason ? { ...input, kind: "request_revision", reason } : undefined;
		},
	},
} satisfies Record<string, Definition>;

export type LifecycleToolName = keyof typeof definitions;

export const LIFECYCLE_TOOLS = Object.entries(definitions).map(([name, definition]) => ({
	name,
	description: definition.description,
	inputSchema: {
		type: "object",
		properties: definition.properties,
		required: definition.required,
		additionalProperties: false,
	},
	outputSchema: { type: "object", properties: {}, additionalProperties: true },
}));

export function lifecycleCall(
	name: string,
	value: Record<string, unknown>,
): { known: false } | { known: true; input?: LifecycleArguments } {
	let definition = definitions[name as LifecycleToolName];
	return definition
		? { known: true, input: definition.parse(value, definition.required) }
		: { known: false };
}

export function isLifecycleTool(name: string): boolean {
	return Object.hasOwn(definitions, name);
}
