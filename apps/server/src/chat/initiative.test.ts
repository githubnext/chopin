import { expect, spyOn, test } from "bun:test";
import * as Chat from "./service";
import { contributed, participation, setParticipation } from "./initiative";
import { flush, installInitiativeCleanup, message, pause } from "./initiative.test-fixtures";
import { until } from "./job.test-fixtures";

let setup = installInitiativeCleanup();

test("automatic participation is available by default and respects AGENT=off", async () => {
	let h = await setup.harness();
	expect(participation(h.context)).toEqual({ enabled: true, paused: false });
	h.context.config.agent = false;
	expect(participation(h.context).enabled).toBe(false);
	await Chat.send(h.context, h.ws, message());
	await h.clock.advance(30_000);
	expect(h.judge).not.toHaveBeenCalled();
	expect(h.prompts).toEqual([]);
});

test("a saved ordinary message reaches the judge once after persistence and backscroll", async () => {
	let h = await setup.harness();
	let committed = Promise.withResolvers<void>();
	let entered = Promise.withResolvers<void>();
	let source = message();
	h.context.persist = async () => {
		entered.resolve();
		await committed.promise;
	};
	let saving = Chat.send(h.context, h.ws, source);
	await entered.promise;
	await h.clock.advance(10_000);
	expect(h.judge).not.toHaveBeenCalled();
	expect(h.chat.backscroll).toEqual([]);
	expect(h.replies).toEqual([]);
	committed.resolve();
	await saving;
	expect(h.chat.backscroll[0]?.entryId).toBe(source.requestId);
	await h.clock.advance(1500);
	expect(h.judge).toHaveBeenCalledTimes(1);
	expect(h.judge.mock.calls[0]?.[0]).toMatchObject({
		sourceId: source.requestId,
		messages: [{ id: source.requestId, author: "member", handle: "ana", text: source.text }],
	});
	await Chat.send(h.context, h.ws, { ...source, rid: "delivery-retry" });
	await h.clock.advance(10_000);
	expect(h.judge).toHaveBeenCalledTimes(1);
	expect(h.chat.entries.filter(entry => entry.id === source.requestId)).toHaveLength(1);
});

test("a failed ordinary save creates no initiative opportunity", async () => {
	let h = await setup.harness();
	h.context.persist = async () => {
		throw new Error("save failed");
	};
	await Chat.send(h.context, h.ws, message());
	await h.clock.advance(10_000);
	expect(h.judge).not.toHaveBeenCalled();
	expect(h.chat.entries).toEqual([]);
	expect(h.chat.backscroll).toEqual([]);
	expect(h.replies.at(-1)?.kind).toBe("session:error");
});

test.each(["pending", "active"] as const)(
	"an ordinary child-focused message cancels %s root initiative and only permits direct requests",
	async phase => {
		let h = await setup.harness();
		h.judge.mockResolvedValue("respond");
		await Chat.send(h.context, h.ws, message("An unresolved root question"));
		if (phase === "active") {
			await h.clock.advance(1500);
			await until(() => h.prompts.length === 1);
		}
		let typing = spyOn(h.chat.initiative!, "typing");
		try {
			h.chat.initiative!.typing("ana-tab", "U_ana", true);
			let child = {
				...message("A note about the open child"),
				focus: "0f5b2c1e-8d3a-4b6f-9a21-7c4e5d6f7a8b",
			};
			await Chat.send(h.context, h.ws, child);
			await until(() => !h.chat.busy);
			expect(h.chat.entries.find(entry => entry.id === child.requestId)).toMatchObject({
				author: { kind: "member", handle: "ana" },
				text: child.text,
			});
			expect(h.chat.backscroll.find(entry => entry.entryId === child.requestId)).toMatchObject({
				handle: "ana",
				text: child.text,
			});
			expect(h.replies.at(-1)).toMatchObject({
				kind: "chat:send",
				id: child.requestId,
				queued: false,
			});
			expect(typing).toHaveBeenCalledWith("ana-tab", "U_ana", false);
			await h.clock.advance(12_000);
			expect(h.judge).toHaveBeenCalledTimes(phase === "active" ? 2 : 1);
			expect(h.prompts).toHaveLength(phase === "active" ? 1 : 0);
			expect(h.aborts()).toBe(phase === "active" ? 1 : 0);
			expect(h.chat.waiting).toEqual([]);
		} finally {
			typing.mockRestore();
		}
	},
);

