/**
 * Marking a passage without a browser.
 *
 * Everything a comment does — anchoring a phrase, carrying it across edits,
 * freezing it into a decision — happens on the server, and none of it is
 * reachable until the sidecar exists. Building the client against a path that
 * has never run once is how the anchoring bugs in this repo were made.
 *
 * Enabled only when `DEV_COMMENTS` is set. It marks a real phrase in whatever
 * the room already holds, using the same request shape a client sends, so the
 * path this exercises is the real one rather than a rehearsal of it.
 */

import { ulid } from "@chopin/dialect";

import * as room from "../plan/room";
import * as Store from "./store";

import type { Plan } from "../plan/service";
import type { Record } from "./service";

export function enabled(): boolean {
	return !!process.env.DEV_COMMENTS;
}

/**
 * Mark the longest phrase the plan offers, and say something about it.
 *
 * The first block with enough prose to be worth marking, rather than a fixed
 * index: a sample that only works against one document proves less than one
 * that has to find its own footing.
 */
export function mark(plan: Plan): void {
	let digests = room.digests(plan.document);

	for (let index of digests.keys()) {
		let text = passageOf(plan, index);
		if (!text) continue;

		try {
			let passage = room.passageAt(
				plan.document,
				[index],
				text.quote,
				text.offset,
				text.quote.length,
			);

			let record: Record = {
				id: ulid(),
				status: "open",
				passage,
				notes: [Store.note("dev", `Is this still right? — "${text.quote}"`)],
			};
			plan.threads.set(record.id, record);
			plan.sink.touch();

			console.log(`[dev] marked block ${index}: ${JSON.stringify(text.quote)}`);
			return;
		} catch (err) {
			console.error("[dev] could not mark that block:", err);
		}
	}

	console.log("[dev] no block long enough to mark");
}

/** A phrase from a block, if it has one worth marking. */
function passageOf(plan: Plan, index: number): { quote: string; offset: number } | undefined {
	let text = room.blockText(plan.document, [index]);
	let trimmed = text.trim();
	if (trimmed.length < 20) return undefined;

	let quote = trimmed.slice(0, Math.min(48, trimmed.length));
	return { quote, offset: text.indexOf(quote) };
}
