/**
 * A message sent to the Planner while a turn runs is never held: it is posted at once and given to
 * that turn, which reads it at its next step; or it is refused, saying why.
 */
import { expect, spyOn, test } from "bun:test";
import { ulid } from "@chopin/dialect";

import * as Chat from "./service";
import { harness, installJobCleanup, JOB, member, socket, until } from "./job.test-fixtures";

import type { Chat as Wire } from "@chopin/protocol";
import type { Socket } from "../wire";
import type { ReferenceService } from "./references";

installJobCleanup();

type Frame = { kind: string; [key: string]: unknown };

function speaking(handle: string, frames: Frame[] = []): Socket {
	return {
		data: { handle, principalId: `U_${handle}` },
		send: (raw: string) => frames.push(JSON.parse(raw) as Frame),
	} as unknown as Socket;
}

const CANNOT = "Chopin can't take messages while it works on this machine. Stop it to ask now.";

test("a message sent while a turn runs is posted at once and given to that turn, not held", async () => {
	let h = harness();
	await Chat.send(h.context, socket(), member("@chopin plan the rollout"));
	await until(() => h.prompts.length === 1);

	let frames: Frame[] = [];
	let second = member("@chopin also cover the rollback");
	await Chat.send(h.context, speaking("bo", frames), second);

	// Acknowledged and in the transcript before the Planner has read it.
	expect(frames).toEqual([
		expect.objectContaining({ kind: "chat:send", id: second.requestId }),
	]);
	expect(h.chat.entries.map(entry => [entry.author, entry.text])).toEqual([
		[{ kind: "member", handle: "ana" }, "plan the rollout"],
		[{ kind: "member", handle: "bo" }, "also cover the rollback"],
	]);
	expect(h.chat.entries[1]).toHaveProperty("delivery");
	expect(h.chat.waiting).toEqual([]);
	let announced = h.frames.filter(frame => frame.kind === "chat:message");
	expect(announced.map(frame => (frame.entry as Wire.Entry).text)).toEqual([
		"plan the rollout",
		"also cover the rollback",
	]);
	expect((announced[1]!.entry as Wire.Entry).to).toBe("planner");
	expect(announced[1]!.entry).not.toHaveProperty("delivery");

	// Read at the turn's next step, as the person who sent it: the same turn, no new prompt.
	await until(() => h.steered.length === 1);
	expect(h.steered).toEqual(["@bo: also cover the rollback"]);
	expect(h.prompts).toHaveLength(1);
	h.emit("session.idle");
	await until(() => !h.chat.busy);
	expect(h.prompts).toHaveLength(1);
	expect(h.chat.turn).toBeUndefined();
});

test("two people steer one turn, each message read once, in the order it was sent", async () => {
	let h = harness();
	await Chat.send(h.context, speaking("ana"), member("@chopin draft it"));
	await until(() => h.prompts.length === 1);
	await Chat.send(h.context, speaking("bo"), member("@chopin keep it short"));
	await Chat.send(h.context, speaking("cy"), member("@chopin and name an owner"));
	await until(() => h.steered.length === 2);
	expect(h.steered).toEqual(["@bo: keep it short", "@cy: and name an owner"]);
	expect(h.chat.entries.map(entry => entry.author.kind === "member" ? entry.author.handle : ""))
		.toEqual([
			"ana",
			"bo",
			"cy",
		]);
	h.emit("session.idle");
	await until(() => !h.chat.busy);
});

test("the same request sent again after its answer was lost is answered with its first answer, and given once", async () => {
	let h = harness();
	await Chat.send(h.context, socket(), member("@chopin draft it"));
	await until(() => h.prompts.length === 1);
	let steering = member("@chopin keep it short");
	await Chat.send(h.context, speaking("bo"), steering);
	let frames: Frame[] = [];
	await Chat.send(h.context, speaking("bo", frames), { ...steering, rid: "again" });
	expect(frames).toEqual([
		expect.objectContaining({ kind: "chat:send", rid: "again", id: steering.requestId }),
	]);
	await until(() => h.steered.length === 1);
	await Bun.sleep(20);
	expect(h.steered).toHaveLength(1);
	expect(h.chat.entries.filter(entry => entry.id === steering.requestId)).toHaveLength(1);
	h.emit("session.idle");
	await until(() => !h.chat.busy);
});

