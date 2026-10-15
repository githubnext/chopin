import { afterEach, beforeEach, spyOn } from "bun:test";
import type { Chat as Wire, Request } from "@chopin/protocol";
import type { Socket } from "../wire";
import * as Document from "../plan/room";
import * as Chat from "./service";
import * as Judge from "./initiative-judge";
import * as Schedule from "./initiative-schedule";
import { harness as jobHarness } from "./job-harness.test-fixtures";

export class ManualClock implements Schedule.InitiativeClock {
	private time = 0;
	private next = 0;
	private timers = new Map<number, { at: number; callback: () => void }>();

	now() {
		return this.time;
	}

	set(callback: () => void, delay: number) {
		let id = ++this.next;
		this.timers.set(id, { at: this.time + delay, callback });
		return id;
	}

	clear(timer: unknown) {
		if (typeof timer === "number") this.timers.delete(timer);
	}

	async advance(milliseconds: number) {
		let target = this.time + milliseconds;
		for (;;) {
			let next = [...this.timers.entries()].filter(([, timer]) => timer.at <= target)
				.sort((a, b) => a[1].at - b[1].at)[0];
			if (!next) break;
			this.timers.delete(next[0]);
			this.time = next[1].at;
			next[1].callback();
			await flush();
		}
		this.time = target;
		await flush();
	}
}

export async function flush() {
	for (let i = 0; i < 50; i++) await Promise.resolve();
}

export function installInitiativeCleanup() {
	let chats: Chat.Chat[] = [];
	let documents: Document.Document[] = [];
	let clock: ManualClock;
	let judge: ReturnType<typeof spyOn<typeof Judge, "judgeInitiative">>;
	let schedule: ReturnType<typeof spyOn<typeof Schedule, "createInitiativeSchedule">>;
	let errors: ReturnType<typeof spyOn<typeof console, "error">>;
	let original = Schedule.createInitiativeSchedule;
	beforeEach(() => {
		clock = new ManualClock();
		judge = spyOn(Judge, "judgeInitiative").mockResolvedValue(undefined);
		schedule = spyOn(Schedule, "createInitiativeSchedule")
			.mockImplementation(options => original({ ...options, clock }));
		errors = spyOn(console, "error").mockImplementation(() => {});
	});
	afterEach(async () => {
		for (let chat of chats) await Chat.close(chat);
		for (let document of documents) document.doc.destroy();
		chats = [];
		documents = [];
		judge.mockRestore();
		schedule.mockRestore();
		errors.mockRestore();
	});
	return {
		async harness() {
			let h = jobHarness(true, chats);
			let document = await Document.create("# Discussion\n\nDecisions record shared choices.\n");
			documents.push(document);
			Object.assign(h.context.plan, { document, builds: [], records: new Map() });
			Object.assign(h.context.config, {
				conversationInitiativeSilenceMs: 15_000,
				conversationPlanTimeoutMs: 1000,
			});
			h.context.initiativePresent = () => true;
			h.context.initiativeAuthorize = async () => true;
			let replies: Array<Record<string, unknown>> = [];
			let ws = {
				data: {
					handle: "ana",
					principalId: "U_ana",
					sessionId: "session",
					client: "ana-tab",
					canEdit: true,
				},
				send(value: string) {
					replies.push(JSON.parse(value) as Record<string, unknown>);
				},
			} as unknown as Socket;
			return { ...h, clock, judge, replies, ws };
		},
	};
}

export function message(
	text = "What does a decision represent?",
	to: Wire.Send["to"] = "room",
): Request<Wire.Send> {
	return {
		kind: "chat:send",
		ts: 0,
		rid: crypto.randomUUID(),
		requestId: crypto.randomUUID(),
		text,
		to,
	};
}

export function pause(paused: boolean): Request<Wire.SetParticipation> {
	return { kind: "chat:participation", ts: 0, rid: crypto.randomUUID(), paused };
}