test("a committed move starts an ordinary Planner turn and never repeats without new input", async () => {
	let h = await setup.harness();
	h.judge.mockResolvedValue("respond");
	let source = message();
	await Chat.send(h.context, h.ws, source);
	await h.clock.advance(1500);
	await until(() => h.prompts.length === 1);
	expect(h.prompts[0]).toContain(source.requestId);
	expect(h.prompts[0]).toContain("one concise final conversational reply");
	expect(h.chat.entries.some(entry => entry.author.kind === "system")).toBe(false);
	expect(h.chat.job).toBeUndefined();
	h.emit("session.idle");
	await until(() => !h.chat.busy);
	await h.clock.advance(30_000);
	expect(h.judge).toHaveBeenCalledTimes(1);
	expect(h.prompts).toHaveLength(1);
});

test.each(["permission", "owner", "unattached", "implementation", "departed"] as const)(
	"a %s denial stays quiet",
	async denial => {
		let h = await setup.harness();
		h.judge.mockResolvedValue("respond");
		if (denial === "permission") h.context.initiativeAuthorize = async () => false;
		if (denial === "owner") h.setOwnerAvailable(false);
		if (denial === "unattached") h.context.plannerNotAttached = async () => "not attached";
		if (denial === "implementation") h.context.plan.claiming = true;
		if (denial === "departed") h.context.initiativePresent = () => false;
		await Chat.send(h.context, h.ws, message());
		await h.clock.advance(1500);
		expect(h.judge).not.toHaveBeenCalled();
		expect(h.prompts).toEqual([]);
	},
);

test("permission is checked again after a judgment completes", async () => {
	let h = await setup.harness();
	let result = Promise.withResolvers<"respond">();
	h.judge.mockImplementation(() => result.promise);
	await Chat.send(h.context, h.ws, message());
	await h.clock.advance(1500);
	expect(h.judge).toHaveBeenCalledTimes(1);
	h.context.initiativeAuthorize = async () => false;
	result.resolve("respond");
	await flush();
	expect(h.prompts).toEqual([]);
	expect(h.chat.entries.every(entry => entry.author.kind === "member")).toBe(true);
});

test.each(["document", "transcript"] as const)(
	"a changed %s invalidates the judgment before dispatch",
	async target => {
		let h = await setup.harness();
		let result = Promise.withResolvers<"respond">();
		h.judge.mockImplementationOnce(() => result.promise);
		await Chat.send(h.context, h.ws, message());
		await h.clock.advance(1500);
		if (target === "document") h.context.plan.revision = (h.context.plan.revision ?? 0) + 1;
		else {
			h.chat.entries.push({
				id: "changed",
				author: { kind: "agent" },
				text: "Answered.",
				ts: 1,
			});
		}
		result.resolve("respond");
		await flush();
		expect(h.prompts).toEqual([]);
		expect(h.chat.waiting).toEqual([]);
	},
);

test("a new saved source cancels a stale judgment before its instruction can queue", async () => {
	let h = await setup.harness();
	let result = Promise.withResolvers<"respond">();
	h.judge.mockImplementationOnce(() => result.promise);
	await Chat.send(h.context, h.ws, message("Old question"));
	await h.clock.advance(1500);
	let stale = h.judge.mock.calls[0]?.[1]?.signal;
	await Chat.send(h.context, h.ws, message("New direction"));
	expect(stale?.aborted).toBe(true);
	result.resolve("respond");
	await flush();
	expect(h.chat.waiting).toEqual([]);
	expect(h.prompts).toEqual([]);
	await h.clock.advance(1500);
	expect(h.judge).toHaveBeenCalledTimes(2);
});

test("new ordinary input aborts an active initiative and explicit instructions remain possible", async () => {
	let h = await setup.harness();
	h.judge.mockResolvedValueOnce("respond");
	await Chat.send(h.context, h.ws, message());
	await h.clock.advance(1500);
	await until(() => h.prompts.length === 1);
	await Chat.send(h.context, h.ws, message("A new constraint"));
	await until(() => !h.chat.busy);
	expect(h.aborts()).toBe(1);
	await Chat.send(h.context, h.ws, message("Please help with the next step", "planner"));
	await until(() => h.prompts.length === 2);
	expect(h.prompts[1]).toContain("Please help with the next step");
	h.emit("session.idle");
	await until(() => !h.chat.busy);
});