test("a message carries its references to the turn, which can read them", async () => {
	let h = harness();
	let reference = {
		id: ulid(),
		kind: "document",
		start: 0,
		end: 8,
		label: "#Release",
		href: "/documents/owner/repo/release",
		repositoryId: "repo",
		observedRevision: 1,
		channelId: crypto.randomUUID(),
		observedSourceHash: `sha256:${"0".repeat(64)}`,
	} as Wire.DocumentReference;
	h.context.references = {
		resolve: async (input: { text: string }) =>
			input.text.includes("#release")
				? { text: "#Release", references: [reference] }
				: { text: input.text },
	} as unknown as ReferenceService;
	await Chat.send(h.context, socket(), member("@chopin draft it"));
	await until(() => h.prompts.length === 1);
	await Chat.send(h.context, speaking("bo"), {
		...member("@chopin check #release"),
		references: [{ kind: "document", channelId: reference.channelId, start: 0, end: 8 }],
	});
	await until(() => h.steered.length === 1);
	expect(h.steered[0]).toContain("@bo: ");
	expect(h.steered[0]).toContain(reference.id);
	expect(h.chat.referenceCache.has(reference.id)).toBe(true);
	expect(h.chat.entries.at(-1)?.references).toEqual([reference]);
	h.emit("session.idle");
	await until(() => !h.chat.busy);
});

test("a message sent before the turn's first model call is given to it once that call is made", async () => {
	let h = harness();
	let opening = Promise.withResolvers<void>();
	let open = h.context.openPlannerSession!;
	h.context.openPlannerSession = async (...args) => {
		let opened = await open(...args);
		if (!opened.ok) return opened;
		let { stream } = opened.value;
		return {
			ok: true,
			value: {
				...opened.value,
				async stream(...call: Parameters<typeof stream>) {
					await opening.promise;
					return stream(...call);
				},
			},
		};
	};
	await Chat.send(h.context, socket(), member("@chopin draft it"));
	await until(() => h.chat.steering !== undefined);
	await Chat.send(h.context, speaking("bo"), member("@chopin keep it short"));
	expect(h.chat.entries).toHaveLength(2);
	await Bun.sleep(30);
	expect(h.steered).toEqual([]);
	opening.resolve();
	await until(() => h.steered.length === 1);
	expect(h.steered).toEqual(["@bo: keep it short"]);
	expect(h.prompts).toHaveLength(1);
	h.emit("session.idle");
	await until(() => !h.chat.busy);
});

test("a harness that takes no input mid-run refuses the message, naming how to ask now, and saves nothing", async () => {
	let h = harness();
	h.context.steers = undefined;
	h.context.config.harness = "copilot-sdk";
	let warned = spyOn(console, "warn").mockImplementation(() => {});
	let saved = 0;
	let persist = h.context.persist;
	await Chat.send(h.context, socket(), member("@chopin draft it"));
	await until(() => h.prompts.length === 1);
	h.context.persist = async chat => {
		saved++;
		await persist(chat);
	};
	let frames: Frame[] = [];
	await Chat.send(h.context, speaking("bo", frames), member("@chopin also this"));
	expect(frames).toEqual([
		expect.objectContaining({ kind: "session:error", message: CANNOT, code: "planner-busy" }),
	]);
	expect(saved).toBe(0);
	// The log, not the person, names the harness that takes none.
	expect(warned).toHaveBeenCalledWith(
		"[chat] refused a message while a turn runs: the copilot-sdk harness takes no input while a turn runs",
	);
	warned.mockRestore();
	expect(h.chat.entries.map(entry => entry.text)).toEqual(["draft it"]);
	expect(h.chat.waiting).toEqual([]);
	expect(h.steered).toEqual([]);
	h.emit("session.idle");
	await until(() => !h.chat.busy);
	expect(h.prompts).toHaveLength(1);
});

test("a background job's turn takes no message: it is refused, and Stop is how to ask now", async () => {
	let h = harness();
	let job = Chat.job(h.context, JOB, "job prompt", "session");
	await until(() => h.prompts.length === 1);
	let frames: Frame[] = [];
	await Chat.send(h.context, speaking("bo", frames), member("@chopin also this"));
	expect(frames).toEqual([
		expect.objectContaining({ kind: "session:error", message: CANNOT, code: "planner-busy" }),
	]);
	expect(h.chat.entries).toEqual([]);
	expect(h.steered).toEqual([]);
	h.emit("session.idle");
	await job;
	await until(() => !h.chat.busy);
});

