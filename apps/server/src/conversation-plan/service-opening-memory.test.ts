import { expect, test } from "bun:test";
import * as Service from "../plan/service";
import * as room from "../plan/room";
import { backfillPlannerAskThreads } from "../questions/backfill";
import { prepareOpenedPlan } from "./service-opening";
import { deferred, storedLegacy } from "./service-opening-memory.test-fixtures";
import type { Room } from "../rooms";

function openingRoom(id: string): Room {
	return { id, members: new Map() };
}

test("real Memory migration commits before shared opening consumers and attachment see the plan", async () => {
	let context = await storedLegacy();
	let opened = await Service.open(context.channel.id, context.backend, context.server);
	let target = openingRoom(context.channel.id);
	let entered = deferred();
	let release = deferred();
	let commit = context.storage.collaboration.commit;
	let attachments: Service.Plan[] = [];
	context.storage.collaboration.commit = async input => {
		entered.resolve();
		await release.promise;
		return commit(input);
	};
	try {
		target.opening = prepareOpenedPlan(target, opened, async () => {
			expect(await backfillPlannerAskThreads(opened)).toBe(1);
		}).then(plan => {
			attachments.push(plan);
			return plan;
		});
		let second = target.opening.then(() => target.plan);
		await entered.promise;
		expect(target.plan).toBeUndefined();
		expect(attachments).toEqual([]);
		expect(opened.records.get(context.id)?.threadId).toBeUndefined();
		expect(room.questionnaireProjections(opened.document)[0]?.thread).toBeUndefined();
		release.resolve();
		let [first, concurrent] = await Promise.all([target.opening, second]);
		expect(first).toBe(opened);
		expect(concurrent).toBe(opened);
		expect(attachments).toEqual([opened]);
		expect(opened.records.get(context.id)?.threadId).toBe(`planner-ask:${context.id}`);
	} finally {
		release.resolve();
		context.storage.collaboration.commit = commit;
		await Service.close(opened);
	}
	let restored = await Service.open(context.channel.id, context.backend, context.server);
	try {
		expect(restored.records.get(context.id)?.threadId).toBe(`planner-ask:${context.id}`);
		expect(room.questionnaireProjections(restored.document)[0]?.thread).toBe(
			`planner-ask:${context.id}`,
		);
		expect(await backfillPlannerAskThreads(restored)).toBe(0);
	} finally {
		await Service.close(restored);
	}
});

test("close intent during an admitted Memory migration prevents late exposure and disposes the unopened plan", async () => {
	let context = await storedLegacy();
	let opened = await Service.open(context.channel.id, context.backend, context.server);
	let target = openingRoom(context.channel.id);
	let entered = deferred();
	let release = deferred();
	let commit = context.storage.collaboration.commit;
	let held = false;
	let destroyed = 0;
	let attached = 0;
	let commits = 0;
	opened.document.doc.on("destroy", () => {
		destroyed++;
	});
	context.storage.collaboration.commit = async input => {
		commits++;
		if (!held) {
			held = true;
			entered.resolve();
			await release.promise;
		}
		return commit(input);
	};
	try {
		target.opening = prepareOpenedPlan(target, opened, async () => {
			await backfillPlannerAskThreads(opened);
		}).then(plan => {
			attached++;
			return plan;
		});
		let first = target.opening.then(() => undefined, error => error);
		let second = target.opening.then(() => target.plan, error => error);
		await entered.promise;
		expect(target.plan).toBeUndefined();
		// Matches the lock ordering: closing intent is immediate; its queued action awaits opening.
		target.closing = target.opening.then(async () => {
			let plan = target.plan;
			target.plan = undefined;
			if (plan) await Service.close(plan);
		}, () => {});
		release.resolve();
		let [error, concurrentError] = await Promise.all([first, second, target.closing]);
		expect(error).toBeInstanceOf(Error);
		expect(error.message).toBe("document is unavailable");
		expect(concurrentError).toBe(error);
		expect(target.plan).toBeUndefined();
		expect(attached).toBe(0);
		expect(opened.persistence.closing).toBe(true);
		expect(destroyed).toBe(1);
		expect(commits).toBe(1);
	} finally {
		release.resolve();
		context.storage.collaboration.commit = commit;
	}
	let restored = await Service.open(context.channel.id, context.backend, context.server);
	try {
		// The already-admitted commit settled before cleanup; it is not rolled back by close intent.
		expect(restored.records.get(context.id)?.threadId).toBe(`planner-ask:${context.id}`);
		expect(await backfillPlannerAskThreads(restored)).toBe(0);
	} finally {
		await Service.close(restored);
	}
});

