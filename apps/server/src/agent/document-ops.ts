/**
 * Reading, editing and anchoring one document, whichever room it is.
 *
 * `read_plan`, `edit_plan` and `anchor_plan` act on the room's own document; the
 * child tools act on a child's. Both go through these, so a child edit is the
 * same validated, persisted-before-published batch as a root edit.
 */
import * as Arguments from "./arguments";
import * as Y from "yjs";
import * as Comments from "../comments/service";
import * as Store from "../comments/store";
import * as edit from "../plan/edit";
import * as room from "../plan/room";
import * as Questions from "../questions/service";
import * as QuestionStore from "../questions/store";
import { reanchorScopes } from "../questions/decision-followup-reanchor";
import { documentIdentity, implementationActive, publishStaged } from "../plan/service";
import { characters, checkRange, READ_BYTES, ReadRangeError, size } from "../document-reading";

import type { ReadRange } from "../document-reading";
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

/** `documentView`, once `range` is known to name a position in its source. */
export async function readableView(
	plan: Plan,
	range: ReadRange,
): Promise<Record<string, unknown>> {
	let view = await documentView(plan);
	try {
		checkRange(view.source as string, range);
	} catch (err) {
		if (err instanceof ReadRangeError) throw new Arguments.ArgumentError(err.message);
		throw err;
	}
	return view;
}

/** A view inline in another tool's result may take this much of one read's bytes. */
const CURRENT_PLAN_BYTES = READ_BYTES / 2;
const LISTED_QUESTION_BYTES = 3_000;
const LISTED_COMMENT_BYTES = 2_000;

/** The last of `items` that fit `bytes` as JSON, and how many came before them. */
function newest<T>(items: T[], bytes: number): { kept: T[]; omitted: number } {
	let used = 2;
	let kept: T[] = [];
	for (let item of items.toReversed()) {
		used += size(JSON.stringify(item)) + 1;
		if (used > bytes) break;
		kept.unshift(item);
	}
	return { kept, omitted: items.length - kept.length };
}

/**
 * A tool result that already carries the document keeps the view's shape while it is small.
 * Once the view would take more than half of one read's bytes it keeps the revision, identity,
 * and the newest decisions and comments that fit, and points at the read for the source.
 */
