/**
 * What the planner can do.
 *
 * Plan and graph tools are the design: plan prose is edited by block against
 * the revision read, while implementation work is revised beside it against
 * both the plan and graph revisions. Everything else the agent has is a way of
 * looking at the working directory.
 *
 * Tools are built per room, closing over its plan. A session belongs to one
 * room, so there is no id to pass and no way to address another room's document
 * by accident.
 */

import * as Arguments from "./arguments";
import * as Comments from "../comments/service";
import * as edit from "../plan/edit";
import * as Questions from "../questions/service";
import { implementationGraphs, implementationReadiness } from "../tasks/plan-graphs";

import type { Server } from "bun";
import type { Tool } from "@github/copilot-sdk";
import type { Plan } from "../plan/service";
import type { SocketData } from "../wire";

/** Every tool answers with a string; a failure is a value, not a throw. */
async function answer(name: string, produce: () => unknown): Promise<string> {
	try {
		return JSON.stringify(await produce(), null, 2);
	} catch (err) {
		let message = err instanceof Error ? err.message : String(err);
		console.error(`[agent/${name}]`, err);
		return `Error: ${message}`;
	}
}

export type Context = {
	plan: Plan;
	server: Server<SocketData>;
	room: string;
	/** Relays a server-authored change to everyone in the room. */
	publish: (mutation: { update: Uint8Array; source: string }) => Promise<void>;
	/** Persists sidecar-only relationship changes before exposing them. */
	persist: () => Promise<void>;
	/** Runs a complete server mutation in the same queue as client batches. */
	exclusive: <T>(action: () => Promise<T>) => Promise<T>;
	/** Relays the current relationship snapshot to everyone in the room. */
	anchors: () => void;
	/** Tells the room where this batch wrote, moved and removed. */
	changes: (found: edit.Change[]) => void;
};

