import { expect, spyOn, test } from "bun:test";
import { ulid } from "@chopin/dialect/ulid";

import * as Comments from "../comments/service";
import * as room from "../plan/room";
import * as Service from "../plan/service";
import { cardWithProse } from "../questions/prose.test-fixtures";
import * as Questions from "../questions/service";
import { pickBuild, queueBuild } from "../tasks/builds";
import { announceImplementation } from "../tasks/notifications";
import { claimImplementation, implementationGraphs } from "../tasks/plan-graphs";
import { openPlan } from "../testing/plan";
import { Connections } from "./connections";
import { Experiments } from "./service";
import { spikeHost } from "./spike-host";
import { calloutDigest, callouts, placeSpikeCallout } from "./spike-placement";
import { SpikeScout } from "./spike-scout";
import { spikeCallout } from "./spikes";

const PASSAGE = "We are unsure whether drag handles work on touch screens at all.";

async function hosted(source = `# Plan\n\n${PASSAGE}\n\nAnother paragraph.\n`) {
	let context = await openPlan(source);
	let service = new Experiments(context.storage.experiments, () => context.lease);
	let landed: string[] = [];
	let host = spikeHost({
		service,
		connections: new Connections(),
		withPlan: (_id, action) => action(context.plan),
		landed: (_channelId, value) => landed.push(value.id),
	});
	return { ...context, service, host, landed };
}

test("a spike is durably placing before its callout is published", async () => {
	let errors = spyOn(console, "error").mockImplementation(() => {});
	let context = await hosted();
	let states: Array<{ placing?: boolean; placed: boolean } | undefined> = [];
	let commit = context.storage.collaboration.commit.bind(context.storage.collaboration);
	let spy = spyOn(context.storage.collaboration, "commit").mockImplementation(async input => {
		let [value] = await context.service.store.list(context.plan.id);
		states.push(value?.spike && { placing: value.spike.placing, placed: value.spike.placed });
		return commit(input);
	});
	try {
		let digest = room.digests(context.plan.document)[1];
		await context.host.start(context.plan.id, {
			owner: "U_test",
			connection: { id: "gone", login: "maggie" },
			block: { digest, text: PASSAGE },
		});
		expect(states[0]).toEqual({ placing: true, placed: false });
		let [value] = await context.service.store.list(context.plan.id);
		expect(value.spike).toMatchObject({ placed: true, rendered: "queued" });
		expect(value.spike?.placing).toBeUndefined();
	} finally {
		spy.mockRestore();
		errors.mockRestore();
		await Service.close(context.plan);
	}
});

test("recovery finds a published callout in place and never inserts another", async () => {
	let errors = spyOn(console, "error").mockImplementation(() => {});
	let context = await hosted();
	try {
		let id = crypto.randomUUID();
		let callout = ulid();
		let digest = room.digests(context.plan.document)[1];
		let value = await context.service.create(context.plan.id, "U_test", "brief", id, undefined, {
			digest,
			passage: PASSAGE,
			callout,
			login: "maggie",
			placed: false,
			placing: true,
		});
		let node = spikeCallout(value);
		await context.service.mutate(id, item => {
			item.spike!.calloutDigest = calloutDigest(node);
		});
		// The callout was published, then the process died before `placed` persisted.
		await placeSpikeCallout(context.plan, { callout, node, after: digest });
		await context.host.refresh(context.plan.id);
		let recovered = await context.service.store.get(id);
		expect(recovered?.spike).toMatchObject({ placed: true, callout });
		expect(recovered?.spike?.placing).toBeUndefined();
		expect(recovered?.spike?.dismissed).toBeUndefined();
		let source = room.project(context.plan.document);
		expect(source.split("<Callout").length - 1).toBe(1);

		// A placing spike whose callout never landed is dismissed rather than inserted.
		let lost = crypto.randomUUID();
		await context.service.create(context.plan.id, "U_test", "brief", lost, undefined, {
			digest,
			passage: PASSAGE,
			callout: ulid(),
			login: "maggie",
			placed: false,
			placing: true,
		});
		await context.host.refresh(context.plan.id);
		expect((await context.service.store.get(lost))?.spike?.dismissed).toBe(true);
		expect(room.project(context.plan.document).split("<Callout").length - 1).toBe(1);
	} finally {
		errors.mockRestore();
		await Service.close(context.plan);
	}
});