test("manual stop records the active initiative interruption once", async () => {
	let h = await setup.harness();
	h.judge.mockResolvedValueOnce("respond");
	await Chat.send(h.context, h.ws, message());
	await h.clock.advance(1500);
	await until(() => h.prompts.length === 1);
	await Chat.abort(h.context, h.ws);
	await until(() => !h.chat.busy);
	expect(h.aborts()).toBe(1);
	expect(h.chat.entries.filter(entry =>
		entry.author.kind === "system"
		&& entry.text === "@ana stopped the turn."
	)).toHaveLength(1);
	expect(h.frames.filter(frame =>
		frame.kind === "chat:message"
		&& (frame.entry as { text?: string } | undefined)?.text === "@ana stopped the turn."
	))
		.toHaveLength(1);
});

test("a newer message being saved prevents an older judgment from dispatching", async () => {
	let h = await setup.harness();
	let result = Promise.withResolvers<"respond">();
	h.judge.mockImplementationOnce(() => result.promise);
	await Chat.send(h.context, h.ws, message("Old source"));
	await h.clock.advance(1500);
	let entered = Promise.withResolvers<void>();
	let release = Promise.withResolvers<void>();
	h.context.persist = async () => {
		entered.resolve();
		await release.promise;
	};
	let newer = Chat.send(h.context, h.ws, message("New source still committing"));
	await entered.promise;
	result.resolve("respond");
	await flush();
	expect(h.prompts).toEqual([]);
	expect(h.chat.waiting).toEqual([]);
	release.resolve();
	await newer;
	await h.clock.advance(1500);
	expect(h.judge).toHaveBeenCalledTimes(2);
	expect(h.prompts).toEqual([]);
});

test("a stale queued initiative instruction leaves the active explicit turn intact", async () => {
	let h = await setup.harness();
	await Chat.send(h.context, h.ws, message("Explicit current turn", "planner"));
	await until(() => h.prompts.length === 1);
	let controller = new AbortController();
	let outcomes: Chat.Ended[] = [];
	await Chat.instruct(h.context, "Chopin", "Stale initiative", "Joining", {
		signal: controller.signal,
		ended: outcome => {
			outcomes.push(outcome);
		},
	});
	expect(h.chat.waiting).toHaveLength(1);
	controller.abort();
	expect(h.aborts()).toBe(0);
	h.emit("session.idle");
	await until(() => !h.chat.busy);
	expect(h.prompts).toHaveLength(1);
	expect(h.chat.waiting).toEqual([]);
	expect(outcomes).toHaveLength(1);
});

test("stale input while a Planner session opens cannot reach the stream", async () => {
	let h = await setup.harness();
	h.judge.mockResolvedValueOnce("respond");
	let entered = Promise.withResolvers<void>();
	let release = Promise.withResolvers<void>();
	let open = h.context.openPlannerSession!;
	h.context.openPlannerSession = async (...args) => {
		entered.resolve();
		await release.promise;
		return open(...args);
	};
	await Chat.send(h.context, h.ws, message());
	await h.clock.advance(1500);
	await entered.promise;
	await Chat.send(h.context, h.ws, message("Changed before session opening"));
	release.resolve();
	await until(() => !h.chat.busy);
	expect(h.prompts).toEqual([]);
	expect(h.chat.waiting).toEqual([]);
});

test("a document changed while a Planner session opens cannot reach the stream", async () => {
	let h = await setup.harness();
	h.judge.mockResolvedValueOnce("respond");
	let entered = Promise.withResolvers<void>();
	let release = Promise.withResolvers<void>();
	let open = h.context.openPlannerSession!;
	h.context.openPlannerSession = async (...args) => {
		entered.resolve();
		await release.promise;
		return open(...args);
	};
	try {
		await Chat.send(h.context, h.ws, message());
		await h.clock.advance(1500);
		await entered.promise;
		h.context.plan.revision = (h.context.plan.revision ?? 0) + 1;
		release.resolve();
		await until(() => !h.chat.busy);
		expect(h.prompts).toEqual([]);
		expect(h.chat.waiting).toEqual([]);
	} finally {
		release.resolve();
	}
});