export function toolbox(context: Context): Tool[] {
	return [
		{
			name: "read_plan",
			description: "Read the plan: its revision, canonical source, the top-level blocks you can "
				+ "address when editing, and the questions it holds. Read before editing — "
				+ "`edit_plan` refuses a batch aimed at a revision that has moved on.",
			parameters: { type: "object", properties: {}, additionalProperties: false },
			// Reading the document the agent is here to write is not a decision
			// anybody needs to approve.
			skipPermission: true,
			handler: () =>
				answer("read_plan", () => ({
					revision: context.plan.revision,
					source: edit.source(context.plan),
					blocks: edit.outline(context.plan),
					/*
					 * Accepted threads only.
					 *
					 * An open one is a conversation the room is still having, and
					 * acting on feedback nobody has accepted would make the accept
					 * button decorative. A dismissed one was decided against and
					 * never reaches here at all.
					 */
					comments: [...context.plan.threads.values()]
						.filter(thread => thread.status === "accepted")
						.map(thread => ({
							id: thread.id,
							quote: thread.quote,
							accepted_by: thread.resolver,
							// False means this one still needs acting on and
							// anchoring; it is the same list `anchors_pending` gives.
							actioned: !!thread.result && !thread.result.pending,
							comments: thread.notes.map(note => `@${note.handle}: ${note.text}`),
						})),
					questions: [...context.plan.records.values()].map(record => ({
						id: record.id,
						status: record.status,
						questions: record.definition.questions.map(question => question.question),
						...(record.answers ? { answers: record.answers } : {}),
						...(record.resolver ? { answered_by: record.resolver } : {}),
					})),
				})),
		},

		{
			name: "edit_plan",
			description: "Edit the plan as an atomic batch against the revision you last read. Indices "
				+ "address top-level blocks and are resolved against that revision, so they do "
				+ "not shift under each other within one batch. If the plan changed since you "
				+ "read it the whole batch is refused and you are told which blocks moved — read "
				+ "again and retry. Questionnaires are created by `ask`; you cannot clear the "
				+ "plan, and other people may be editing it while you work.",
			parameters: {
				type: "object",
				properties: {
					revision: {
						type: "integer",
						minimum: 0,
						description: "The revision returned by the `read_plan` you are editing from.",
					},
					operations: {
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
					},
				},
				required: ["revision", "operations"],
				additionalProperties: false,
			},
			handler: raw =>
				answer("edit_plan", () =>
					context.exclusive(async () => {
						if (context.plan.execution) return { ok: false, reason: "locked" };
						let args = Arguments.editPlan(raw);
						let outcome = edit.apply(context.plan, args.revision, args.operations);
						if (!outcome.ok) return outcome;

						for (let id of outcome.detached) {
							let record = context.plan.records.get(id);
							if (record) context.plan.records.set(id, { ...record, status: "cancelled" });
						}

						// Prose moved, so every relationship has to be brought forward
						// and anything answered has to be looked at again: the passage a
						// decision produced is the most likely thing to have been
						// rewritten.
						Questions.rebase(context.plan);
						Questions.invalidate(context.plan, "plan_changed");
						Comments.rebase(context.plan);
						Comments.invalidate(context.plan, "plan_changed");

						// After invalidating, so it is not immediately undone. If
						// this turn was started by accepting a comment, what it
						// just wrote is what that decision produced — unless the
						// agent says otherwise with `anchor_plan`, which wins.
						let acting = context.plan.chat.acting;
						if (acting) Comments.attribute(context.plan, acting, outcome.touched);

						if (outcome.mutation) await context.publish(outcome.mutation);

						// After the update that created them, never before it. Both
						// go to the same topic in order, so by the time this arrives
						// the browser already holds the blocks it names.
						context.changes(outcome.changes);

						context.anchors();

						return {
							ok: true,
							revision: context.plan.revision,
							blocks: outcome.blocks,
							anchors_pending: [
								...Questions.outstanding(context.plan),
								...Comments.outstanding(context.plan),
							],
						};
					})),
		},

		{
			name: "ask",
			description: "Ask the people in the room one or more multiple-choice questions and wait for "
				+ "their shared answer. Every question also accepts free text. Batch related "
				+ "questions into one call. The questionnaire is recorded in the plan and the "
				+ "answer is attributed to whoever gave it. Ask only what the repository cannot "
				+ "tell you, and do not ask for permission to proceed. Use the revision from "
				+ "`read_plan` and relate every question to its returned blocks.",
			parameters: {
				type: "object",
				properties: {
					revision: {
						type: "integer",
						minimum: 0,
						description: "The revision returned by the `read_plan` this ask relates to.",
					},
					questions: {
						type: "array",
						minItems: 1,
						maxItems: 10,
						items: {
							type: "object",
							properties: {
								header: { type: "string", minLength: 1, maxLength: 80 },
								question: { type: "string", minLength: 1, maxLength: 1000 },
								options: {
									type: "array",
									minItems: 1,
									maxItems: 20,
									items: {
										type: "object",
										properties: {
											label: { type: "string", minLength: 1, maxLength: 200 },
											description: { type: "string", maxLength: 1000 },
										},
										required: ["label", "description"],
										additionalProperties: false,
									},
								},
								multiple: { type: "boolean" },
								blocks: {
									type: "array",
									items: {
										type: "object",
										properties: {
											index: { type: "integer", minimum: 0 },
											digest: { type: "string", pattern: "^sha256:[0-9a-f]{64}$" },
										},
										required: ["index", "digest"],
										additionalProperties: false,
									},
								},
							},
							required: ["header", "question", "options", "multiple", "blocks"],
							additionalProperties: false,
						},
					},
				},
				required: ["revision", "questions"],
				additionalProperties: false,
			},
			// Asking is not a privilege; waiting for the answer is the cost.
			skipPermission: true,
			handler: raw =>
				answer("ask", async () => {
					if (context.plan.execution) return { ok: false, reason: "locked" };
					let args = Arguments.askPlan(raw);
					let definition = Questions.identify({
						questions: args.questions.map(({ blocks, ...question }) => question),
					});
					let ended = await Questions.ask(
						context.plan,
						context.server,
						context.room,
						definition,
						{ revision: args.revision, blocks: args.questions.map(question => question.blocks) },
						context.anchors,
					);
					return {
						outcomes: ended.map(outcome =>
							outcome.status === "answered"
								? {
									status: "answered",
									answered_by: outcome.resolver,
									answers: outcome.answers,
								}
								: { status: "cancelled", cancelled_by: outcome.resolver }
						),
					};
				}),
		},
		{
			name: "read_implementation_graph",
			description: "Read the current plan revision and implementation graph before drafting or "
				+ "revising tasks. The returned plan_revision and graph_revision are required by "
				+ "edit_implementation_graph; a newer plan or graph refuses the whole edit.",
			parameters: { type: "object", properties: {}, additionalProperties: false },
			skipPermission: true,
			handler: () =>
				answer("read_implementation_graph", () => {
					let version = context.plan.graph?.versions.at(-1);
					return {
						plan_revision: context.plan.revision,
						source: edit.source(context.plan),
						graph_revision: version?.revision ?? 0,
						graph: context.plan.graph,
					};
				}),
		},

		{
			name: "edit_implementation_graph",
			description: "Create or revise the draft implementation graph against the plan and graph "
				+ "revisions from read_implementation_graph. Submit one atomic batch of add, replace, "
				+ "reorder and remove operations. This never changes plan content. Only people may "
				+ "approve, lock or start implementation.",
			parameters: {
				type: "object",
				properties: {
					plan_revision: { type: "integer", minimum: 0 },
					graph_revision: { type: "integer", minimum: 0 },
					operations: {
						type: "array",
						minItems: 1,
						maxItems: 50,
						items: {
							type: "object",
							properties: {
								op: { type: "string", enum: ["add", "replace", "reorder", "remove"] },
								id: { type: "string" },
								task: { type: "object" },
								ids: { type: "array", items: { type: "string" } },
							},
							required: ["op"],
							additionalProperties: false,
						},
					},
				},
				required: ["plan_revision", "graph_revision", "operations"],
				additionalProperties: false,
			},
			handler: raw =>
				answer("edit_implementation_graph", async () => {
					let args = Arguments.graphPlan(raw);
					let ready = implementationReadiness(context.plan, args.planRevision);
					if (!ready.ok) return { ok: false, reason: "not-ready", blockers: ready.blockers };
					let result = await implementationGraphs().revise(context.plan, args);
					return result.ok
						? { ok: true, graph: result.value }
						: { ok: false, reason: result.reason };
				}),
		},

		{
			name: "anchor_plan",
			description: "Say where in the plan each decision lives. Call it immediately after every "
				+ "successful `edit_plan`, using that result's revision and block digests. For a "
				+ "question, give `widget` and `question`; for an accepted comment, give `thread`. "
				+ "Either way the blocks are the prose that decision produced. Link only blocks that "
				+ "would have to change if the decision changed. A question's card moves after its "
				+ "first related block. An empty list means reviewed and "
				+ "deliberately unrelated, which is a real answer and clears the review.",
			parameters: {
				type: "object",
				properties: {
					revision: { type: "integer", minimum: 0 },
					anchors: {
						type: "array",
						minItems: 1,
						maxItems: 100,
						items: {
							type: "object",
							properties: {
								widget: {
									type: "string",
									description: "The questionnaire id. Give with `question`.",
								},
								question: { type: "string", description: "The question id." },
								thread: {
									type: "string",
									description: "An accepted comment thread's id, instead of widget/question.",
								},
								blocks: {
									type: "array",
									items: {
										type: "object",
										properties: {
											index: { type: "integer", minimum: 0 },
											digest: { type: "string", pattern: "^sha256:[0-9a-f]{64}$" },
										},
										required: ["index", "digest"],
										additionalProperties: false,
									},
								},
							},
							// Only `blocks` is always required: the rest depend on which
							// kind of decision is being anchored, the way `edit_plan`'s
							// operations already work. `relate` names what is missing.
							required: ["blocks"],
							additionalProperties: false,
						},
					},
				},
				required: ["revision", "anchors"],
				additionalProperties: false,
			},
			handler: raw =>
				answer("anchor_plan", async () => {
					if (context.plan.execution) return { ok: false, reason: "locked" };
					let args = Arguments.anchorPlan(raw);

					if (args.revision !== context.plan.revision) {
						return {
							ok: false,
							reason: "stale",
							revision: context.plan.revision,
							message: "The plan changed. Read it again and re-anchor.",
						};
					}

					let failures: string[] = [];
					let placements: Questions.Placement[] = [];
					for (let update of args.anchors) {
						let failure = update.thread
							? Comments.relate(context.plan, update.thread, update.blocks)
							: update.widget && update.question
							? Questions.relate(context.plan, update.widget, update.question, update.blocks)
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
					let mutation = Questions.place(context.plan, placements);
					if (mutation) context.publish(mutation);

					await context.persist();
					context.anchors();

					return failures.length > 0
						? { ok: false, reason: "invalid", errors: failures }
						: {
							ok: true,
							anchors_pending: [
								...Questions.outstanding(context.plan),
								...Comments.outstanding(context.plan),
							],
						};
				}),
		},
	];
}
