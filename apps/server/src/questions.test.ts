/**
 * Deciding something together.
 *
 * The properties worth holding onto: two people edit one answer rather than
 * two, the server refuses a draft the definition does not describe, only one
 * submission wins, and the decision reaches both the record that owns it and
 * the plan that shows it — or neither.
 */

import { afterEach, describe, expect, it } from "bun:test";
import * as Question from "@chopin/question";

import * as room from "./plan/room";
import { identify } from "./questions/service";
import * as Store from "./questions/store";

import type { Definition } from "@chopin/question";

/**
 * A questionnaire with the identity a real one has.
 *
 * Built through `identify` rather than by hand, because the ids it mints are
 * ULIDs and the dialect will not accept anything else in a document.
 */
function definition(): Definition {
	return identify({
		questions: [{
			header: "Storage",
			question: "Where should room state live?",
			multiple: false,
			options: [
				{ label: "On disk as MDX", description: "Readable and diffable." },
				{ label: "In SQLite", description: "Transactional but opaque." },
			],
		}],
	});
}

/** Ids are minted per definition, so a test reads them back off the value. */
function ids(value: Definition) {
	let question = value.questions[0]!;
	return {
		storage: question.id,
		mdx: question.options[0]!.id,
		sqlite: question.options[1]!.id,
	};
}

let questions = Store.create();

afterEach(() => {
	Store.shutdown(questions);
	questions = Store.create();
});

/**
 * A client's fork of the shared draft, as the browser would hold it.
 *
 * `fromBinary` cannot know the schema it is decoding, so the cast is the same
 * one the real client makes when it opens a questionnaire.
 */
function client(model: number[]) {
	return Question.crdt.Model.fromBinary(new Uint8Array(model)).fork() as unknown as Question.Model;
}

/** Produce the patch a client would send after changing its fork. */
function change(fork: Question.Model, edit: (draft: Question.Model) => void): number[] {
	edit(fork);
	let patch = fork.api.flush();
	if (!patch) throw new Error("no patch produced");
	return [...patch.toBinary()];
}

describe("shared drafts", () => {
	it("restores the complete edited draft and its revision", () => {
		let value = definition();
		let ID = ids(value);
		void Store.ask(questions, ID.storage, value, "widget-1");
		let opened = Store.snapshot(questions, ID.storage);
		if (!opened.open) throw new Error("not open");
		let fork = client(opened.model);
		let patch = change(fork, draft => {
			draft.api.val([ID.storage, "mode"]).set("choices");
			draft.api.val([ID.storage, "choice"]).set(ID.mdx);
		});
		Store.edit(questions, ID.storage, patch);

		let restored = Store.restore(Store.dump(questions));
		let snapshot = Store.snapshot(restored, ID.storage);
		expect(snapshot).toMatchObject({ open: true, revision: 1 });
		if (!snapshot.open) throw new Error("not restored");
		expect(Question.read(client(snapshot.model), value)[ID.storage]?.choice).toBe(ID.mdx);
		expect(Store.outstanding(restored)[0]?.widget).toBe("widget-1");
	});

	it("carries one person's edit to the other", () => {
		let value = definition();
		let ID = ids(value);
		void Store.ask(questions, ID.storage, value);
		let opened = Store.snapshot(questions, ID.storage);
		if (!opened.open) throw new Error("not open");

		let alice = client(opened.model);
		let bob = client(opened.model);

		let patch = change(alice, draft => {
			draft.api.val([ID.storage, "mode"]).set("choices");
			draft.api.val([ID.storage, "choice"]).set(ID.mdx);
		});

		let outcome = Store.edit(questions, ID.storage, patch);
		expect(outcome).toMatchObject({ open: true, accepted: true, applied: true, revision: 1 });

		// Bob applies the same patch, as the relay would deliver it.
		bob.applyPatch(Question.crdt.Patch.fromBinary(new Uint8Array(patch)));
		let drafts = Question.read(bob, value);
		expect(drafts[ID.storage]?.choice).toBe(ID.mdx);
	});

	/**
	 * Free text is a CRDT string rather than a value, so two people typing at
	 * once merge instead of overwriting. A decision is one sentence written by
	 * whoever is present, not the last write to arrive.
	 */
	it("merges concurrent typing in a custom answer", () => {
		let value = definition();
		let ID = ids(value);
		void Store.ask(questions, ID.storage, value);
		let opened = Store.snapshot(questions, ID.storage);
		if (!opened.open) throw new Error("not open");

		let alice = client(opened.model);
		let bob = client(opened.model);

		let fromAlice = change(alice, draft => {
			draft.api.val([ID.storage, "mode"]).set("custom");
			draft.api.str([ID.storage, "custom"]).ins(0, "MDX on disk");
		});
		expect(Store.edit(questions, ID.storage, fromAlice)).toMatchObject({ applied: true });

		bob.applyPatch(Question.crdt.Patch.fromBinary(new Uint8Array(fromAlice)));
		let fromBob = change(bob, draft => {
			draft.api.str([ID.storage, "custom"]).ins(11, ", snapshotted");
		});
		expect(Store.edit(questions, ID.storage, fromBob)).toMatchObject({ applied: true });

		let final = Store.snapshot(questions, ID.storage);
		if (!final.open) throw new Error("closed");
		let drafts = Question.read(client(final.model), value);
		expect(drafts[ID.storage]?.custom).toBe("MDX on disk, snapshotted");
	});

	it("refuses a patch that would not read as the definition describes", () => {
		let value = definition();
		let ID = ids(value);
		void Store.ask(questions, ID.storage, value);
		let opened = Store.snapshot(questions, ID.storage);
		if (!opened.open) throw new Error("not open");

		let rogue = client(opened.model);
		let patch = change(rogue, draft => {
			// An option the definition never offered.
			draft.api.val([ID.storage, "choice"]).set("invented");
		});

		let outcome = Store.edit(questions, ID.storage, patch);
		expect(outcome).toMatchObject({ open: true, accepted: false });
		// And the authoritative model is untouched.
		let after = Store.snapshot(questions, ID.storage);
		if (!after.open) throw new Error("closed");
		expect(after.revision).toBe(0);
	});

	/**
	 * Patches are idempotent, which is what makes a resend safe. A duplicate
	 * carries operations the model already has, so it is acknowledged without
	 * moving the revision — and is not relayed, since peers have nothing to do
	 * with it and a bumped revision would invalidate submissions in flight.
	 */
	it("accepts a redelivered patch without moving the revision", () => {
		let value = definition();
		let ID = ids(value);
		void Store.ask(questions, ID.storage, value);
		let opened = Store.snapshot(questions, ID.storage);
		if (!opened.open) throw new Error("not open");

		let fork = client(opened.model);
		let patch = change(fork, draft => {
			draft.api.val([ID.storage, "choice"]).set(ID.mdx);
		});

		expect(Store.edit(questions, ID.storage, patch))
			.toMatchObject({ accepted: true, applied: true, revision: 1 });
		expect(Store.edit(questions, ID.storage, patch))
			.toMatchObject({ accepted: true, applied: false, revision: 1 });
	});
});