test("failed real migration commit disposes the unpublished service and a later Memory reopen can retry", async () => {
	let context = await storedLegacy();
	let opened = await Service.open(context.channel.id, context.backend, context.server);
	let target = openingRoom(context.channel.id);
	let commit = context.storage.collaboration.commit;
	let failure = new Error("backfill store rejected");
	let failed = false;
	let destroyed = 0;
	let commits = 0;
	opened.document.doc.on("destroy", () => {
		destroyed++;
	});
	context.storage.collaboration.commit = input => {
		commits++;
		if (!failed) {
			failed = true;
			return Promise.reject(failure);
		}
		return commit(input);
	};
	try {
		await expect(
			prepareOpenedPlan(target, opened, () => backfillPlannerAskThreads(opened).then(() => {})),
		).rejects.toBe(failure);
		expect(target.plan).toBeUndefined();
		expect(opened.persistence.closing).toBe(true);
		expect(destroyed).toBe(1);
		expect(commits).toBe(1);
	} finally {
		context.storage.collaboration.commit = commit;
	}
	let retry = await Service.open(context.channel.id, context.backend, context.server);
	try {
		expect(retry.records.get(context.id)?.threadId).toBeUndefined();
		expect(retry.conversationPlan.events).toEqual([]);
		expect(room.project(retry.document)).toBe(context.source);
		await prepareOpenedPlan(target, retry, () =>
			backfillPlannerAskThreads(retry).then(count => {
				expect(count).toBe(1);
			}));
		expect(target.plan).toBe(retry);
		expect(retry.records.get(context.id)?.threadId).toBe(`planner-ask:${context.id}`);
	} finally {
		await Service.close(retry);
	}
});

test("persistent storage failure releases unpublished resources without a cleanup commit and permits retry", async () => {
	let context = await storedLegacy();
	let opened = await Service.open(context.channel.id, context.backend, context.server);
	let target = openingRoom(context.channel.id);
	let commit = context.storage.collaboration.commit;
	let failure = new Error("storage remains unavailable");
	let destroyed = 0;
	let commits = 0;
	let presenceDestroyed = 0;
	opened.document.doc.on("destroy", () => {
		destroyed++;
	});
	opened.presence.doc.on("destroy", () => {
		presenceDestroyed++;
	});
	expect(opened.questions.open.has(context.id)).toBe(true);
	context.storage.collaboration.commit = () => {
		commits++;
		return Promise.reject(failure);
	};
	try {
		await expect(prepareOpenedPlan(target, opened, async () => {
			await backfillPlannerAskThreads(opened);
		})).rejects.toBe(failure);
		expect(target.plan).toBeUndefined();
		expect(opened.persistence.closing).toBe(true);
		expect(destroyed).toBe(1);
		expect(presenceDestroyed).toBe(1);
		expect(opened.questions.open.size).toBe(0);
		expect(opened.chat.closed).toBe(true);
		expect(commits).toBe(1);
	} finally {
		context.storage.collaboration.commit = commit;
	}
	let retry = await Service.open(context.channel.id, context.backend, context.server);
	try {
		expect(retry.records.get(context.id)?.threadId).toBeUndefined();
		expect(retry.conversationPlan.events).toEqual([]);
		expect(room.project(retry.document)).toBe(context.source);
		await prepareOpenedPlan(target, retry, async () => {
			expect(await backfillPlannerAskThreads(retry)).toBe(1);
		});
		expect(target.plan).toBe(retry);
		expect(retry.records.get(context.id)?.threadId).toBe(`planner-ask:${context.id}`);
	} finally {
		await Service.close(retry);
	}
});

