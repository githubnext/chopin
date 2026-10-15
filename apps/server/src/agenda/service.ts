import { AgendaCoordinator } from "./coordinator";
import { AgendaState } from "./state";
import { guardResearch, wrapResearchDefinition } from "./research-guard";
import {
	AGENDA_LIMITS,
	AgendaError,
	normalizedQuestion,
	saveSchema,
	uniqueQuestions,
} from "./domain";
import type { Agenda } from "@chopin/protocol";
import type { AgendaOwner } from "../storage/agenda";
import type { JobDefinition } from "../jobs/registry";
import type { JsonValue } from "../storage/model";
import type { AgendaOptions } from "./state";

export type { AgendaOwner } from "../storage/agenda";
export { AGENDA_LIMITS, AgendaError } from "./domain";
export type { AgendaOptions } from "./state";

export class AgendaService {
	#state: AgendaState;
	#coordinator: AgendaCoordinator;
	#timer?: ReturnType<typeof setInterval>;
	#closed = false;
	constructor(options: AgendaOptions) {
		this.#state = new AgendaState(options);
		this.#coordinator = new AgendaCoordinator(this.#state);
	}

	available() {
		return this.#state.options.available();
	}

	async get(channelId: string): Promise<Agenda.View | null> {
		let record = await this.#state.options.storage.agendas.get(channelId);
		if (!record) return null;
		let { owner, assessment: _assessment, ...view } = record;
		let questions: Agenda.Question[] = [];
		for (let question of record.questions) {
			let run = question.requestId
				&& await this.#state.options.storage.agendas.run(channelId, question.requestId);
			let workspaceId = run && await this.#state.workspace(run);
			let request = workspaceId
				? await this.#state.options.research.request(channelId, workspaceId)
				: undefined;
			questions.push({ ...question, ...(request ? { request } : {}) });
		}
		return { ...view, questions, ...(owner ? { delegatedBy: owner.userHandle } : {}) };
	}

	async save(channelId: string, input: Agenda.Save): Promise<void> {
		let parsed = saveSchema.safeParse(input);
		if (!parsed.success) {
			throw new AgendaError("invalid", "Provide a public scope and up to six bounded questions.");
		}
		let previous = await this.#state.exclusive(channelId, async () => {
			let channel = await this.#state.options.storage.channels.get(channelId);
			if (!channel || channel.archivedAt || channel.parentChannelId) {
				throw new AgendaError(
					"unavailable",
					"Research agendas require an active top-level document.",
				);
			}
			let old = await this.#state.options.storage.agendas.get(channelId);
			if ((old?.revision ?? 0) !== parsed.data.expectedRevision) {
				throw new AgendaError("conflict", "The research agenda changed. Refresh and try again.");
			}
			let questions = uniqueQuestions(parsed.data.questions).map(question => {
				let preserved = old?.questions.find(item =>
					item.state === "completed"
					&& normalizedQuestion(item.question) === normalizedQuestion(question.question)
					&& item.reason === question.reason && item.evidenceNeed === question.evidenceNeed
				);
				return preserved
					? { ...preserved, priority: question.priority }
					: { ...question, id: this.#state.id(), state: "queued" as const };
			});
			await this.#state.store({
				channelId,
				revision: old?.revision ?? 0,
				generation: (old?.generation ?? 0) + 1,
				scope: parsed.data.scope,
				state: "paused",
				stopReason: "scope-changed",
				questions,
				investigations: 0,
				reservedSessions: 0,
				assessments: 0,
				updatedAt: this.#state.clock().toISOString(),
			});
			this.#state.abort(channelId);
			return old;
		});
		if (previous) await this.#state.cancel(previous);
	}

	/** Only the authenticated writer route supplies this grant; no Planner/model tool can call it. */
	async activate(channelId: string, expectedRevision: number, owner: AgendaOwner): Promise<void> {
		await this.#state.exclusive(channelId, async () => {
			let record = await this.#state.required(channelId, expectedRevision);
			if (record.state === "active") return;
			if (!this.available() || this.#closed) {
				throw new AgendaError("unavailable", "Bounded public research is unavailable.");
			}
			let channel = await this.#state.options.storage.channels.get(channelId);
			if (!channel || channel.archivedAt || channel.parentChannelId) {
				throw new AgendaError(
					"unavailable",
					"Research agendas require an active top-level document.",
				);
			}
			let now = this.#state.clock();
			if (
				record.expiresAt && Date.parse(record.expiresAt) <= now.getTime()
				|| record.investigations >= AGENDA_LIMITS.maxInvestigations
				|| record.reservedSessions >= AGENDA_LIMITS.maxSessions
			) {
				throw new AgendaError(
					"conflict",
					"This delegation has ended. Save a new public scope to start another.",
				);
			}
			let credential = await this.#state.credential({ ...record, owner });
			if (!credential) {
				throw new AgendaError("unavailable", "The delegating Planner owner is unavailable.");
			}
			credential.release();
			await this.#state.store({
				...record,
				owner,
				state: "active",
				stopReason: undefined,
				assessment: undefined,
				generation: record.generation + 1,
				expiresAt: record.expiresAt
					?? new Date(now.getTime() + AGENDA_LIMITS.durationMs).toISOString(),
			});
		});
		this.wake(channelId);
	}

	async pause(channelId: string, expectedGeneration: number): Promise<void> {
		let paused = await this.#state.exclusive(channelId, async () => {
			let record = await this.#state.required(channelId);
			if (record.generation !== expectedGeneration) {
				throw new AgendaError("conflict", "The research scope changed. Refresh before pausing it.");
			}
			return this.#state.park(record, "human-paused");
		});
		await this.#state.cancel(paused);
	}

	/** Call before starting the job runner. Restart never borrows a replacement Planner owner. */
	async start(): Promise<void> {
		for (let channelId of await this.#state.options.storage.agendas.active()) {
			let paused = await this.#state.exclusive(channelId, async () => {
				let record = await this.#state.required(channelId);
				return this.#state.park(record, "restart");
			});
			await this.#state.cancel(paused);
		}
		if (!this.#timer) {
			this.#timer = setInterval(() => {
				void this.#state.options.storage.agendas.active().then(ids => {
					for (let id of ids) this.wake(id);
				}).catch(err => console.warn("[agenda] scheduling failed", err));
			}, 30_000);
			this.#timer.unref();
		}
	}

	stop(): void {
		this.#closed = true;
		if (this.#timer) clearInterval(this.#timer);
		this.#timer = undefined;
		for (let channelId of this.#state.controllers.keys()) this.#state.abort(channelId);
	}

	wake(channelId: string): void {
		if (!this.#closed) {
			void this.tick(channelId).catch(err => console.warn("[agenda] tick failed", err));
		}
	}

	tick(channelId: string): Promise<void> {
		return this.#closed ? Promise.resolve() : this.#coordinator.tick(channelId);
	}

	guardResearch<T>(channelId: string, workspaceId: string, operation: () => Promise<T>) {
		return guardResearch(this.#state, channelId, workspaceId, operation);
	}

	wrapResearchDefinition<Input extends JsonValue, Artifact extends JsonValue>(
		definition: JobDefinition<Input, Artifact>,
	) {
		return wrapResearchDefinition(this.#state, definition);
	}
}