test("placing a callout rebases copied decision and comment anchors first", async () => {
	let errors = spyOn(console, "error").mockImplementation(() => {});
	let context = await cardWithProse(`# Title\n\n${PASSAGE}\n\nDecision prose.\n`, 2);
	let seen: Array<{ records: boolean; threads: boolean; placed: boolean }> = [];
	let callout = ulid();
	let records = context.plan.records;
	let threads = context.plan.threads;
	let questions = spyOn(Questions, "rebase");
	let comments = spyOn(Comments, "rebase").mockImplementation(plan => {
		seen.push({
			records: plan.records !== records,
			threads: plan.threads !== threads,
			placed: callouts(room.project(plan.document)).has(callout),
		});
	});
	try {
		let before = Questions.prose(context.plan)[0].anchors[0];
		let digest = room.digests(context.plan.document)[1];
		let placed = await placeSpikeCallout(context.plan, {
			callout,
			node: spikeCallout(
				{
					state: "running",
					progress: "",
					spike: { callout, login: "maggie" },
				} as Parameters<typeof spikeCallout>[0],
			),
			after: digest,
		});
		expect(placed.status).toBe("placed");
		expect(questions).toHaveBeenCalledTimes(2);
		expect(seen).toEqual([
			{ records: true, threads: true, placed: false },
			{ records: true, threads: true, placed: true },
		]);
		expect(context.plan.records).not.toBe(records);
		let after = Questions.prose(context.plan)[0];
		expect(after.orphaned).toBe(false);
		expect(after.anchors[0].digest).toBe(before.digest);
	} finally {
		questions.mockRestore();
		comments.mockRestore();
		errors.mockRestore();
		await Service.close(context.plan);
	}
});

test("a spike result deferred by a first build's lock lands once the lock releases", async () => {
	let errors = spyOn(console, "error").mockImplementation(() => {});
	let context = await hosted();
	let scout = new SpikeScout({ host: context.host });
	let { plan } = context;
	// The wiring main.ts gives a released lock.
	plan.persistence.liveBuild = true;
	let released: Promise<void> | undefined;
	plan.persistence.onEditingUnlocked = id => {
		released = scout.refresh(id);
	};
	try {
		await context.host.start(plan.id, {
			owner: "U_test",
			connection: { id: "gone", login: "maggie" },
			block: { digest: room.digests(plan.document)[1], text: PASSAGE },
		});
		let [value] = await context.service.store.list(plan.id);
		expect(value.state).toBe("failed");
		expect(value.spike?.rendered).toBe("queued");

		plan.builds = [{ id: crypto.randomUUID(), state: "running" } as never];
		announceImplementation(plan);
		await scout.refresh(plan.id);
		// Queued renders as a note and stopped as a warning; titles are copy and may change.
		expect(room.project(plan.document)).toContain('type="note"');
		expect((await context.service.store.get(value.id))?.spike?.rendered).toBe("queued");

		plan.builds = [{ ...plan.builds[0], state: "stopped" } as never];
		announceImplementation(plan);
		expect(released).toBeDefined();
		await released;
		expect(room.project(plan.document)).toContain('type="warning"');
		expect(room.project(plan.document)).not.toContain('type="note"');
		expect((await context.service.store.get(value.id))?.spike?.rendered).toBe("stopped");
	} finally {
		scout.close();
		errors.mockRestore();
		await Service.close(plan);
	}
});

