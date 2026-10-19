import { expect, test } from "bun:test";
import * as Service from "../plan/service";
import * as Room from "../plan/room";
import { fixture, restart, running, scopeRoom } from "./decision-followup.test-fixtures";
import { scopeSnapshot } from "./decision-followup";
import { writeScope } from "./decision-followup-write";
import * as Questions from "./service";
import { member } from "./text-response.test-fixtures";

test("Save durably requests a generation-keyed continuation only for marked captures", async () => {
	let context = await fixture();
	await context.save(context.ids[0]!, "Keep the complete written answer.");
	expect(context.plan.conversationPlanPendingEffects).toContainEqual({
		key: `job:decision-followup:${context.ids[0]}:1`,
		kind: "job",
		intent: {
			kind: "decision-followup",
			target: context.ids[0],
			trigger: `decided:${context.ids[0]}:1`,
		},
	});
	let plain = await fixture(1, false);
	await plain.save(plain.ids[0]!, "An ordinary answer.");
	// An unmarked answer still gets a why-only draft, but no continuation.
	expect(
		plain.plan.conversationPlanPendingEffects.filter(effect =>
			effect.kind === "job" && effect.intent.kind === "decision-followup"
		),
	).toEqual([]);
});

test("a source commit survives restart before job completion and replays without a new write", async () => {
	let context = await fixture();
	let id = context.ids[0]!;
	await context.save(id, "Keep offline support.");
	let snapshot = scopeSnapshot(context.plan, id);
	let job = running(context);
	context.plan.conversationPlanJobs = [job];
	let args = {
		id,
		revision: snapshot.revision,
		answersHash: snapshot.answersHash,
		source: "Offline support is required.",
	};
	await writeScope(scopeRoom(context), job, context.plan.chat.turn, args);
	let restored = await restart(context);
	expect(restored.plan.conversationPlanJobs[0]!.status).toBe("pending");
	let next = running(restored);
	let revision = restored.plan.revision;
	let room = scopeRoom(restored);
	room.visualAdmission = async () => {
		throw new Error("a receipt must not reassess");
	};
	expect(await writeScope(room, next, restored.plan.chat.turn, args)).toMatchObject({
		output: { replayed: true },
	});
	expect(restored.plan.revision).toBe(revision);
	expect(Room.project(restored.plan.document)).toContain("Offline support is required.");
});

test("a newer peer answer or an orphaned target refuses without changing prose", async () => {
	let context = await fixture(2);
	let id = context.ids[0]!;
	await context.save(id, "Keep offline support.");
	let stale = scopeSnapshot(context.plan, id);
	await context.save(context.ids[1]!, "Preserve the API.");
	let job = running(context);
	let before = Room.project(context.plan.document);
	await expect(writeScope(scopeRoom(context), job, context.plan.chat.turn, {
		id,
		revision: context.plan.revision,
		answersHash: stale.answersHash,
		source: "An outdated answer.",
	})).rejects.toThrow("saved answers changed");
	context.plan.records.get(id)!.followUp!.target[0]!.orphaned = true;
	expect(() => scopeSnapshot(context.plan, id)).toThrow("orphaned");
	expect(Room.project(context.plan.document)).toBe(before);
});

test("required visual refusal changes nothing and a native visual repair becomes part of the scope", async () => {
	let context = await fixture();
	let id = context.ids[0]!;
	await context.save(id, "Compare the supported approaches.");
	let snapshot = scopeSnapshot(context.plan, id);
	let job = running(context);
	let room = scopeRoom(context);
	room.visualAdmission = async input =>
		input.sources[0]!.includes("| Approach |") ? [] : [{
			code: "E_VISUAL_REQUIRED",
			path: "sources[0]",
			message: "Add a comparison table.",
		}];
	let args = {
		id,
		revision: snapshot.revision,
		answersHash: snapshot.answersHash,
		source: "The alternatives have different constraints.",
	};
	let before = Room.project(context.plan.document);
	await expect(writeScope(room, job, context.plan.chat.turn, args)).rejects.toThrow(
		"visuals-required",
	);
	expect(Room.project(context.plan.document)).toBe(before);
	await writeScope(room, job, context.plan.chat.turn, {
		...args,
		source: `${args.source}\n\n| Approach | Constraint |\n| --- | --- |\n| Existing | Offline |`,
	});
	expect(context.plan.records.get(id)!.followUp!.target).toHaveLength(2);
	expect(scopeSnapshot(context.plan, id).source).toContain("| Approach |");
});

