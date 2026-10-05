import type { Dependencies } from "./processor-types";
export { MAX_PENDING_EFFECTS } from "./processor-fields";
export { researchQuoteFocus, researchQuoteSupportsPair } from "./processor-research-quotes";
export type { Dependencies, EffectCommands } from "./processor-types";
import { createOutbox } from "./processor-outbox";
import { createCommands } from "./processor-commands";
import { createScopedSave } from "./processor-scoped-save";
import { createResearchConsent } from "./processor-research-consent";
import { createRun } from "./processor-run";
import { createResearchProcessor } from "./research-processor";
import { createResearchDraftService } from "./research-draft-service";

// Exact archive 446a9779a937fa5be7cd3eb52fd7f3023d691ed2, service.ts; import/export and synchronous closure wrappers only.

export type Processor = ReturnType<typeof createProcessor>;

export function createProcessor(deps: Dependencies) {
	let { plan } = deps;
	let stopped = false;
	let controller = new AbortController();
	let running: Promise<void> | undefined;
	let commands = new Set<Promise<unknown>>();
	let wakeRequested = false;
	let effectCommands = deps.effects;
	let report = deps.onError ?? ((error: unknown) => console.error("[conversation-plan]", error));
	let active = () => !stopped && deps.active();
	let publish = () => {
		try {
			deps.publish(plan.conversationPlan);
		} catch (error) {
			report(error);
		}
	};
	let { markApplied, recover, drainEffects, setEffects } = createOutbox(
		deps,
		plan,
		active,
		wake,
		effectCommands,
	);
	let { accept, afterMessage, correct, record, retry } = createCommands(
		deps,
		plan,
		active,
		publish,
		wake,
	);
	let saveScopedChoice = createScopedSave(deps, plan, active, publish);
	let researchConsent = createResearchConsent(deps, plan, active, publish, markApplied, report);
	let run = createRun(deps, plan, active, controller, publish, recover, drainEffects);
	let research = createResearchProcessor(deps, active, controller.signal, publish);
	let drafts = createResearchDraftService(deps, active);

	function wake(): void {
		if (!active()) return;
		research.wake();
		if (running) {
			wakeRequested = true;
			return;
		}
		let blocked = false;
		let waitingForMirror = false;
		running = Promise.resolve().then(() => run()).then(waiting => {
			waitingForMirror = waiting;
		}).catch(error => {
			blocked = true;
			report(error);
		}).finally(() => {
			running = undefined;
			let requested = wakeRequested;
			wakeRequested = false;
			if (
				!blocked && active()
				&& (
					requested
					|| !waitingForMirror
						&& plan.conversationPlan.queue.some(item => item.status === "pending")
				)
			) wake();
		});
	}

	function stop(): void {
		stopped = true;
		controller.abort();
	}

	function track<Args extends unknown[], Result>(action: (...args: Args) => Promise<Result>) {
		return (...args: Args): Promise<Result> => {
			let task = action(...args);
			commands.add(task);
			let settled = () => commands.delete(task);
			void task.then(settled, settled);
			return task;
		};
	}

	/** Drain admitted commands and effects before closing their document. */
	async function idle(): Promise<void> {
		let tasks = [...commands, ...(running ? [running] : [])];
		while (tasks.length > 0) {
			await Promise.allSettled(tasks);
			tasks = [...commands, ...(running ? [running] : [])];
		}
		await research.idle();
	}

	return {
		accept: track(accept),
		afterMessage,
		correct: track(correct),
		saveScopedChoice: track(saveScopedChoice),
		researchConsent: track(researchConsent),
		record: track(record),
		retry: track(retry),
		retryResearch: track(research.retry),
		editResearch: track(drafts.edit),
		focusResearch: drafts.focus,
		leaveResearch: drafts.away,
		setEffects,
		wake,
		stop,
		idle,
	};
}
