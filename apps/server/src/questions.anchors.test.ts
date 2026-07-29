/**
 * A questionnaire's decisions, through a real room.
 *
 * `anchors.ts` covers the bookkeeping on its own. What needs a document is
 * everything either side of it: minting an anchor from a block the agent named,
 * carrying it forward when the plan moves, and — the reason this file exists —
 * opening a room whose `state.json` was written before a question's two anchor
 * sets were folded into one.
 *
 * That last one cannot be caught anywhere else. Records are restored with a
 * cast (`plan/service.ts`), so nothing between `JSON.parse` and the first read
 * checks the shape — and the carry on open is guarded, so getting it wrong does
 * not fail the open. It is caught, logged once, and every decision in the plan
 * silently loses its place, comment threads included, since they share the
 * guard. Which is why the room opening is not what these assert.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as Questions from "./questions/service";
import * as room from "./plan/room";
import * as Service from "./plan/service";

import type { Server } from "bun";
import type { Plan } from "./plan/service";
import type { SocketData } from "./wire";

const SOURCE = `# Title

The renderer caches tiles for 60 seconds.

The second paragraph.
`;

let rooms: string[] = [];
let opens: Plan[] = [];

afterEach(async () => {
	for (let plan of opens) await Service.close(plan);
	opens = [];
	for (let dir of rooms) await rm(dir, { recursive: true, force: true });
	rooms = [];
});

async function opened(state?: object) {
	let dir = await mkdtemp(join(tmpdir(), "chopin-questions-"));
	rooms.push(dir);
	await writeFile(join(dir, "plan.mdx"), SOURCE);
	if (state) await writeFile(join(dir, "state.json"), JSON.stringify(state));

	let server = { publish() {} } as unknown as Server<SocketData>;
	let plan = await Service.open("test", dir, server);
	opens.push(plan);
	return plan;
}

/** An answered questionnaire, as `state.json` holds one. */
function stored(anchors?: object) {
	return {
		revision: 1,
		questions: [{
			id: "w1",
			status: "answered",
			resolver: "ana",
			definition: {
				questions: [{
					id: "q1",
					header: "Cache",
					question: "How long do we cache?",
					multiple: false,
					options: [],
				}],
			},
			answers: { q1: "60 seconds" },
			...(anchors ? { anchors } : {}),
		}],
	};
}

describe("saying where a decision lives", () => {
	it("owes a review until the agent has said, and stops when it has", async () => {
		let plan = await opened(stored());

		expect(Questions.outstanding(plan)).toEqual([
			{ widget: "w1", question: "q1", reason: "missing" },
		]);

		let digest = room.digests(plan.document)[1]!;
		expect(Questions.relate(plan, "w1", "q1", [{ index: 1, digest }])).toBeUndefined();

		expect(Questions.outstanding(plan)).toEqual([]);
		expect(Questions.anchors(plan)[0]?.questions.q1?.anchors).toHaveLength(1);
	});

	/** An empty list is a real answer: reviewed, deliberately related to nothing. */
	it("accepts that a decision produced nothing worth pointing at", async () => {
		let plan = await opened(stored());

		expect(Questions.relate(plan, "w1", "q1", [])).toBeUndefined();
		expect(Questions.outstanding(plan)).toEqual([]);
	});

	it("refuses to anchor against a block that has changed", async () => {
		let plan = await opened(stored());

		expect(Questions.relate(plan, "w1", "q1", [{ index: 1, digest: "sha256:stale" }]))
			.toContain("has changed");
	});

	it("refuses a questionnaire the room does not have", async () => {
		let plan = await opened(stored());

		expect(Questions.relate(plan, "nope", "q1", [])).toContain("no questionnaire");
	});

	it("owes the review again once the plan has moved beneath it", async () => {
		let plan = await opened(stored());
		let digest = room.digests(plan.document)[1]!;
		Questions.relate(plan, "w1", "q1", [{ index: 1, digest }]);

		Questions.invalidate(plan, "plan_changed");

		expect(Questions.outstanding(plan)).toEqual([
			{ widget: "w1", question: "q1", reason: "plan_changed" },
		]);
	});
});

describe("opening a room written before the fold", () => {
	/** The shape a released build persisted, which no longer typechecks. */
	function split() {
		return stored({
			widget: "w1",
			questions: {
				q1: {
					subject: { anchors: [], pending: true, reason: "missing" },
					result: { anchors: [], pending: false },
				},
			},
		});
	}

	/**
	 * The open is guarded, so a record the fold missed would still produce a
	 * room — one that had dropped every anchor it held and said so only to the
	 * console. The complaint is the signal; the room is not.
	 */
	it("carries the anchors in rather than giving up on them", async () => {
		let complaints: unknown[] = [];
		let complain = console.error;
		console.error = (...args: unknown[]) => complaints.push(args);
		try {
			await opened(split());
		} finally {
			console.error = complain;
		}

		expect(complaints).toEqual([]);
	});

	it("reads as one placement per question", async () => {
		let plan = await opened(split());
		let value = Questions.anchors(plan)[0];

		expect(Object.keys(value?.questions ?? {})).toEqual(["q1"]);
		expect(value?.questions.q1?.anchors).toEqual([]);
	});

	/**
	 * The subject was raised the moment a question existed and cleared by
	 * nothing, so every old room carries one the agent can never discharge.
	 */
	it("stops owing the review that could never be cleared", async () => {
		let plan = await opened(split());

		expect(Questions.outstanding(plan)).toEqual([]);
	});

	it("can still be anchored afterwards", async () => {
		let plan = await opened(split());
		let digest = room.digests(plan.document)[1]!;

		expect(Questions.relate(plan, "w1", "q1", [{ index: 1, digest }])).toBeUndefined();
		expect(Questions.anchors(plan)[0]?.questions.q1?.anchors).toHaveLength(1);
	});
});