test.each([0, 1])(
	"shared scope writes preserve peer answers when decision %s is saved first",
	async firstIndex => {
		let context = await fixture(2);
		let first = context.ids[firstIndex]!;
		let second = context.ids[1 - firstIndex]!;
		let answer = `${"Context ".repeat(100)}Final constraint: offline operation.`;
		await context.save(first, answer);
		let snapshot = scopeSnapshot(context.plan, first);
		expect(JSON.stringify(snapshot.decisions)).toContain(answer);
		let { writeScope } = await import("./decision-followup-write");
		let room = {
			id: context.plan.id,
			plan: context.plan,
			server: context.server,
			exclusive: <T>(action: () => Promise<T>) => Service.exclusive(context.plan, action),
			anchors() {},
			changes() {},
			visualAdmission: async () => [],
		} as unknown as import("../agent/tools").DocumentRoom;
		let job = {
			id: "followup",
			kind: "decision-followup",
			target: first,
			trigger: `decided:${first}:1`,
			status: "running",
			attempts: 0,
			at: context.now.toISOString(),
		} as const;
		context.plan.chat.job = job;
		await writeScope(room, job, context.plan.chat.turn, {
			id: first,
			revision: snapshot.revision,
			answersHash: snapshot.answersHash,
			source: "Use offline operation.",
		});
		expect(Room.project(context.plan.document)).toContain("Use offline operation.");
		expect(Room.project(context.plan.document)).toContain("Keep this unrelated paragraph.");
		expect(context.plan.records.get(first)!.followUp!.appliedGeneration).toBe(1);
		expect(context.plan.records.get(second)!.followUp!.appliedGeneration).toBeUndefined();
		await context.save(second, "Preserve the existing API.");
		let peer = scopeSnapshot(context.plan, second);
		expect(peer.source).toContain("Use offline operation.");
		expect(JSON.stringify(peer.decisions)).toContain("Preserve the existing API.");
		let next = { ...job, target: second, trigger: `decided:${second}:1` };
		context.plan.chat.job = next;
		let args = {
			id: second,
			revision: peer.revision,
			answersHash: peer.answersHash,
			source: "Use offline operation and preserve the existing API.",
		};
		await writeScope(room, next, context.plan.chat.turn, args);
		let revision = context.plan.revision;
		await writeScope(room, next, context.plan.chat.turn, args);
		expect(context.plan.revision).toBe(revision);
		expect(context.plan.records.get(first)!.followUp!.appliedGeneration).toBe(1);
		expect(context.plan.records.get(second)!.followUp!.appliedGeneration).toBe(1);
	},
);

test("a failed source commit publishes neither prose, peer anchors nor applied receipts", async () => {
	let context = await fixture();
	let id = context.ids[0]!;
	await context.save(id, "Keep offline support.");
	let snapshot = scopeSnapshot(context.plan, id);
	let job = running(context);
	let source = Room.project(context.plan.document);
	let target = structuredClone(context.plan.records.get(id)!.followUp!.target);
	let commit = context.storage.collaboration.commit;
	context.storage.collaboration.commit = async () => {
		throw new Error("source commit failed");
	};
	try {
		await expect(writeScope(scopeRoom(context), job, context.plan.chat.turn, {
			id,
			revision: snapshot.revision,
			answersHash: snapshot.answersHash,
			source: "Offline support is required.",
		})).rejects.toThrow("source commit failed");
		expect(Room.project(context.plan.document)).toBe(source);
		expect(context.plan.records.get(id)!.followUp).toEqual({ scope: snapshot.scope, target });
	} finally {
		context.storage.collaboration.commit = commit;
	}
});

test("reopening invalidates an old continuation and the next Save updates its generation", async () => {
	let context = await fixture();
	let id = context.ids[0]!;
	await context.save(id, "Keep offline support.");
	let initial = scopeSnapshot(context.plan, id);
	let job = running(context);
	await writeScope(scopeRoom(context), job, context.plan.chat.turn, {
		id,
		revision: initial.revision,
		answersHash: initial.answersHash,
		source: "Offline support is required.",
	});
	await Questions.reopen(context.plan, context.server, context.plan.id, member().ws, {
		kind: "question:reopen",
		ts: 0,
		rid: "reopen",
		id,
	});
	await context.save(id, "Use online operation instead.");
	let latest = scopeSnapshot(context.plan, id);
	let args = {
		id,
		revision: latest.revision,
		answersHash: latest.answersHash,
		source: "Online operation is required.",
	};
	await expect(writeScope(scopeRoom(context), job, context.plan.chat.turn, args)).rejects.toThrow(
		"generation",
	);
	let next = { ...job, trigger: `decided:${id}:2` };
	context.plan.chat.job = next;
	await writeScope(scopeRoom(context), next, context.plan.chat.turn, args);
	expect(context.plan.records.get(id)!.followUp!.appliedGeneration).toBe(2);
	expect(context.plan.records.get(id)!.history[0]!.answers).toEqual(initial.decisions[0]!.answers);
});
