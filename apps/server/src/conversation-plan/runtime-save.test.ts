import { expect, test } from "bun:test";
import * as Chat from "../chat/service";
import * as Plan from "../plan/service";
import * as Questions from "../questions/service";
import * as Store from "../questions/store";
import { openPlan } from "../testing/plan";
import { createConversationRuntime } from "./runtime";
import { interpretMessage } from "./interpret";
import { mockResult } from "./interpret.test-fixtures";
import { until } from "./service.test-fixtures";
import type { Room } from "../rooms";
import type { Socket } from "../wire";

function noop(): void {}

test("a live conversation suggests a linked human option, and human Save commits before acknowledgement and survives reopening", async () => {
	let opened = await openPlan();
	let plan = opened.plan;
	let room: Room = { id: plan.id, plan, members: new Map() };
	let errors: unknown[] = [];
	let replies: Array<Record<string, any>> = [];
	let socket = {
		data: { handle: "ana", principalId: "U_ana", client: "client", room: plan.id },
		send(raw: string) {
			replies.push(JSON.parse(raw));
		},
		publish() {},
	} as unknown as Socket;
	let optionId = "";
	let runtime = createConversationRuntime({
		config: { agent: false, conversationPlan: true },
		server: () => opened.server,
		unavailable: () => false,
		onError: error => errors.push(error),
		interpret: input =>
			interpretMessage({
				...input,
				ask: async request =>
					mockResult(
						request.questions,
						optionId
							? {
								act: "commitment",
								explicit_resolution: 0.98,
								thread_target: input.state.threads[0]!.id,
								c0_role: "resolution",
								c0_thread: input.state.threads[0]!.id,
								c0_explicit_resolution: 0.98,
								c0_chosen_option: optionId,
							}
							: {
								new_question: 0.95,
								enough_purpose: 0.95,
								act: "question",
								thread_target: "new",
								c0_role: "question",
								c0_thread: "new",
								c0_duplicate: 0.05,
							},
					),
			}),
	});
	let release = noop;
	let submitting: Promise<void> | undefined;
	try {
		await runtime.attach(room, plan, false);
		let context = runtime.bind({
			chat: plan.chat,
			plan,
			server: opened.server,
			room: plan.id,
			config: { agent: false } as Chat.Room["config"],
			persist: () => Plan.persist(plan),
		} as Chat.Room);
		await Chat.send(context, socket, {
			kind: "chat:send",
			rid: "opening",
			requestId: crypto.randomUUID(),
			to: "room",
			text: "Which authentication system should we use?",
			ts: 0,
		});
		await until(() =>
			!!plan.conversationPlan.threads[0]?.questionnaireId
			&& plan.conversationPlanPendingEffects.length === 0
		);
		let thread = plan.conversationPlan.threads[0]!;
		let id = thread.questionnaireId!;
		await Questions.addOption(plan, opened.server, plan.id, socket, {
			kind: "question:add-option",
			rid: "add",
			ts: 0,
			id,
			label: "Passkeys",
		});
		let added = replies.find(frame => frame.rid === "add")!;
		expect(added.ok).toBe(true);
		optionId = added.option.id;
		await Chat.send(context, socket, {
			kind: "chat:send",
			rid: "choice",
			requestId: crypto.randomUUID(),
			to: "room",
			text: "Let's go with Passkeys.",
			ts: 0,
		});
		await until(() =>
			Store.get(plan.questions, id)?.suggested?.optionId === optionId
			&& plan.conversationPlanPendingEffects.length === 0
		);
		expect(plan.records.get(id)?.status).toBe("open");
		expect(plan.conversationPlan.threads[0]?.decision).toBeUndefined();
		expect(plan.chat.entries.some(entry => entry.decision?.kind === "prompt")).toBe(true);
		let settled = false;
		let entered = false;
		let gate = new Promise<void>(resolve => release = resolve);
		let commit = opened.storage.collaboration.commit;
		opened.storage.collaboration.commit = async input => {
			let records = (input.sidecar as { questions?: { status: string }[] })?.questions;
			if (!entered && records?.some(record => record.status === "answered")) {
				entered = true;
				await gate;
			}
			return commit(input);
		};
		let revision = Store.get(plan.questions, id)!.revision;
		submitting = Questions.submit(plan, opened.server, plan.id, socket, {
			kind: "question:submit",
			rid: "save",
			ts: 0,
			id,
			revision,
			suggestedOptionId: optionId,
		}).then(() => {
			settled = true;
		});
		await until(() => entered);
		expect(settled).toBe(false);
		expect(replies.some(frame => frame.rid === "save")).toBe(false);
		expect(plan.records.get(id)?.status).toBe("open");
		let before = (await opened.storage.collaboration.load(plan.id, opened.now))!;
		expect(before.sidecar ?? before.snapshot!.sidecar).toMatchObject({
			questions: [{ id, status: "open" }],
		});
		release();
		await submitting;
		expect(replies.find(frame => frame.rid === "save")?.ok).toBe(true);
		await until(() =>
			plan.conversationPlan.threads[0]?.decision?.actor.kind === "member"
			&& plan.pendingCardActions.length === 0
			&& plan.conversationPlanPendingEffects.length === 0
		);
		expect(plan.records.get(id)).toMatchObject({
			status: "answered",
			owner: "ana",
			choices: [optionId],
		});
		expect(plan.conversationPlan.threads[0]?.decision).toMatchObject({
			actor: { kind: "member", handle: "ana" },
			text: "Passkeys",
		});
		expect(errors).toEqual([]);
		await runtime.stop(plan);
		await Plan.close(plan);
		plan = await Plan.open(opened.channel.id, opened.backend, opened.server);
		room.plan = plan;
		await runtime.attach(room, plan, false);
		await runtime.processor(plan)?.idle();
		expect(plan.records.get(id)).toMatchObject({
			status: "answered",
			owner: "ana",
			choices: [optionId],
		});
		expect(plan.conversationPlan.threads[0]?.decision).toMatchObject({
			actor: { kind: "member", handle: "ana" },
			text: "Passkeys",
		});
		expect(plan.pendingCardActions).toEqual([]);
		expect(plan.records.size).toBe(1);
	} finally {
		release();
		await submitting;
		await runtime.stop(plan);
		await Plan.close(plan);
	}
});