describe("resolution", () => {
	/** Choose the first option, and report the revision that produced. */
	function answer(value: Definition): number {
		let ID = ids(value);
		let opened = Store.snapshot(questions, ID.storage);
		if (!opened.open) throw new Error("not open");
		let fork = client(opened.model);
		let patch = change(fork, draft => {
			draft.api.val([ID.storage, "mode"]).set("choices");
			draft.api.val([ID.storage, "choice"]).set(ID.mdx);
		});
		let outcome = Store.edit(questions, ID.storage, patch);
		return (outcome as { revision: number }).revision;
	}

	it("resolves to the labels that were chosen, and who chose them", async () => {
		let value = definition();
		let waiting = Store.ask(questions, ids(value).storage, value);
		let revision = answer(value);

		let claimed = Store.claimSubmit(questions, ids(value).storage, revision, "octocat");
		expect(claimed.ok).toBe(true);
		if (!claimed.ok) return;

		Store.commit(questions, claimed.claim);
		let ended = await waiting;

		expect(ended).toMatchObject({ status: "answered", resolver: "octocat" });
		if (ended.status !== "answered") return;
		expect(ended.answers[0]?.choices).toEqual(["On disk as MDX"]);
	});

	it("refuses a submission written against a draft that has moved", () => {
		let value = definition();
		void Store.ask(questions, ids(value).storage, value);
		let revision = answer(value);

		expect(Store.claimSubmit(questions, ids(value).storage, revision - 1, "hubot"))
			.toMatchObject({ ok: false, reason: "stale", current: revision });
	});

	it("refuses an incomplete answer rather than guessing at it", () => {
		let value = definition();
		void Store.ask(questions, ids(value).storage, value);
		expect(Store.claimSubmit(questions, ids(value).storage, 0, "octocat"))
			.toMatchObject({ ok: false, reason: "invalid" });
	});

	it("lets only one of two simultaneous submissions through", () => {
		let value = definition();
		void Store.ask(questions, ids(value).storage, value);
		let revision = answer(value);

		let first = Store.claimSubmit(questions, ids(value).storage, revision, "octocat");
		let second = Store.claimSubmit(questions, ids(value).storage, revision, "hubot");

		expect(first.ok).toBe(true);
		expect(second.ok).toBe(false);
	});

	/**
	 * The reason resolution is two-phase. The decision has to reach the plan
	 * document as well as this record, and until it has, nobody may be told it
	 * is final.
	 */
	it("stays open and answerable when the durable half fails", async () => {
		let value = definition();
		void Store.ask(questions, ids(value).storage, value);
		let revision = answer(value);

		let claimed = Store.claimSubmit(questions, ids(value).storage, revision, "octocat");
		if (!claimed.ok) throw new Error("claim refused");

		Store.rollback(questions, claimed.claim);

		// Still open, still at the same revision, and claimable again.
		let again = Store.claimSubmit(questions, ids(value).storage, revision, "hubot");
		expect(again.ok).toBe(true);
	});

	it("tells a late arrival what was decided rather than that it never existed", () => {
		let value = definition();
		void Store.ask(questions, ids(value).storage, value);
		let revision = answer(value);
		let claimed = Store.claimSubmit(questions, ids(value).storage, revision, "octocat");
		if (!claimed.ok) throw new Error("claim refused");
		Store.commit(questions, claimed.claim);

		expect(Store.claimSubmit(questions, ids(value).storage, revision, "hubot")).toMatchObject({
			ok: false,
			reason: "resolved",
			status: "answered",
			resolver: "octocat",
		});
	});

	it("refuses edits while a resolution is in flight", () => {
		let value = definition();
		void Store.ask(questions, ids(value).storage, value);
		let revision = answer(value);
		let claimed = Store.claimSubmit(questions, ids(value).storage, revision, "octocat");
		if (!claimed.ok) throw new Error("claim refused");

		expect(Store.edit(questions, ids(value).storage, [1, 2, 3]))
			.toMatchObject({ accepted: false, message: "Questionnaire is resolving" });
	});
});

