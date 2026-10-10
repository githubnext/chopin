import { expect, spyOn, test } from "bun:test";
import { ulid } from "@chopin/dialect/ulid";

import * as Comments from "../comments/service";
import * as room from "../plan/room";
import * as Service from "../plan/service";
import { cardWithProse } from "../questions/prose.test-fixtures";
import * as Questions from "../questions/service";
import { openPlan } from "../testing/plan";
import { Connections } from "./connections";
import { Experiments } from "./service";
import { spikeHost } from "./spike-host";
import { calloutDigest, callouts, placeSpikeCallout } from "./spike-placement";
import { spikeCallout } from "./spikes";

const PASSAGE = "We are unsure whether drag handles work on touch screens at all.";

async function hosted(source = `# Plan\n\n${PASSAGE}\n\nAnother paragraph.\n`) {
	let context = await openPlan(source);
	let service = new Experiments(context.storage.experiments, () => context.lease);
	let host = spikeHost({
		service,
		connections: new Connections(),
		withPlan: (_id, action) => action(context.plan),
	});
	return { ...context, service, host };
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
