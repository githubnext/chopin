import { expect, test } from "bun:test";
import * as Y from "yjs";
import * as room from "../plan/room";
import * as Service from "../plan/service";
import { QUIET_MS } from "./admission";
import { initial } from "./state";
import { runtimeFixture } from "./runtime.test-fixtures";
import { reconcile } from "./reconcile";
import { MAX_RECOVERY_ADMISSION_BYTES, MAX_RETIRED } from "./recovery-state";

async function fullFixture(count: number, protectedText = false) {
	let source = "# Notes\n\n"
		+ Array.from({ length: 48 }, (_, i) => `Observation ${i}.\n`).join("\n");
	let f = await runtimeFixture(source);
	let hashes = room.digests(f.plan.document);
	f.plan.documentDevelopment = {
		...initial(),
		passages: Array.from({ length: count }, (_, i) => ({
			id: `p${i}`,
			anchor: room.anchorAt(f.plan.document, i + 1, hashes[i + 1]!),
			generatedDigest: hashes[i + 1]!,
			sourceIds: ["seed"],
			status: protectedText ? "protected" as const : "generated" as const,
		})),
	};
	await Service.persist(f.plan);
	return f;
}

async function fullRecovery(f: Awaited<ReturnType<typeof fullFixture>>, bytes = false) {
	let passage = f.plan.documentDevelopment!.passages[0]!;
	await reconcile(f.plan, {
		jobId: "seed-job",
		messageId: "seed",
		sourceIds: ["seed"],
		passages: [{ id: passage.id, digest: passage.generatedDigest }],
		changes: [{ id: passage.id, markdown: "A clarified observation.", sourceIds: ["seed"] }],
		removals: [],
	}, () => true);
	let recovery = f.plan.documentDevelopment!.recovery!;
	if (bytes) {
		let shadow = new Y.Doc();
		Y.applyUpdate(shadow, Buffer.from(recovery.document, "base64"));
		shadow.getText("capacity-fixture").insert(0, "x".repeat(MAX_RECOVERY_ADMISSION_BYTES));
		recovery.document = Buffer.from(Y.encodeStateAsUpdate(shadow)).toString("base64");
		shadow.destroy();
	} else {
		recovery.retired = Array.from({ length: MAX_RETIRED }, (_, index) => ({
			...recovery.retired[0]!,
			id: `retired-${index}`,
		}));
	}
	await Service.persist(f.plan);
}

for (let bytes of [false, true]) {
	test(`retired recovery ${bytes ? "byte" : "passage"} capacity stops impossible model work`, async () => {
		let f = await fullFixture(48);
		try {
			await fullRecovery(f, bytes);
			await f.say("m1", "Revise the first observation.");
			f.advance(QUIET_MS);
			await f.runtime.run(f.plan.id);
			expect((await f.jobs.list(f.plan.id, 100))?.jobs).toHaveLength(0);
			expect(f.plan.documentDevelopment?.attempts).toHaveLength(0);
			expect(f.plan.documentDevelopment?.lastMessageId).toBe("m1");
			await f.reopen();
			await f.runtime.run(f.plan.id);
			expect((await f.jobs.list(f.plan.id, 100))?.jobs).toHaveLength(0);
		} finally {
			await f.close();
		}
	});
}

test("retired recovery capacity still allows append-only document development", async () => {
	let f = await fullFixture(47);
	try {
		await fullRecovery(f);
		await f.say("m1", "Add the newly reported observation.");
		f.advance(QUIET_MS);
		await f.runtime.run(f.plan.id);
		let input = f.plan.documentDevelopment!.pending!.input;
		expect(input.passages.every(passage => !passage.editable)).toBe(true);
		expect(input.capacity.additions).toBe(1);
		await f.settle({
			changes: [{ id: null, markdown: "A new reported observation.", sourceIds: ["m1"] }],
			removals: [],
		});
		await f.runtime.run(f.plan.id);
		expect(room.project(f.plan.document)).toContain("A new reported observation.");
	} finally {
		await f.close();
	}
});

test("a capacity rejection consumes completed output once with a visible failed outcome", async () => {
	let f = await fullFixture(47);
	try {
		await f.say("m1", "Develop the next observation.");
		f.advance(QUIET_MS);
		await f.runtime.run(f.plan.id);
		await f.settle({
			changes: [{ id: null, markdown: "Proposal: another observation.", sourceIds: ["m1"] }],
			removals: [],
		});
		let hash = room.digests(f.plan.document)[48]!;
		f.plan.documentDevelopment!.passages.push({
			id: "p47",
			anchor: room.anchorAt(f.plan.document, 48, hash),
			generatedDigest: hash,
			sourceIds: ["seed"],
			status: "generated",
		});
		await Service.persist(f.plan);
		await f.runtime.run(f.plan.id);
		expect(f.plan.documentDevelopment?.pending).toBeUndefined();
		expect(f.plan.documentDevelopment?.lastOutcome).toBe("failed");
		await f.reopen();
		await f.runtime.run(f.plan.id);
		expect((await f.jobs.list(f.plan.id, 100))?.jobs).toHaveLength(1);
		expect(room.project(f.plan.document)).not.toContain("Proposal:");
	} finally {
		await f.close();
	}
});

test("capacity exhaustion with no editable passages consumes new discussion without another model attempt", async () => {
	let f = await fullFixture(48, true);
	try {
		await f.say("m1", "Develop another observation.");
		f.advance(QUIET_MS);
		await f.runtime.run(f.plan.id);
		expect((await f.jobs.list(f.plan.id, 100))?.jobs).toHaveLength(0);
		expect(f.plan.documentDevelopment?.attempts).toHaveLength(0);
		expect(f.plan.documentDevelopment).toMatchObject({
			lastMessageId: "m1",
			lastOutcome: "failed",
		});
		await f.reopen();
		await f.runtime.run(f.plan.id);
		expect((await f.jobs.list(f.plan.id, 100))?.jobs).toHaveLength(0);
	} finally {
		await f.close();
	}
});

test("full retained capacity still permits revising owned passages without additions", async () => {
	let f = await fullFixture(48);
	try {
		await f.say("m1", "Correction: the first observation needs a clearer description.");
		f.advance(QUIET_MS);
		await f.runtime.run(f.plan.id);
		await f.settle({
			changes: [{
				id: "p0",
				markdown: "Reported observation: creation is hard to discover.",
				sourceIds: ["m1"],
			}],
			removals: [],
		});
		await f.runtime.run(f.plan.id);
		expect(f.plan.documentDevelopment?.lastOutcome).toBe("updated");
		expect(room.project(f.plan.document)).toContain("creation is hard to discover");
	} finally {
		await f.close();
	}
});