describe("the plan document", () => {
	it("carries the questionnaire, and then its answer", async () => {
		let document = await room.create();
		let value = definition();
		let ID = ids(value);

		room.insertQuestionnaire(document, {
			id: ID.storage,
			questions: value.questions.map(question => ({
				id: question.id,
				header: question.header,
				prompt: question.question,
				multiple: question.multiple,
				options: question.options,
			})),
		});

		let source = room.project(document);
		expect(source).toContain("<Questionnaire");
		expect(source).toContain("Where should room state live?");
		expect(source).not.toContain("<Answer>");

		room.projectAnswer(document, ID.storage, { [ID.storage]: "On disk as MDX" });
		expect(room.project(document)).toContain("On disk as MDX");
	});

	/**
	 * On the questionnaire rather than on each answer: it resolves as a unit,
	 * so every answer would repeat the same handle and the same moment. The
	 * plan carrying it is what lets a late joiner see who decided, and what
	 * lets it survive a restart.
	 */
	it("records who settled it, on the questionnaire", async () => {
		let document = await room.create();
		let value = definition();
		let ID = ids(value);

		room.insertQuestionnaire(document, {
			id: ID.storage,
			questions: value.questions.map(question => ({
				id: question.id,
				header: question.header,
				prompt: question.question,
				multiple: question.multiple,
				options: question.options,
			})),
		});

		room.projectAnswer(document, ID.storage, { [ID.storage]: "On disk as MDX" }, {
			by: "ana",
			at: "2026-07-28T10:14:00.000Z",
		});

		let source = room.project(document);
		expect(source).toContain('by="ana"');
		expect(source).toContain('at="2026-07-28T10:14:00.000Z"');
		// Once, on the container — not repeated onto the answer.
		expect(source.split('by="ana"')).toHaveLength(2);
		expect(() => room.validate(source)).not.toThrow();
	});

	it("leaves the plan without provenance when none was given", async () => {
		let document = await room.create();
		let value = definition();
		let ID = ids(value);

		room.insertQuestionnaire(document, {
			id: ID.storage,
			questions: value.questions.map(question => ({
				id: question.id,
				header: question.header,
				prompt: question.question,
				multiple: question.multiple,
				options: question.options,
			})),
		});

		room.projectAnswer(document, ID.storage, { [ID.storage]: "On disk as MDX" });

		expect(room.project(document)).not.toContain("by=");
	});

	it("takes a cancelled questionnaire out of the plan", async () => {
		let document = await room.create();
		let value = definition();
		let ID = ids(value);

		room.insertQuestionnaire(document, {
			id: ID.storage,
			questions: [{
				id: ID.storage,
				header: "Storage",
				prompt: "Where?",
				multiple: false,
				options: [{ id: ID.mdx, label: "Disk" }],
			}],
		});
		expect(room.project(document)).toContain("<Questionnaire");

		room.removeQuestionnaire(document, ID.storage);
		expect(room.project(document)).not.toContain("<Questionnaire");
	});
});