test("a spike that finishes while a first build is queued lands before the build claims", async () => {
	let errors = spyOn(console, "error").mockImplementation(() => {});
	let context = await hosted();
	let scout = new SpikeScout({ host: context.host });
	let { plan } = context;
	try {
		await context.host.start(plan.id, {
			owner: "U_test",
			connection: { id: "gone", login: "maggie" },
			block: { digest: room.digests(plan.document)[1], text: PASSAGE },
		});
		let [value] = await context.service.store.list(plan.id);
		await implementationGraphs().revise(plan, {
			planRevision: plan.revision,
			graphRevision: 0,
			operations: [{
				op: "add",
				task: {
					id: "first",
					title: "First task",
					context: "Card grid",
					goal: "Build the grid",
					acceptance: ["Renders", "Matches the spike"],
					dependsOn: [],
				},
			}],
		});
		let checkout = { repository: "owner/repository", branch: "main", commit: "a".repeat(40) };
		let queued = await queueBuild(plan, {
			planRevision: plan.revision,
			graphVersion: 1,
			graphRevision: 1,
			user: "U_test",
			connectionId: "laptop",
			repositoryId: "R_test",
			checkout,
		});
		expect(Service.implementationActive(plan)).toBe(true);

		// The connection finishes the spike that was ahead of the build.
		await context.service.mutate(value.id, item => {
			item.state = "completed";
			item.result = {
				schemaVersion: 1,
				report: "Two columns read better at 1280px.\n",
				datasets: [],
				views: [],
				evidence: [],
				provenance: { environment: "test", checks: [], limitations: [] },
			};
		});
		// What the build claim waits for.
		await scout.settle(plan.id);
		expect(room.project(plan.document)).toContain('type="tip"');
		expect(room.project(plan.document)).toContain("Two columns read better");
		expect((await context.service.store.get(value.id))?.spike?.rendered).toBe("completed");
		expect(plan.builds.at(-1)?.planRevision).toBe(plan.revision);
		expect(plan.graph?.versions.at(-1)?.planRevision).toBe(plan.revision);

		let picked = await pickBuild(plan, "U_test", "laptop");
		expect(picked?.planRevision).toBe(plan.revision);
		let claim = await claimImplementation(plan, {
			planRevision: picked!.planRevision,
			graphRevision: picked!.graphRevision,
			run: {
				id: queued.id,
				user: "U_test",
				client: { name: "chopin-acp", version: "0.1.0" },
				session: "session",
				graphVersion: picked!.graphVersion,
				graphRevision: picked!.graphRevision,
				planRevision: picked!.planRevision,
				repository: checkout.repository,
				branch: `chopin/implement-${queued.id.slice(0, 8)}`,
				commit: checkout.commit,
				startedAt: new Date().toISOString(),
			},
		});
		expect(claim.kind).toBe("started");

		// Once the build runs, results wait for the lock to release again.
		await context.service.mutate(value.id, item => {
			item.result!.report = "Changed after the build started.\n";
		});
		await context.service.mutate(value.id, item => {
			item.state = "failed";
		});
		await scout.settle(plan.id);
		expect(room.project(plan.document)).not.toContain('type="warning"');
	} finally {
		scout.close();
		errors.mockRestore();
		await Service.close(plan);
	}
});

test("a landed result asks once for its passage to be settled", async () => {
	let errors = spyOn(console, "error").mockImplementation(() => {});
	let context = await hosted();
	let { plan } = context;
	try {
		await context.host.start(plan.id, {
			owner: "U_test",
			connection: { id: "gone", login: "maggie" },
			block: { digest: room.digests(plan.document)[1], text: PASSAGE },
		});
		let [value] = await context.service.store.list(plan.id);
		await context.service.mutate(value.id, item => {
			item.state = "completed";
			item.result = {
				schemaVersion: 1,
				report: "**Handles work**\n\n**Recommendation:** Keep them.\n\n- Fine on iOS.\n",
				datasets: [],
				views: [],
				evidence: [],
				provenance: { environment: "test", checks: [], limitations: [] },
			};
		});
		await context.host.refresh(plan.id);
		await context.host.refresh(plan.id);
		expect(context.landed).toEqual([value.id]);
		expect((await context.service.store.get(value.id))?.spike?.settle).toBe(true);
		let source = room.project(plan.document);
		expect(source).toContain(`title="Handles work" fold="1"`);
		room.validate(source);
	} finally {
		errors.mockRestore();
		await Service.close(plan);
	}
});
