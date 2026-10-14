import * as Y from "yjs";
import {
	documentBodySource,
	MAX_TITLE_LENGTH,
	normalizeDocumentTitle,
	withDocumentTitle,
} from "@chopin/dialect";
import { parse } from "@chopin/dialect/parse";
import { serialize } from "@chopin/dialect/serialize";

import * as Comments from "../comments/service";
import * as edit from "../plan/edit";
import * as room from "../plan/room";
import * as Service from "../plan/service";
import * as Questions from "../questions/service";

import type { ConversationPlan } from "@chopin/protocol";
import type { Context } from "./job-tool-context";

type Input = { revision: number; title: string; goal?: string };

function input(raw: unknown): Input {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		throw new Error("draft_heading arguments must be an object");
	}
	let value = raw as Record<string, unknown>;
	if (
		!Object.hasOwn(value, "revision") || !Object.hasOwn(value, "title")
		|| Object.keys(value).some(key => !["revision", "title", "goal"].includes(key))
	) {
		throw new Error("draft_heading accepts only revision, title, and optional goal");
	}
	if (!Number.isSafeInteger(value.revision) || (value.revision as number) < 0) {
		throw new Error("revision must be a nonnegative integer");
	}
	if (
		typeof value.title !== "string" || [...value.title].length > MAX_TITLE_LENGTH
		|| /[\r\n\u2028\u2029]/.test(value.title)
	) {
		throw new Error(`title must be at most ${MAX_TITLE_LENGTH} Unicode characters on one line.`);
	}
	let title = normalizeDocumentTitle(value.title);
	let goal: string | undefined;
	if (Object.hasOwn(value, "goal")) {
		goal = typeof value.goal === "string" ? value.goal.trim() : "";
		let valid = !!goal && goal.length <= 400;
		try {
			let blocks = parse(goal).children;
			valid &&= blocks.length === 1 && blocks[0]?.type === "paragraph";
		} catch {
			valid = false;
		}
		if (!valid) throw new Error("goal must be 1–400 characters in one paragraph.");
	}
	return { revision: value.revision as number, title, ...(goal ? { goal } : {}) };
}

/** Maintain the title; seed a goal only while the body has no authored prose. */
export async function draftHeading(
	context: Context,
	job: ConversationPlan.Job,
	turn: Context["plan"]["chat"]["turn"],
	raw: unknown,
): Promise<{ output: { title: string; goal?: string; changed?: false }; revision: number }> {
	return context.exclusive(async () => {
		let { plan } = context;
		let active = () =>
			plan.chat.job === job && plan.chat.turn === turn
			&& job.status === "running" && job.kind === "heading";
		if (!active()) throw new Error("background Planner job changed before its tool completed");
		if (job.target !== "document") throw new Error("heading job target is not the document");
		let { revision, title, goal } = input(raw);
		if (revision !== plan.revision) throw new Error("stale; read_plan again");
		let source = room.project(plan.document);
		let next = withDocumentTitle(source, title);
		let body = parse(documentBodySource(source));
		let empty = body.children.every(node =>
			node.type === "mdxJsxFlowElement"
				&& (node.name === "Questionnaire" || node.name === "Decision")
			|| node.type === "paragraph" && node.children.length === 0
		);
		if (goal && empty) {
			let titled = parse(next);
			next = serialize({
				...titled,
				children: [titled.children[0]!, ...parse(goal).children, ...body.children],
			});
		} else goal = undefined;
		let output = { title, ...(goal ? { goal } : {}) };
		if (next === source) return { output: { ...output, changed: false }, revision: plan.revision };

		// Resolve old anchors before the server edit moves any card in the live tree.
		let candidate: Service.Plan = {
			...plan,
			records: new Map(plan.records),
			threads: new Map(plan.threads),
			outlines: new Map(plan.outlines),
		};
		Questions.rebase(candidate);
		Comments.rebase(candidate);
		let stagedDocument = await room.restore(
			plan.document.epoch,
			Y.encodeStateAsUpdate(plan.document.doc),
			source,
			[],
		);
		stagedDocument.seq = plan.document.seq;
		candidate.document = stagedDocument;
		try {
			if (!active()) throw new Error("background Planner job changed before its tool completed");
			let result = edit.replace(candidate, revision, next);
			if (!result.ok) {
				throw new Error(result.reason === "stale" ? "stale; read_plan again" : result.message);
			}
			if (!result.mutation) throw new Error("heading did not change the document");
			if (!active()) throw new Error("background Planner job changed before its tool completed");
			await Service.publishStaged(plan, context.server, context.room, candidate, result.mutation, {
				agent: true,
			});
			context.changes(result.changes);
			context.anchors();
			return { output, revision: plan.revision };
		} finally {
			stagedDocument.doc.destroy();
		}
	});
}
