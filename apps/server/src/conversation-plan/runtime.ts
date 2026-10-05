/** Connects durable conversation processing to the current authenticated Chat runtime. */
import * as Chat from "../chat/service";
import * as Plan from "../plan/service";
import * as Questions from "../questions/service";
import * as Room from "../plan/room";
import { broadcast } from "../wire";
import { cardEffects, mirrorCard, wakeCardMirror } from "./cards";
import { createJobContexts } from "./job-context";
import { PROMPT_FOR } from "./job-prompts";
import { createPlannerJobs, interruptPlannerJobs } from "./planner-jobs";
import { createProcessor, type Dependencies, type Processor } from "./service";
import { interpretMessage } from "./interpret";
import { askJev } from "./jev";
import { interpretResearch } from "./research-interpreter";
import type { Config } from "../config";
import type { Server } from "bun";
import type { SocketData } from "../wire";
import type * as Rooms from "../rooms";

type RuntimeDeps = {
	config: Pick<
		Config,
		"agent" | "conversationPlan" | "conversationPlanModel" | "conversationPlanTimeoutMs"
	>;
	server: () => Server<SocketData>;
	unavailable: (id: string) => boolean;
	interpret?: Dependencies["interpret"];
	researchInterpret?: Dependencies["researchInterpret"];
	onError?: (error: unknown) => void;
};

export function createConversationRuntime(deps: RuntimeDeps) {
	let processors = new WeakMap<Plan.Plan, Processor>();
	let jobs = new WeakMap<Plan.Plan, ReturnType<typeof createPlannerJobs>>();
	let listeners = new WeakMap<Plan.Plan, () => void>();
	let contexts = createJobContexts();
	let mirrors = new WeakMap<Plan.Plan, Promise<void>>();
	let stopping = new WeakMap<Plan.Plan, Promise<void>>();
	let report = deps.onError ?? ((error: unknown) => console.error("[conversation-plan]", error));

	function stop(opened: Plan.Plan): Promise<void> {
		let existing = stopping.get(opened);
		if (existing) return existing;
		let processor = processors.get(opened);
		processor?.stop();
		processors.delete(opened);
		let coordinator = jobs.get(opened);
		coordinator?.stop();
		jobs.delete(opened);
		listeners.get(opened)?.();
		listeners.delete(opened);
		contexts.clear(opened);
		let mirroring = mirrors.get(opened);
		mirrors.delete(opened);
		let draining = Promise.all([processor?.idle(), coordinator?.idle(), mirroring])
			.then(() => {})
			.finally(() => {
				if (stopping.get(opened) === draining) stopping.delete(opened);
			});
		stopping.set(opened, draining);
		return draining;
	}

	function wake(opened: Plan.Plan): void {
		let processor = processors.get(opened);
		if (!processor) return;
		if (!deps.unavailable(opened.id)) jobs.get(opened)?.wake();
		mirrors.set(opened, wakeCardMirror(opened, processor).catch(report));
	}

	async function attach(
		room: Rooms.Room,
		opened: Plan.Plan,
		archived: boolean,
		researchAllowed = false,
	): Promise<void> {
		if (!deps.config.conversationPlan) return;
		await stop(opened);
		let server = deps.server();
		let active = () =>
			room.plan === opened && !room.closing && !archived
			&& !deps.unavailable(room.id);
		let announcer: Chat.Announcer = { chat: opened.chat, plan: opened, server, room: room.id };
		let processor: Processor;
		let coordinator = archived || deps.unavailable(room.id) ? undefined : createPlannerJobs({
			plan: opened,
			exclusive: action => Plan.exclusive(opened, action),
			persist: () => Plan.persistExclusive(opened),
			runner: async (job, prompt, signal) => {
				if (!active()) return { status: "skipped", reason: "The document is unavailable." };
				if (!deps.config.agent) {
					return { status: "skipped", reason: "The Planner is off (AGENT=off)." };
				}
				let claim = contexts.claim(opened, job);
				return claim
					? Chat.job(claim.context, job, prompt, claim.claimantSessionId, signal)
					: {
						status: "skipped",
						reason: "No signed-in member is available to supply the Planner credential.",
					};
			},
			prompt: job => PROMPT_FOR[job.kind]?.(opened, job),
			headingAllowed: () => Room.headingAllowed(opened.document),
			publishJobs: current =>
				broadcast(server, room.id, { kind: "conversation-plan:jobs", ts: 0, jobs: current }),
			publishMeta: id => Questions.announce(opened, server, room.id, id),
			activity: async (text, questionnaireId, label) => {
				await Chat.noticeExclusive(announcer, {
					text,
					decision: { questionnaireId, kind: "activity", ...(label ? { label } : {}) },
				});
			},
			onCapacityAvailable: () => processor.wake(),
			onError: report,
		});
		if (coordinator) jobs.set(opened, coordinator);
		processor = createProcessor({
			plan: opened,
			exclusive: action => Plan.exclusive(opened, action),
			persist: () => Plan.persistExclusive(opened),
			publish: state =>
				broadcast(server, room.id, { kind: "conversation-plan:changed", ts: 0, state }),
			active,
			researchInterpret: researchAllowed
				? deps.researchInterpret
					?? ((input, signal) =>
						interpretResearch(input, request =>
							askJev(request, {
								model: deps.config.conversationPlanModel,
								timeoutMs: deps.config.conversationPlanTimeoutMs,
								signal,
							})))
				: undefined,
			interpret: deps.interpret ?? ((input, signal) =>
				interpretMessage({
					...input,
					ask: request =>
						askJev(request, {
							model: deps.config.conversationPlanModel,
							timeoutMs: deps.config.conversationPlanTimeoutMs,
							signal,
						}),
				})),
			onError: report,
		});
		processors.set(opened, processor);
		processor.setEffects(
			cardEffects(
				opened,
				server,
				room.id,
				processor,
				coordinator
					? (intent, key) => coordinator.enqueue(intent, key)
					: undefined,
				announcer,
			),
		);
		let recover = () => {
			processor.wake();
			mirrors.set(opened, mirrorCard(opened, processor).catch(report));
		};
		listeners.set(opened, Questions.listen(opened, recover));
		recover();
	}

	function bind(context: Chat.Room): Chat.Room {
		let opened = context.plan;
		let processor = processors.get(opened);
		if (processor) {
			context.commitRoomMessage = entry =>
				contexts.accept(opened, entry.id, context, () => processor.accept(entry));
			context.roomMessagePublished = () => {
				processor.afterMessage();
				wake(opened);
			};
		}
		return context;
	}

	function interrupt(opened: Plan.Plan): Promise<boolean> {
		let server = deps.server();
		return interruptPlannerJobs({
			plan: opened,
			exclusive: action => Plan.exclusive(opened, action),
			persist: () => Plan.persistExclusive(opened, true),
			publishJobs: current =>
				broadcast(server, opened.id, { kind: "conversation-plan:jobs", ts: 0, jobs: current }),
			publishMeta: id => Questions.announce(opened, server, opened.id, id),
			onError: report,
		});
	}

	return {
		attach,
		bind,
		wake,
		stop,
		interrupt,
		contexts,
		processor: (opened: Plan.Plan) => processors.get(opened),
		jobs: (opened: Plan.Plan) => jobs.get(opened),
	};
}
