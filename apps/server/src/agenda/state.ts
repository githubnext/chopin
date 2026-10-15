import { digest } from "../research/start-identity";
import { AgendaError, sameOwner } from "./domain";
import type { Agenda } from "@chopin/protocol";
import type { AgendaOwner, AgendaRecord, AgendaRun } from "../storage/agenda";
import type { Lease } from "../storage/model";
import type { StorageAdapter } from "../storage/port";
import type { ResearchWorkspaceService } from "../research/service";
import type { AgendaAssessor, AgendaCredential } from "./assessor";

export type AgendaOptions = {
	storage: StorageAdapter;
	research: ResearchWorkspaceService;
	lease: () => Lease;
	/** Return false unless isolated workers and public research are available. */
	available: () => boolean;
	resolveOwner: (channelId: string, expected: AgendaOwner) => Promise<AgendaCredential | undefined>;
	current: (channelId: string) => Promise<{ source: string } | undefined>;
	assessor: AgendaAssessor;
	changed?: (channelId: string) => void;
	clock?: () => Date;
	id?: () => string;
};

/** One shared lock orders consent updates against launch, reservations, and publication. */
export class AgendaState {
	readonly controllers = new Map<string, Set<AbortController>>();
	readonly clock: () => Date;
	readonly id: () => string;
	#tails = new Map<string, Promise<void>>();
	constructor(readonly options: AgendaOptions) {
		this.clock = options.clock ?? (() => new Date());
		this.id = options.id ?? (() => crypto.randomUUID());
	}

	async exclusive<T>(channelId: string, run: () => Promise<T>): Promise<T> {
		let prior = this.#tails.get(channelId) ?? Promise.resolve();
		let result = prior.then(run);
		let tail = result.then(() => {}, () => {});
		this.#tails.set(channelId, tail);
		try {
			return await result;
		} finally {
			if (this.#tails.get(channelId) === tail) this.#tails.delete(channelId);
		}
	}

	async store(record: AgendaRecord, run?: AgendaRun): Promise<AgendaRecord> {
		let saved = await this.options.storage.agendas.save({
			record: { ...record, revision: record.revision + 1, updatedAt: this.clock().toISOString() },
			expectedRevision: record.revision,
			...(run ? { run } : {}),
			lease: this.options.lease(),
		});
		try {
			this.options.changed?.(record.channelId);
		} catch (error) {
			console.warn("[agenda] invalidation failed", error);
		}
		return saved;
	}

	async required(channelId: string, revision?: number): Promise<AgendaRecord> {
		let record = await this.options.storage.agendas.get(channelId);
		if (!record || revision !== undefined && record.revision !== revision) {
			throw new AgendaError("conflict", "The research agenda changed. Refresh and try again.");
		}
		return record;
	}

	async park(record: AgendaRecord, reason: Agenda.StopReason, failed = false) {
		let stopped = reason === "evidence-sufficient" || reason === "nothing-useful"
			|| reason === "budget-exhausted" || reason === "expired"
			|| reason === "investigations-complete";
		let saved = await this.store({
			...record,
			state: failed ? "failed" : stopped ? "stopped" : "paused",
			stopReason: reason,
			assessment: undefined,
			questions: record.questions.map(question =>
				question.state === "running"
					? { ...question, state: failed ? "failed" : "cancelled" }
					: question
			),
		});
		this.abort(record.channelId);
		return saved;
	}

	abort(channelId: string) {
		for (let controller of this.controllers.get(channelId) ?? []) controller.abort();
	}

	track(channelId: string) {
		let controller = new AbortController();
		let controllers = this.controllers.get(channelId) ?? new Set<AbortController>();
		controllers.add(controller);
		this.controllers.set(channelId, controllers);
		return {
			controller,
			release: () => {
				controllers.delete(controller);
				if (!controllers.size) this.controllers.delete(channelId);
			},
		};
	}

	async credential(record: AgendaRecord) {
		if (!record.owner) return undefined;
		let value: AgendaCredential | undefined;
		try {
			value = await this.options.resolveOwner(record.channelId, record.owner);
			if (value && sameOwner(value.owner, record.owner) && await value.authorize()) return value;
		} catch {
			// Authorization failures park work; they are never an implicit retry loop.
		}
		value?.release();
		return undefined;
	}

	async workspace(run: AgendaRun): Promise<string | undefined> {
		if (run.workspaceId) return run.workspaceId;
		let found = await this.options.storage.research.findByIdempotencyKey(
			run.channelId,
			`research-inline:${digest(run.id).slice(0, 48)}`,
		);
		return found?.workspace.id;
	}

	/** Consent is already durably revoked. Cancellation is a best-effort cleanup, never the fence. */
	async cancel(record: AgendaRecord) {
		for (let question of record.questions) {
			if (!question.requestId || question.state === "completed") continue;
			let run = await this.options.storage.agendas.run(record.channelId, question.requestId);
			let workspaceId = run && await this.workspace(run);
			if (workspaceId) {
				await this.options.research.cancelRequest({ channelId: record.channelId, workspaceId })
					.catch(() => {});
			}
		}
	}
}
