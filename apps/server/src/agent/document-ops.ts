/**
 * Reading, editing and anchoring one document, whichever room it is.
 *
 * `read_plan`, `edit_plan` and `anchor_plan` act on the room's own document; the
 * child tools act on a child's. Both go through these, so a child edit is the
 * same validated, persisted-before-published batch as a root edit.
 */
import * as Arguments from "./arguments";
import * as Comments from "../comments/service";
import * as Store from "../comments/store";
import * as edit from "../plan/edit";
import * as Questions from "../questions/service";
import { documentIdentity, implementationActive } from "../plan/service";

import type { Plan } from "../plan/service";
import type { DocumentRoom } from "./tools";

/** Every tool answers with a string; a failure is a value, not a throw. */
export async function answer(name: string, produce: () => unknown): Promise<string> {
	try {
		return JSON.stringify(await produce(), null, 2) ?? "null";
	} catch (err) {
		let message = err instanceof Error ? err.message : String(err);
		console.error(`[agent/${name}]`, err);
		return `Error: ${message}`;
	}
}

export const EDIT_OPERATIONS_SCHEMA = {
	type: "array",
	minItems: 1,
	maxItems: 50,
	items: {
		type: "object",
		properties: {
			op: {
				type: "string",
				enum: [
					"insert",
					"insert_root",
					"replace",
					"replace_root",
					"move",
					"delete",
					"detach_question",
				],
			},
			index: {
				type: "integer",
				minimum: 0,
				description: "Block to act on. Required except for insert_root and replace_root.",
			},
			to: { type: "integer", minimum: 0, description: "Destination, for move." },
			source: {
				type: "string",
				maxLength: 100000,
				description: "Plan MDX, for insert, insert_root, replace and replace_root.",
			},
			id: {
				type: "string",
				description: "Questionnaire id, for detach_question.",
			},
		},
		required: ["op"],
		additionalProperties: false,
	},
} as const;

export async function documentView(plan: Plan): Promise<Record<string, unknown>> {
	return documentSnapshot(plan, await documentIdentity(plan));
}

/** Capture the read_plan fields without awaiting storage while the room queue is held. */
export function documentSnapshot(
	plan: Plan,
	document: Awaited<ReturnType<typeof documentIdentity>>,
): Record<string, unknown> {
	let source = edit.source(plan);
	return structuredClone({
		document,
		revision: plan.revision,
		source,
		blocks: edit.outline(plan, source),
		/*
		 * Accepted threads only, which only the earlier lifecycle made.
		 *
		 * An open one is a conversation the room is still having, and a
		 * resolved or dismissed one was closed without asking for a
		 * revision, so neither reaches here.
		 */
		comments: [...plan.threads.values()]
			.filter(thread => thread.status === "accepted")
			.map(thread => ({
				id: thread.id,
				quote: thread.quote,
				accepted_by: thread.resolver,
				// False means this one still needs acting on and
				// anchoring; it is the same list `anchors_pending` gives.
				actioned: !!thread.result && !thread.result.pending,
				comments: thread.notes.map(note => `@${Store.speaker(note)}: ${note.text}`),
			})),
		questions: [...plan.records.values()].map(record => ({
			id: record.id,
			status: record.status,
			questions: record.definition.questions.map(question => question.question),
			options: record.definition.questions.map(question =>
				question.options.map(option => option.label)
			),
			...(record.answers ? { answers: record.answers } : {}),
			...(record.resolver ? { answered_by: record.resolver } : {}),
		})),
	});
}

/**
 * Apply one structural batch to `target`'s document. Run it inside `target.exclusive`.
 *
 * `acting` is the comment thread, in `target`'s document, this edit is attributed to.
 */
export async function applyBlockEdit(
	target: DocumentRoom,
	args: { revision: number; operations: Parameters<typeof edit.apply>[2] },
	options: { acting?: string; applied?: () => void } = {},
) {
	if (implementationActive(target.plan)) return { ok: false as const, reason: "locked" };
	let outcome = edit.apply(target.plan, args.revision, args.operations);
	if (!outcome.ok) return outcome;
	options.applied?.();

	for (let id of outcome.detached) {
		let record = target.plan.records.get(id);
		if (record) target.plan.records.set(id, { ...record, status: "cancelled" });
	}

	// Prose moved, so every relationship has to be brought forward
	// and anything answered has to be looked at again: the passage a
	// decision produced is the most likely thing to have been
	// rewritten.
	Questions.rebase(target.plan);
	Questions.invalidate(target.plan, "plan_changed");
	Comments.rebase(target.plan);
	Comments.invalidate(target.plan, "plan_changed");

	// After invalidating, so it is not immediately undone. If
	// this turn is acting on a comment thread, what it just
	// wrote is what that thread produced — unless the agent
	// says otherwise with `anchor_plan`, which wins. The caller
	// names the thread, because a root turn can act on a child's.
	if (options.acting) Comments.attribute(target.plan, options.acting, outcome.touched);

	if (outcome.mutation) await target.publish(outcome.mutation);

	// After the update that created them, never before it. Both
	// go to the same topic in order, so by the time this arrives
	// the browser already holds the blocks it names.
	target.changes(outcome.changes);

	target.anchors();

	return {
		ok: true as const,
		revision: target.plan.revision,
		blocks: outcome.blocks,
		anchors_pending: [
			...Questions.outstanding(target.plan),
			...Comments.outstanding(target.plan),
		],
	};
}

/**
 * Relate decisions in `target`'s document to its blocks.
 *
 * Not inside `target.exclusive`: `persist` queues behind the same chain and would wait on itself.
 */
export async function applyAnchors(
	target: DocumentRoom,
	args: ReturnType<typeof Arguments.anchorPlan>,
) {
	if (args.revision !== target.plan.revision) {
		return {
			ok: false,
			reason: "stale",
			revision: target.plan.revision,
			message: "The plan changed. Read it again and re-anchor.",
		};
	}

	let failures: string[] = [];
	let placements: Questions.Placement[] = [];
	for (let update of args.anchors) {
		let failure = update.thread
			? Comments.relate(target.plan, update.thread, update.blocks)
			: update.widget && update.question
			? Questions.relate(target.plan, update.widget, update.question, update.blocks)
			: "give either `thread`, or both `widget` and `question`.";
		if (failure) {
			failures.push(failure);
		} else if (update.widget !== undefined && update.question !== undefined) {
			placements.push({
				widget: update.widget,
				blocks: update.blocks,
			});
		}
	}
	let mutation = Questions.place(target.plan, placements);
	if (mutation) await target.publish(mutation);

	await target.persist();
	target.anchors();

	return failures.length > 0
		? { ok: false, reason: "invalid", errors: failures }
		: {
			ok: true,
			anchors_pending: [
				...Questions.outstanding(target.plan),
				...Comments.outstanding(target.plan),
			],
		};
}
