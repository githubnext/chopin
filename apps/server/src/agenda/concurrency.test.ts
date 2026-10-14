import { expect, it } from "bun:test";
import { agendaFixture, QUESTIONS, SCOPE } from "./test-support";

it("rejects a stale private assessment after the document changes", async () => {
	let started = Promise.withResolvers<void>();
	let finish = Promise.withResolvers<void>();
	let context = await agendaFixture({
		assess: async input => {
			started.resolve();
			await finish.promise;
			return {
				decision: "investigate",
				questionId: input.questions[0]!.id,
				reason: "Original context.",
			};
		},
	});
	await context.activate();
	let running = context.agenda.tick(context.channelId);
	await started.promise;
	context.document("# New direction\n\nWe are investigating keyboard shortcuts instead.");
	finish.resolve();
	await running;
	let state = await context.agenda.get(context.channelId);
	expect(state?.investigations).toBe(0);
	expect(state?.assessments).toBe(1);
	expect(state?.nextRunAt).toBeDefined();
});

it("bounds model work to two global and one per owner without reserving waiting work", async () => {
	let started = 0;
	let finish = Promise.withResolvers<void>();
	let context = await agendaFixture({
		assess: async () => {
			started++;
			await finish.promise;
			return { decision: "sufficient", questionId: "", reason: "Enough evidence." };
		},
	});
	// The same service owns all documents and therefore the concurrency budget.
	let bindings = new Map<string, typeof context.owner>();
	context.options.resolveOwner = async channelId => {
		let owner = bindings.get(channelId) ?? context.owner;
		return {
			owner,
			token: () => "test-token",
			signal: new AbortController().signal,
			authorize: async () => true,
			release: () => {},
		};
	};
	let channels = [context.channelId];
	for (let index = 1; index < 4; index++) {
		let channelId = crypto.randomUUID();
		let owner = index === 1
			? context.owner
			: { ...context.owner, userId: `other-${index}`, sessionId: `session-${index}` };
		await context.storage.users.put({
			id: owner.userId,
			login: owner.userHandle,
			avatarUrl: "avatar",
			now: context.clock(),
		});
		await context.storage.channels.create({
			id: channelId,
			repositoryId: "repo-agenda",
			repositoryOwner: "octo-org",
			repositoryName: "score",
			title: "Other document",
			createdBy: owner.userId,
			now: context.clock(),
		});
		bindings.set(channelId, owner);
		channels.push(channelId);
	}
	for (let channelId of channels) {
		await context.agenda.save(channelId, {
			expectedRevision: 0,
			scope: SCOPE,
			questions: QUESTIONS,
		});
		await context.agenda.activate(channelId, 1, bindings.get(channelId) ?? context.owner);
	}
	let pending = channels.map(id => context.agenda.tick(id));
	for (let attempt = 0; attempt < 50; attempt++) {
		if (started >= 2) break;
		await Bun.sleep(1);
	}
	expect(started).toBe(2);
	let records = await Promise.all(channels.map(id => context.agenda.get(id)));
	expect(records.map(item => item?.reservedAiCredits)).toEqual([30, 0, 30, 0]);
	finish.resolve();
	await Promise.all(pending);
});

it("discarding a slow result after pause does not park a newly reauthorized generation", async () => {
	let began = Promise.withResolvers<void>();
	let finish = Promise.withResolvers<void>();
	let context = await agendaFixture({
		assess: async () => {
			began.resolve();
			await finish.promise;
			throw new Error("old model aborted");
		},
	});
	await context.activate();
	let pending = context.agenda.tick(context.channelId);
	await began.promise;
	let prior = (await context.agenda.get(context.channelId))!;
	await context.agenda.pause(context.channelId, prior.generation);
	let paused = (await context.agenda.get(context.channelId))!;
	await context.agenda.activate(context.channelId, paused.revision, context.owner);
	finish.resolve();
	await pending;
	expect((await context.agenda.get(context.channelId))?.state).toBe("active");
});

it("fences changes beyond the bounded prompt and clears a failed post-reservation owner lookup", async () => {
	let started = Promise.withResolvers<void>();
	let finish = Promise.withResolvers<void>();
	let context = await agendaFixture({
		assess: async input => {
			started.resolve();
			await finish.promise;
			return {
				decision: "investigate",
				questionId: input.questions[0]!.id,
				reason: "Old document.",
			};
		},
	});
	let prefix = "# Long document\n\n" + "Background material. ".repeat(2000);
	context.document(prefix + "First direction.");
	await context.activate();
	let tick = context.agenda.tick(context.channelId);
	await started.promise;
	context.document(prefix + "A changed direction beyond the prompt cutoff.");
	finish.resolve();
	await tick;
	expect((await context.agenda.get(context.channelId))?.investigations).toBe(0);

	let rejected = await agendaFixture();
	await rejected.activate();
	let resolver = rejected.options.resolveOwner;
	let calls = 0;
	rejected.options.resolveOwner = async id => {
		if (++calls > 1) throw new Error("transient authorization failure");
		return resolver(id);
	};
	await rejected.agenda.tick(rejected.channelId);
	let stored = await rejected.storage.agendas.get(rejected.channelId);
	expect(stored?.state).toBe("paused");
	expect(stored?.stopReason).toBe("owner-unavailable");
	expect(stored?.assessment).toBeUndefined();
});

it("discards a selection when a completed child report changes during private assessment", async () => {
	let began = Promise.withResolvers<void>();
	let finish = Promise.withResolvers<void>();
	let calls = 0;
	let context = await agendaFixture({
		assess: async input => {
			if (++calls === 2) {
				began.resolve();
				await finish.promise;
			}
			return {
				decision: "investigate",
				questionId: input.questions[0]!.id,
				reason: "Document-grounded evidence.",
			};
		},
	});
	await context.activate();
	await context.agenda.tick(context.channelId);
	await context.complete("research-evidence");
	await context.agenda.tick(context.channelId);
	await context.complete("research-answer");
	await context.agenda.tick(context.channelId);
	let view = (await context.agenda.get(context.channelId))!;
	let request = view.questions[0]!.request!;
	if (!request.child) throw new Error("Missing report");
	let sources = new Map([
		[context.channelId, "# Parent\n\nA remaining creation question."],
		[request.child.id, "# Evidence\n\nStatus labels are clear."],
	]);
	context.options.current = async channelId => ({ source: sources.get(channelId)! });
	context.advance(300_000);
	let pending = context.agenda.tick(context.channelId);
	await began.promise;
	sources.set(request.child.id, "# Evidence\n\nA human corrected the findings.");
	finish.resolve();
	await pending;
	expect((await context.agenda.get(context.channelId))?.investigations).toBe(1);
	expect((await context.agenda.get(context.channelId))?.nextRunAt).toBeDefined();
});
