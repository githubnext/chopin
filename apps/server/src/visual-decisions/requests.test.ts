import { afterEach, expect, test } from "bun:test";
import { ulid } from "@chopin/dialect";
import * as Service from "../plan/service";
import { CommitRejected } from "../storage/errors";
import { openPlan } from "../testing/plan";
import * as Requests from "./requests";

let plans: Service.Plan[] = [];
afterEach(async () => {
	for (let plan of plans.splice(0)) await Service.close(plan);
});

function message(id: string, text: string, handle = "ana") {
	return { id, ts: 1, author: { kind: "member", handle }, text };
}

function source(entryId: string, text: string) {
	return { entryId, userId: "U_test", handle: "ana", text };
}

test("one member message records one pending request across retries and restart", async () => {
	let firstId = ulid();
	let secondId = ulid();
	let firstText = "Explore spacing, density and type scale in the billing card.";
	let secondText = "Explore colour temperature in the billing card.";
	let context = await openPlan("# Billing", {
		transcript: [message(firstId, firstText), message(secondId, secondText)],
	});
	plans.push(context.plan);
	let first = await Requests.create(context.plan, source(firstId, firstText));
	expect(first).toMatchObject({
		channelId: context.plan.id,
		originMessageId: firstId,
		instruction: firstText,
		requestedBy: "U_test",
		requestedByHandle: "ana",
		sourceDocumentRevision: context.plan.revision,
		state: "pending",
	});
	expect(first.id).toHaveLength(26);
	expect(new Date(first.createdAt).toISOString()).toBe(first.createdAt);
	expect(context.plan.revision).toBe(0);
	expect(await Requests.create(context.plan, source(firstId, firstText))).toEqual(first);
	let second = await Requests.create(context.plan, source(secondId, secondText));
	expect(second.id).not.toBe(first.id);
	context.plan.claiming = true;
	expect(await Requests.create(context.plan, source(firstId, firstText))).toEqual(first);
	context.plan.claiming = false;
	expect(context.plan.visualRequests.size).toBe(2);
	let saved = await context.storage.collaboration.load(context.plan.id, context.now);
	expect(saved).toBeDefined();
	expect((saved!.sidecar as { visualRequests: unknown[] }).visualRequests).toHaveLength(2);
	await Service.close(context.plan);
	plans.splice(plans.indexOf(context.plan), 1);
	let restored = await Service.open(context.plan.id, context.backend, context.server);
	plans.push(restored);
	expect(await Requests.create(restored, source(firstId, firstText))).toEqual(first);
	expect(restored.visualRequests.size).toBe(2);
});

test("forged, oversized and implementation-locked requests leave no record", async () => {
	let entryId = ulid();
	let text = "Explore the card spacing.";
	let context = await openPlan("# Billing", { transcript: [message(entryId, text)] });
	plans.push(context.plan);
	await expect(Requests.create(context.plan, source(ulid(), text))).rejects.toThrow();
	await expect(Requests.create(context.plan, source(entryId, "Different words")))
		.rejects.toThrow();
	await expect(Requests.create(context.plan, { ...source(entryId, text), userId: "" }))
		.rejects.toThrow();
	await expect(Requests.create(context.plan, source(entryId, "é".repeat(2_049))))
		.rejects.toThrow();
	context.plan.claiming = true;
	await expect(Requests.create(context.plan, source(entryId, text))).rejects.toThrow();
	context.plan.claiming = false;
	expect(context.plan.visualRequests.size).toBe(0);
});

test("a failed fenced commit never accepts or reports a pending request", async () => {
	let entryId = ulid();
	let text = "Explore the billing card.";
	let context = await openPlan("# Billing", { transcript: [message(entryId, text)] });
	plans.push(context.plan);
	let original = context.storage.collaboration.commit;
	context.storage.collaboration.commit = async () => {
		throw new CommitRejected();
	};
	try {
		await expect(Requests.create(context.plan, source(entryId, text))).rejects.toThrow();
	} finally {
		context.storage.collaboration.commit = original;
	}
	expect(context.plan.visualRequests.size).toBe(0);
	let saved = await context.storage.collaboration.load(context.plan.id, context.now);
	expect(saved?.sidecar).toBeNull();
	expect((await Requests.create(context.plan, source(entryId, text))).state).toBe("pending");
});

test("a queued request refuses a member turn that ended before the document lock", async () => {
	let entryId = ulid();
	let text = "Explore the billing card.";
	let context = await openPlan("# Billing", { transcript: [message(entryId, text)] });
	plans.push(context.plan);
	let release = Promise.withResolvers<void>();
	let started = Promise.withResolvers<void>();
	let held = Service.exclusive(context.plan, async () => {
		started.resolve();
		await release.promise;
	});
	await started.promise;
	let current = true;
	let pending = Requests.create(context.plan, source(entryId, text), () => current);
	current = false;
	release.resolve();
	await held;
	await expect(pending).rejects.toThrow("no longer driving");
	expect(context.plan.visualRequests.size).toBe(0);
});

test("malformed durable request fails restoration rather than disappearing", async () => {
	let entryId = ulid();
	let text = "Explore the billing card.";
	let request = {
		id: ulid(),
		channelId: crypto.randomUUID(),
		originMessageId: entryId,
		instruction: text,
		requestedBy: "U_test",
		requestedByHandle: "ana",
		sourceDocumentRevision: 0,
		createdAt: new Date().toISOString(),
		state: "pending",
	};
	await expect(openPlan("# Billing", {
		transcript: [message(entryId, text)],
		visualRequests: [request],
	})).rejects.toThrow();
});
