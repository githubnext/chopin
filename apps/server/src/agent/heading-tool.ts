import * as Y from "yjs";
import { parse } from "@chopin/dialect/parse";
import { serialize } from "@chopin/dialect/serialize";

import * as Comments from "../comments/service";
import * as edit from "../plan/edit";
import * as room from "../plan/room";
import * as Service from "../plan/service";
import * as Questions from "../questions/service";

import type { ConversationPlan } from "@chopin/protocol";
import type { Context } from "./job-tool-context";

type Input = { revision: number; title: string; goal: string };

function input(raw: unknown): Input {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		throw new Error("draft_heading arguments must be an object");
	}
	let value = raw as Record<string, unknown>;
	if (
		Object.keys(value).length !== 3
		|| !Object.hasOwn(value, "revision") || !Object.hasOwn(value, "title")
		|| !Object.hasOwn(value, "goal")
	) {
		throw new Error("draft_heading accepts only revision, title, and goal");
	}
	if (!Number.isSafeInteger(value.revision) || (value.revision as number) < 0) {
		throw new Error("revision must be a nonnegative integer");
	}
	let title = typeof value.title === "string" ? value.title.trim() : "";
	if (
		!title || title.length > 80 || /[\r\n\u2028\u2029]/.test(value.title as string)
		|| title.startsWith("#")
	) {
		throw new Error("title must be 1–80 characters on one line.");
	}
	let goal = typeof value.goal === "string" ? value.goal.trim() : "";
	if (
		!goal || goal.length > 400
		|| /(?:\r\n|\r|\n)[ \t]*(?:\r\n|\r|\n)/.test(value.goal as string)
	) {
		throw new Error("goal must be 1–400 characters in one paragraph.");
	}
	let blocks;
	try {
		blocks = parse(`# ${title}\n\n${goal}\n`).children;
	} catch {
		throw new Error("goal must be 1–400 characters in one paragraph.");
	}
	if (
		blocks.length !== 2 || blocks[0]?.type !== "heading" || blocks[0].depth !== 1
		|| blocks[1]?.type !== "paragraph"
	) {
		throw new Error("goal must be 1–400 characters in one paragraph.");
	}
	return { revision: value.revision as number, title, goal };
}

/** Commit a heading and goal together, preserving every existing decision card. */
export async function draftHeading(
	context: Context,
	job: ConversationPlan.Job,
	turn: Context["plan"]["chat"]["turn"],
	raw: unknown,
): Promise<{ output: { title: string; goal: string }; revision: number }> {
	return context.exclusive(async () => {
		let { plan } = context;
		let active = () =>
			plan.chat.job === job && plan.chat.turn === turn
			&& job.status === "running" && job.kind === "heading";
		if (!active()) throw new Error("background Planner job changed before its tool completed");
		if (job.target !== "document") throw new Error("heading job target is not the document");
		let { revision, title, goal } = input(raw);
		if (revision !== plan.revision) throw new Error("stale; read_plan again");
		if (!room.headingAllowed(plan.document)) {
			throw new Error(
				"The document already has prose. A background job only titles an empty document.",
			);
		}

		let source = room.project(plan.document);
		let original = parse(source);
		let placeholder = original.children[0]?.type === "heading"
			&& original.children[0].depth === 1 && original.children[0].children.length === 0;
		let heading = parse(`# ${title}\n\n${goal}\n`);
		let next = serialize({
			type: "root",
			children: [...heading.children, ...original.children.slice(placeholder ? 1 : 0)],
		});

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
			let result = edit.replace(candidate, revision, next);
			if (!result.ok) {
				throw new Error(result.reason === "stale" ? "stale; read_plan again" : result.message);
			}
			if (!result.mutation) throw new Error("heading did not change the document");
			if (!active()) throw new Error("background Planner job changed before its tool completed");
			await Service.publishStaged(plan, context.server, context.room, candidate, result.mutation);
			context.changes(result.changes);
			context.anchors();
			return { output: { title, goal }, revision: plan.revision };
		} finally {
			stagedDocument.doc.destroy();
		}
	});
}