test("a machine that is away refuses the message, even mid-turn, with the connection's own words, and holds nothing", async () => {
	let h = harness();
	await Chat.send(h.context, socket(), member("@chopin draft it"));
	await until(() => h.prompts.length === 1);
	h.context.plannerNotAttached = async () => "@mona's machine is offline, so it can't reply now.";
	let frames: Frame[] = [];
	await Chat.send(h.context, speaking("bo", frames), member("@chopin also this"));
	expect(frames).toEqual([
		expect.objectContaining({
			kind: "session:error",
			message: "@mona's machine is offline, so it can't reply now.",
			code: "planner-not-attached",
		}),
	]);
	expect(h.chat.entries.map(entry => entry.text)).toEqual(["draft it"]);
	expect(h.chat.waiting).toEqual([]);
	expect(h.steered).toEqual([]);
	h.emit("session.idle");
	await until(() => !h.chat.busy);
});

test("a message sent while a turn only begins or finishes is sent again by its browser in a moment, not refused for good", async () => {
	let h = harness();
	// Between replies: busy, with no session to give a message to just now.
	h.chat.busy = true;
	let frames: Frame[] = [];
	await Chat.send(h.context, speaking("bo", frames), member("@chopin also this"));
	expect(frames).toEqual([
		expect.objectContaining({ kind: "session:error", code: "temporarily-unavailable" }),
	]);
	expect(h.chat.entries).toEqual([]);
	h.chat.busy = false;
});

test("a message the turn cannot take is said not to have been read, and is neither lost to a queue nor sent twice", async () => {
	let h = harness();
	await Chat.send(h.context, socket(), member("@chopin draft it"));
	await until(() => h.prompts.length === 1);
	h.context.chat.agent!.steer = async () => {
		throw new Error("The model is between steps.");
	};
	await Chat.send(h.context, speaking("bo"), member("@chopin keep it short"));
	await until(() =>
		h.chat.entries.some(entry =>
			entry.author.kind === "system" && entry.text.includes("did not read")
		)
	);
	expect(h.chat.entries.at(-1)).toMatchObject({
		author: { kind: "system" },
		text: "Chopin did not read @bo's message. Send it again to ask.",
	});
	expect(h.chat.waiting).toEqual([]);
	expect(h.prompts).toHaveLength(1);
	h.emit("session.idle");
	await until(() => !h.chat.busy);
	expect(h.prompts).toHaveLength(1);
});

test("a message the turn ended too soon to read starts a turn of its own, as if it had been sent when the Planner was idle", async () => {
	let h = harness();
	await Chat.send(h.context, socket(), member("@chopin draft it"));
	await until(() => h.prompts.length === 1);
	h.context.chat.agent!.steer = async () => {
		// The turn ends between the message being posted and the turn taking it.
		h.emit("session.idle");
		await until(() => !h.chat.busy);
		throw new Error("Harness session has no running turn to steer.");
	};
	await Chat.send(h.context, speaking("bo"), member("@chopin keep it short"));
	await until(() => h.prompts.length === 2);
	expect(h.prompts[1]).toBe("@bo: keep it short");
	expect(h.chat.entries.map(entry => entry.text)).toEqual(["draft it", "keep it short"]);
	expect(h.chat.entries.some(entry => entry.author.kind === "system")).toBe(false);
	h.emit("session.idle");
	await until(() => !h.chat.busy);
});

test("an idle Chat starts a turn for the message, as it always did, and nothing is steered", async () => {
	let h = harness();
	await Chat.send(h.context, socket(), member("@chopin draft it"));
	await until(() => h.prompts.length === 1);
	expect(h.prompts).toEqual(["@ana: draft it"]);
	expect(h.steered).toEqual([]);
	h.emit("session.idle");
	await until(() => !h.chat.busy);
});

test("an invoke_planner call while the process is stopping and idle is answered planner-unavailable, for its caller to ask the next process", async () => {
	let h = harness();
	Chat.holdStarts();
	try {
		expect(await Chat.invoke(h.context, { id: "U_ana", login: "ana" }, "Review the plan")).toBe(
			"planner-unavailable",
		);
		expect(
			await Chat.invoke(
				h.context,
				{ id: "U_ana", login: "ana" },
				"follow up",
				undefined,
				undefined,
				undefined,
				"Automatic follow-up requested by @ana.",
			),
		).toBe("planner-unavailable");
	} finally {
		Chat.holdStarts(false);
	}
	expect(h.chat.entries).toEqual([]);
	expect(h.chat.waiting).toEqual([]);
	expect(h.prompts).toEqual([]);
});