export function currentPlan(view: Record<string, unknown>, read: string): Record<string, unknown> {
	if (size(JSON.stringify(view)) <= CURRENT_PLAN_BYTES) return view;
	let { source, blocks, questions, comments, ...rest } = view as {
		source: string;
		blocks: unknown[];
		questions: unknown[];
		comments: unknown[];
	} & Record<string, unknown>;
	let listed = newest(questions, LISTED_QUESTION_BYTES);
	let commented = newest(comments, LISTED_COMMENT_BYTES);
	return {
		...rest,
		comments: commented.kept,
		...commented.omitted ? { comments_omitted: commented.omitted } : {},
		questions: listed.kept,
		...listed.omitted ? { questions_omitted: listed.omitted } : {},
		source_omitted: {
			characters: characters(source),
			blocks: blocks.length,
			read: `${read} reads the source and the blocks you can address, in parts.`,
		},
	};
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
		blocks: edit.outline(plan),
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

/** Snapshot under the queue, assess outside it, then refuse any intervening edit. */
export async function admitBlockEdit(
	target: DocumentRoom,
	args: { revision: number; operations: Parameters<typeof edit.apply>[2] },
	signal?: AbortSignal,
) {
	if (signal?.aborted) return { ok: false as const, reason: "cancelled" };
	if (!target.visualAdmission) return;
	let snapshot = await target.exclusive(async () => {
		if (signal?.aborted) return { ok: false as const, reason: "cancelled" };
		if (implementationActive(target.plan)) return { ok: false as const, reason: "locked" };
		let proposed = edit.prepare(target.plan, args.revision, args.operations);
		if (!proposed.ok) return proposed;
		return { ok: true as const, before: edit.source(target.plan), source: proposed.source };
	});
	if (!snapshot.ok) return snapshot;
	if (signal?.aborted) return { ok: false as const, reason: "cancelled" };
	let issues = await target.visualAdmission({
		before: snapshot.before,
		sources: [snapshot.source],
		signal,
	});
	if (signal?.aborted) return { ok: false as const, reason: "cancelled" };
	return target.exclusive(async () => {
		if (signal?.aborted) return { ok: false as const, reason: "cancelled" };
		if (implementationActive(target.plan)) return { ok: false as const, reason: "locked" };
		if (args.revision !== target.plan.revision) {
			let changed = edit.prepare(target.plan, args.revision, args.operations);
			if (!changed.ok) return changed;
		}
		if (issues.length) return { ok: false as const, reason: "visuals-required", issues };
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
	options: { acting?: string; applied?: () => void; signal?: AbortSignal } = {},
) {
	let result = await applyBlocks(target, args, options);
	// The revision the edit hands back is the one the Planner works from next, so what it holds is
	// remembered as read, for a later write that finds the document has moved on again.
	if (result.ok && result.revision === target.plan.revision) edit.outline(target.plan);
	return result;
}

async function applyBlocks(
	target: DocumentRoom,
	args: { revision: number; operations: Parameters<typeof edit.apply>[2] },
	options: { acting?: string; applied?: () => void; signal?: AbortSignal },
) {
	if (options.signal?.aborted) return { ok: false as const, reason: "cancelled" };
	if (implementationActive(target.plan)) return { ok: false as const, reason: "locked" };
	if (args.operations.some(operation => operation.op === "detach_question")) {
		let document = await room.restore(
			target.plan.document.epoch,
			Y.encodeStateAsUpdate(target.plan.document.doc),
			room.project(target.plan.document),
			[],
		);
		if (target.plan.document.titleKey !== undefined) room.trackTitle(document);
		document.seq = target.plan.document.seq;
		let candidate: Plan = {
			...target.plan,
			document,
			records: new Map(target.plan.records),
			threads: new Map(target.plan.threads),
			outlines: new Map(target.plan.outlines),
			questions: {
				open: new Map(target.plan.questions.open),
				closed: new Map(target.plan.questions.closed),
			},
		};
		try {
			return await editBlocks(
				{
					...target,
					plan: candidate,
					publish: mutation =>
						publishStaged(target.plan, target.server, target.id, candidate, mutation, {
							agent: true,
						}),
				},
				args,
				options,
			);
		} finally {
			document.doc.destroy();
		}
	}
	return editBlocks(target, args, options);
}

async function editBlocks(
	target: DocumentRoom,
	args: { revision: number; operations: Parameters<typeof edit.apply>[2] },
	options: { acting?: string; applied?: () => void; signal?: AbortSignal },
) {
	if (options.signal?.aborted) return { ok: false as const, reason: "cancelled" };
	let outcome = edit.apply(target.plan, args.revision, args.operations);
	if (!outcome.ok) return outcome;
	if (!outcome.detached.length) options.applied?.();

	let completed: Array<() => QuestionStore.Ended> = [];
	for (let id of outcome.detached) {
		let entry = QuestionStore.get(target.plan.questions, id);
		if (entry) {
			// Claims mutate entries; leave the live draft and its waiter untouched until commit.
			target.plan.questions.open.set(id, { ...entry, editors: new Set(entry.editors) });
			let claimed = QuestionStore.claimCancel(target.plan.questions, id, "chopin");
			if (!claimed.ok) {
				return {
					ok: false as const,
					reason: "invalid" as const,
					message: "Questionnaire is resolving",
				};
			}
			completed.push(QuestionStore.stage(target.plan.questions, claimed.claim));
		}
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
	for (let finish of completed) finish();
	if (outcome.detached.length) options.applied?.();

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
 * Stage reviewed links, follow-up targets and card placement in one fenced commit.
 */
export async function applyAnchors(
	target: DocumentRoom,
	args: ReturnType<typeof Arguments.anchorPlan>,
) {
	return target.exclusive(async () => {
		if (implementationActive(target.plan)) return { ok: false, reason: "locked" };
		if (args.revision !== target.plan.revision) {
			return {
				ok: false,
				reason: "stale",
				revision: target.plan.revision,
				message: "The plan changed. Read it again and re-anchor.",
			};
		}
		let source = room.project(target.plan.document);
		let document = await room.restore(
			target.plan.document.epoch,
			Y.encodeStateAsUpdate(target.plan.document.doc),
			source,
			[],
		);
		if (target.plan.document.titleKey !== undefined) room.trackTitle(document);
		document.seq = target.plan.document.seq;
		let candidate: Plan = {
			...target.plan,
			document,
			records: new Map(target.plan.records),
			threads: new Map(target.plan.threads),
			outlines: new Map(target.plan.outlines),
		};
		try {
			let failures: string[] = [];
			let placements: Questions.Placement[] = [];
			for (let update of args.anchors) {
				let failure = update.thread
					? Comments.relate(candidate, update.thread, update.blocks)
					: update.widget && update.question
					? Questions.relate(candidate, update.widget, update.question, update.blocks)
					: "give either `thread`, or both `widget` and `question`.";
				if (failure) {
					failures.push(failure);
				} else if (update.widget !== undefined && update.question !== undefined) {
					placements.push({ widget: update.widget, blocks: update.blocks });
				}
			}
			failures.push(...reanchorScopes(candidate, placements));
			if (failures.length) return { ok: false, reason: "invalid", errors: failures };
			let mutation = Questions.place(candidate, placements);
			Questions.rebase(candidate, source);
			Comments.rebase(candidate);
			await publishStaged(target.plan, target.server, target.id, candidate, mutation, {
				agent: true,
			});
			target.anchors();
			return {
				ok: true,
				anchors_pending: [
					...Questions.outstanding(target.plan),
					...Comments.outstanding(target.plan),
				],
			};
		} finally {
			document.doc.destroy();
		}
	});
}