test("close intent while the actual channel lookup is held prevents migration admission", async () => {
	let context = await storedLegacy();
	let opened = await Service.open(context.channel.id, context.backend, context.server);
	let target = openingRoom(context.channel.id);
	let entered = deferred();
	let release = deferred();
	let get = context.storage.channels.get;
	let commit = context.storage.collaboration.commit;
	let commits = 0;
	let destroyed = 0;
	let attached = 0;
	opened.document.doc.on("destroy", () => {
		destroyed++;
	});
	context.storage.channels.get = async id => {
		entered.resolve();
		await release.promise;
		return get(id);
	};
	context.storage.collaboration.commit = input => {
		commits++;
		return commit(input);
	};
	try {
		target.opening = prepareOpenedPlan(target, opened, async () => {
			let channel = await context.storage.channels.get(context.channel.id);
			// The actual main caller owns this guard after its awaited channel lookup.
			if (target.closing) throw new Error("document is unavailable");
			if (!channel?.archivedAt) await backfillPlannerAskThreads(opened);
		}).then(plan => {
			attached++;
			return plan;
		});
		let failed = target.opening.then(() => undefined, error => error);
		let concurrent = target.opening.then(() => target.plan, error => error);
		await entered.promise;
		target.closing = target.opening.then(async () => {
			if (target.plan) await Service.close(target.plan);
		}, () => {});
		release.resolve();
		let [error, sameError] = await Promise.all([failed, concurrent, target.closing]);
		expect(error).toBeInstanceOf(Error);
		expect(error.message).toBe("document is unavailable");
		expect(sameError).toBe(error);
		expect(target.plan).toBeUndefined();
		expect(attached).toBe(0);
		expect(commits).toBe(0);
		expect(destroyed).toBe(1);
		expect(opened.persistence.closing).toBe(true);
	} finally {
		release.resolve();
		context.storage.channels.get = get;
		context.storage.collaboration.commit = commit;
	}
	let retry = await Service.open(context.channel.id, context.backend, context.server);
	try {
		expect(retry.records.get(context.id)?.threadId).toBeUndefined();
		expect(retry.conversationPlan.events).toEqual([]);
		expect(room.project(retry.document)).toBe(context.source);
		target.closing = undefined;
		await prepareOpenedPlan(target, retry, async () => {
			expect(await backfillPlannerAskThreads(retry)).toBe(1);
		});
		expect(target.plan).toBe(retry);
	} finally {
		await Service.close(retry);
	}
});

test.each([1, 2])("a %i-hop closing microtask cannot publish after close intent", async hops => {
	let context = await storedLegacy();
	let opened = await Service.open(context.channel.id, context.backend, context.server);
	let target = openingRoom(context.channel.id);
	let publishedBeforeClose: boolean | undefined;
	let destroyed = 0;
	let attached = 0;
	opened.document.doc.on("destroy", () => {
		destroyed++;
	});
	let closeIntent = () => {
		publishedBeforeClose = target.plan === opened;
		target.closing = target.opening!.then(async () => {
			let plan = target.plan;
			target.plan = undefined;
			if (plan) await Service.close(plan);
		}, () => {});
	};
	target.opening = prepareOpenedPlan(target, opened, () => {
		if (hops === 1) queueMicrotask(closeIntent);
		else queueMicrotask(() => queueMicrotask(closeIntent));
	}).then(plan => {
		attached++;
		return plan;
	});
	let result = await target.opening.then(
		plan => ({ plan, error: undefined }),
		error => ({ plan: undefined, error }),
	);
	await target.closing;
	expect(publishedBeforeClose).toBeDefined();
	if (hops === 1) expect(publishedBeforeClose).toBe(false);
	if (publishedBeforeClose) {
		// Synchronous publication preceded intent: normal queued close owns this plan.
		expect(result.plan).toBe(opened);
		expect(result.error).toBeUndefined();
		expect(attached).toBe(1);
	} else {
		expect(result.plan).toBeUndefined();
		expect(result.error).toBeInstanceOf(Error);
		expect(result.error.message).toBe("document is unavailable");
		expect(attached).toBe(0);
	}
	expect(target.plan).toBeUndefined();
	expect(opened.persistence.closing).toBe(true);
	expect(destroyed).toBe(1);
});
