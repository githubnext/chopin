import { expect, test } from "bun:test";
import * as Edit from "../plan/edit";
import * as Room from "../plan/room";
import * as Service from "../plan/service";
import { fixture, restart, running, scopeRoom } from "./decision-followup.test-fixtures";
import { scopeSnapshot } from "./decision-followup";
import { writeScope } from "./decision-followup-write";
import * as Questions from "./service";

test.each(["append", "move"])(
	"a scoped write survives an unrelated %s during visual assessment",
	async change => {
		let context = await fixture();
		let id = context.ids[0]!;
		await context.save(id, "Keep offline support.");
		let snapshot = scopeSnapshot(context.plan, id);
		let job = running(context);
		let room = scopeRoom(context);
		let entered = Promise.withResolvers<void>();
		let release = Promise.withResolvers<void>();
		room.visualAdmission = async () => {
			entered.resolve();
			await release.promise;
			return [];
		};
		let pending = writeScope(room, job, context.plan.chat.turn, {
			id,
			revision: snapshot.revision,
			answersHash: snapshot.answersHash,
			source: "Offline support is required.",
		});
		await entered.promise;
		await room.exclusive(async () => {
			let before = Room.project(context.plan.document);
			let unrelated = before.split("\n\n").findIndex(block =>
				block.startsWith("Keep this unrelated")
			);
			let outcome = Edit.apply(
				context.plan,
				context.plan.revision,
				change === "append"
					? [{ op: "insert_root", source: "An unrelated edit made during assessment." }]
					: [{ op: "move", index: unrelated, to: 0 }],
			);
			if (!outcome.ok || !outcome.mutation) throw new Error("expected the concurrent edit");
			Questions.rebase(context.plan, before);
			await Service.publish(context.plan, context.server, context.plan.id, outcome.mutation);
		});
		release.resolve();
		await expect(pending).resolves.toMatchObject({ output: { id, replayed: false } });
		let restored = await restart(context);
		let source = Room.project(restored.plan.document);
		expect(source).toContain("Offline support is required.");
		expect(source).toContain("Keep this unrelated paragraph.");
		if (change === "append") expect(source).toContain("An unrelated edit made during assessment.");
		else expect(source.indexOf("Keep this unrelated")).toBeLessThan(source.indexOf("Offline"));
		expect(restored.plan.records.get(id)!.followUp!.appliedGeneration).toBe(1);
		expect(scopeSnapshot(restored.plan, id).source).toBe("Offline support is required.\n");
	},
);

test.each(["passage", "answer", "section"])(
	"a scoped write refuses a changed %s during visual assessment",
	async change => {
		let context = await fixture(2);
		let id = context.ids[0]!;
		await context.save(id, "Keep offline support.");
		let snapshot = scopeSnapshot(context.plan, id);
		let job = running(context);
		let room = scopeRoom(context);
		room.visualAdmission = async () => {
			if (change === "answer") {
				await context.save(context.ids[1]!, "Preserve the API.");
			} else if (change === "section") {
				await room.exclusive(async () => {
					for (
						let operation of [
							{ op: "insert_root", source: "# A different section" },
							{ op: "move", index: 0, to: Room.digests(context.plan.document).length },
						] as Edit.Operation[]
					) {
						let before = Room.project(context.plan.document);
						let outcome = Edit.apply(context.plan, context.plan.revision, [operation]);
						if (!outcome.ok || !outcome.mutation) throw new Error("expected the section move");
						Questions.rebase(context.plan, before);
						await Service.publish(context.plan, context.server, context.plan.id, outcome.mutation);
					}
				});
			} else {
				await room.exclusive(async () => {
					let outcome = Edit.apply(context.plan, context.plan.revision, [{
						op: "replace",
						index: 0,
						source: "A person rewrote the passage while assessment ran.",
					}]);
					if (!outcome.ok || !outcome.mutation) throw new Error("expected the human edit");
					await Service.publish(context.plan, context.server, context.plan.id, outcome.mutation);
				});
			}
			return [];
		};
		await expect(writeScope(room, job, context.plan.chat.turn, {
			id,
			revision: snapshot.revision,
			answersHash: snapshot.answersHash,
			source: "An outdated scoped write.",
		})).rejects.toThrow(/stale|orphaned/);
		expect(Room.project(context.plan.document)).not.toContain("An outdated scoped write.");
		expect(context.plan.records.get(id)!.followUp!.appliedGeneration).toBeUndefined();
	},
);
