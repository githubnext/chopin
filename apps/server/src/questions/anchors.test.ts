/**
 * Where a questionnaire's decisions live, and what the agent owes on them.
 *
 * One placement per question. It used to be two — what the question was about
 * and what its answer produced — and the pair had no test at any layer, which
 * is part of how it survived long enough for the agent to anchor both halves to
 * the same block in every record it ever wrote.
 *
 * No document here: minting an anchor needs a Yjs room and is covered in
 * `plan/anchors.test.ts`. What is testable without one is the bookkeeping —
 * which questions owe a review, when they stop owing it, and whether a record
 * written before the fold can still be read.
 */

import { describe, expect, it } from "bun:test";

import * as Anchors from "./anchors";

import type { Plan } from "@chopin/protocol";
import type { Record as Question } from "./service";

function anchor(digest: string): Plan.Anchor {
	return { epoch: "e1", position: "cG9z", digest: `sha256:${digest}` };
}

function record(over: Partial<Question> = {}): Question {
	return {
		id: "w1",
		status: "open",
		definition: {
			questions: [
				{ id: "q1", header: "Cache", question: "Where do we cache?", multiple: false, options: [] },
				{ id: "q2", header: "Store", question: "Which store?", multiple: false, options: [] },
			],
		},
		...over,
	};
}

describe("what a question owes the agent", () => {
	/**
	 * There is no decision to place until somebody has made one, and a question
	 * that owed a review from the moment it was asked would owe it forever —
	 * nothing derives a placement at ask time, so nothing could ever clear it.
	 */
	it("owes nothing while nobody has answered", () => {
		expect(Anchors.pending(record())).toEqual([]);
	});

	it("owes one review per question once it is answered", () => {
		expect(Anchors.pending(record({ status: "answered" }))).toEqual([
			{ widget: "w1", question: "q1", reason: "missing" },
			{ widget: "w1", question: "q2", reason: "missing" },
		]);
	});

	it("stops owing it once the agent has said where the decision lives", () => {
		let answered = record({ status: "answered" });
		let value = Anchors.set(Anchors.read(answered), "q1", [anchor("aa")]);

		expect(Anchors.pending({ ...answered, anchors: value })).toEqual([
			{ widget: "w1", question: "q2", reason: "missing" },
		]);
	});

	/** Looking and finding nothing is a review, and has to be able to end one. */
	it("takes an empty list as a real answer rather than as never having looked", () => {
		let answered = record({ status: "answered" });
		let value = Anchors.set(Anchors.read(answered), "q1", []);

		expect(value.questions.q1).toEqual({ anchors: [], pending: false });
		expect(Anchors.pending({ ...answered, anchors: value })).toHaveLength(1);
	});

	it("ignores a question the questionnaire does not ask", () => {
		let value = Anchors.read(record());
		expect(Anchors.set(value, "nope", [anchor("aa")])).toEqual(value);
	});

	it("owes the review again when the plan moves beneath it", () => {
		let answered = record({ status: "answered" });
		let anchored = {
			...answered,
			anchors: Anchors.set(Anchors.read(answered), "q1", [anchor("aa")]),
		};

		let value = Anchors.invalidate(anchored, "plan_changed");

		expect(value.questions.q1?.pending).toBe(true);
		// The anchors are kept: they are still the best guess at where it was,
		// and the review is about whether they are still right.
		expect(value.questions.q1?.anchors).toHaveLength(1);
		expect(Anchors.pending({ ...anchored, anchors: value })).toContainEqual({
			widget: "w1",
			question: "q1",
			reason: "plan_changed",
		});
	});

	it("does not raise a review on a question nobody has answered", () => {
		let open = record();
		let value = Anchors.invalidate(open, "plan_changed");

		expect(Anchors.pending({ ...open, anchors: value })).toEqual([]);
	});
});

/**
 * A room written before the two halves were folded into one.
 *
 * `read` hands back what was persisted verbatim, and nothing between
 * `JSON.parse` and it checks the shape — so without this the first client to
 * open an existing room reads `undefined.map` and the plan does not load.
 */
describe("reading a record written before the fold", () => {
	function split(subject: Plan.AnchorSet, result: Plan.AnchorSet): Question {
		return record({
			status: "answered",
			// The shape a released build wrote, which no longer typechecks.
			anchors: {
				widget: "w1",
				questions: { q1: { subject, result } },
			} as unknown as Plan.WidgetAnchors,
		});
	}

	it("reads the two halves as the one placement", () => {
		let value = Anchors.read(split(
			{ anchors: [anchor("aa")], pending: false },
			{ anchors: [anchor("aa"), anchor("bb")], pending: false },
		));

		// The subject was a subset of the result in every record the agent
		// wrote, so the union is the result and nothing is duplicated.
		expect(value.questions.q1?.anchors.map(item => item.digest)).toEqual([
			"sha256:aa",
			"sha256:bb",
		]);
		expect(value.questions.q1?.pending).toBe(false);
	});

	/** Where it was not a subset, dropping it would lose the only placement there was. */
	it("keeps a subject the agent anchored and never followed with a result", () => {
		let value = Anchors.read(split(
			{ anchors: [anchor("aa")], pending: false },
			{ anchors: [], pending: true, reason: "missing" },
		));

		expect(value.questions.q1?.anchors).toHaveLength(1);
		// Still owed, because the half that was maintained was never reviewed.
		expect(value.questions.q1?.pending).toBe(true);
		expect(value.questions.q1?.reason).toBe("missing");
	});

	it("owes one review per question, not two", () => {
		let old = split(
			{ anchors: [], pending: true, reason: "missing" },
			{ anchors: [], pending: true, reason: "plan_changed" },
		);

		expect(Anchors.pending(old)).toEqual([
			{ widget: "w1", question: "q1", reason: "plan_changed" },
		]);
	});

	it("leaves a record already written in the new shape alone", () => {
		let already: Plan.WidgetAnchors = {
			widget: "w1",
			questions: { q1: { anchors: [anchor("aa")], pending: false } },
		};

		expect(Anchors.read(record({ status: "answered", anchors: already }))).toEqual(already);
	});
});