test("participation cannot be paused, and a previously saved pause is ignored", async () => {
	let h = await setup.harness();
	h.chat.initiativePaused = true;
	let persisted = false;
	h.context.persist = async () => {
		persisted = true;
	};
	await setParticipation(h.context, h.ws, pause(true));
	expect(persisted).toBe(false);
	expect(h.replies.at(-1)?.kind).toBe("session:error");
	expect(h.frames.some(frame => frame.kind === "chat:participation")).toBe(false);
	expect(participation(h.context).paused).toBe(false);
	await Chat.send(h.context, h.ws, message());
	await h.clock.advance(1500);
	expect(h.judge).toHaveBeenCalledTimes(1);
});

test("contribution identities distinguish principals rather than tabs", async () => {
	let h = await setup.harness();
	let saved = {
		id: "saved",
		author: { kind: "member" as const, handle: "ana" },
		text: "Context",
		ts: 0,
	};
	h.chat.entries.push(saved);
	contributed(h.context, h.ws, saved);
	let scheduler = h.chat.initiative!;
	scheduler.typing("another-tab", "U_ana", true);
	scheduler.typing("another-tab", "U_ana", false);
	await h.clock.advance(1500);
	expect(h.judge).toHaveBeenCalledTimes(1);
});

test("tool-only agent entries do not consume a human's pending conversational turn", async () => {
	let h = await setup.harness();
	h.judge.mockResolvedValue("respond");
	await Chat.send(h.context, h.ws, message());
	h.chat.entries.push({ id: "tool-only", author: { kind: "agent" }, text: "", ts: 1 });
	await h.clock.advance(1500);
	await until(() => h.prompts.length === 1);
	expect(h.prompts).toHaveLength(1);
});

test("a natural direct child request resolves and preserves its child focus", async () => {
	let h = await setup.harness();
	let childId = "0f5b2c1e-8d3a-4b6f-9a21-7c4e5d6f7a8b";
	h.judge.mockResolvedValue("direct");
	h.context.children = {
		resolve: async () => ({ id: childId, title: "Child report" }),
	} as unknown as Chat.Room["children"];
	await Chat.send(h.context, h.ws, {
		...message("Chopin, can you investigate this?"),
		focus: childId,
	});
	await h.clock.advance(1500);
	await until(() => h.prompts.length === 1);
	expect(h.prompts[0]).toContain(childId);
	expect(h.prompts[0]).toContain("Child report");
	expect(Chat.documentRoom(h.context).focusedChild?.()).toBe(childId);
	await Chat.close(h.chat);
	expect(Chat.documentRoom(h.context).focusedChild?.()).toBeUndefined();
});

test("an unavailable focused child consumes its direct request without a retry loop", async () => {
	let h = await setup.harness();
	h.judge.mockResolvedValue("direct");
	h.context.children = { resolve: async () => undefined } as unknown as Chat.Room["children"];
	await Chat.send(h.context, h.ws, {
		...message("Chopin, can you investigate this?"),
		focus: "0f5b2c1e-8d3a-4b6f-9a21-7c4e5d6f7a8b",
	});
	await h.clock.advance(60_000);
	expect(h.judge).toHaveBeenCalledTimes(1);
	expect(h.prompts).toEqual([]);
});

test("later chunks of an existing reply preserve new human contributors", async () => {
	let h = await setup.harness();
	await Chat.send(h.context, h.ws, message("Initial message"));
	Chat.translate(h.context, { type: "text-start", id: "reply" });
	Chat.translate(h.context, { type: "text-delta", id: "reply", text: "First answer." });
	await Chat.send(h.context, h.ws, message("I prefer Markdown"));
	Chat.translate(h.context, { type: "text-delta", id: "reply", text: " More of that answer." });
	h.ws.data.principalId = "U_bo";
	h.ws.data.handle = "bo";
	await Chat.send(h.context, h.ws, message("I prefer PDF"));
	await h.clock.advance(1500);
	expect(h.judge.mock.calls.at(-1)?.[0].turn.group).toBe(true);
});
