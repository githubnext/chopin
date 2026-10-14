import { digest } from "../research/start-identity";
import {
	AGENDA_LIMITS,
	assessmentSchema,
	MODEL_CREDITS,
	publicBrief,
	questionSchema,
	runnable,
	uniqueQuestions,
} from "./domain";
import type { Assessment } from "./domain";
import type { Agenda } from "@chopin/protocol";
import type { AgendaRecord, AgendaRun } from "../storage/agenda";
import type { AgendaState } from "./state";
import type { AgendaAssessmentInput, AgendaCredential } from "./assessor";

/** A tick performs at most one reservation and one external action. */
export class AgendaCoordinator {
	#running = new Set<string>();
	#modelOwners = new Set<string>();
	constructor(private state: AgendaState) {}

	async tick(channelId: string): Promise<void> {
		if (this.#running.has(channelId)) return;
		this.#running.add(channelId);
		try {
			let record = await this.state.options.storage.agendas.get(channelId);
			if (!record || record.state !== "active") return;
			let channel = await this.state.options.storage.channels.get(channelId);
			let reason: Agenda.StopReason | undefined =
				!channel || channel.archivedAt || channel.parentChannelId
					? "document-unavailable"
					: !this.state.options.available()
					? "capability-unavailable"
					: !runnable(record, this.state.clock())
					? "expired"
					: undefined;
			if (reason) {
				await this.#park(record, reason);
				return;
			}
			let owner = await this.state.credential(record);
			if (!owner) {
				await this.#park(record, "owner-unavailable");
				return;
			}
			owner.release();
			let running = record.questions.find(question => question.state === "running");
			if (running?.requestId) {
				await this.#settle(record, running.requestId);
				return;
			}
			if (record.assessment) {
				await this.#park(record, "assessment-failed", true);
				return;
			}
			if (record.nextRunAt && Date.parse(record.nextRunAt) > this.state.clock().getTime()) return;
			if (record.investigations >= AGENDA_LIMITS.maxInvestigations) {
				await this.#park(record, "investigations-complete");
				return;
			}
			if (record.questions.length && !record.questions.some(item => item.state === "queued")) {
				await this.#park(record, "nothing-useful");
				return;
			}
			await this.#assess(record);
		} finally {
			this.#running.delete(channelId);
		}
	}

	async #park(record: AgendaRecord, reason: Agenda.StopReason, failed = false) {
		let saved = await this.state.exclusive(record.channelId, async () => {
			let latest = await this.state.options.storage.agendas.get(record.channelId);
			if (!latest || latest.generation !== record.generation || latest.state !== "active") return;
			return this.state.park(latest, reason, failed);
		});
		if (saved) await this.state.cancel(saved);
	}

	async #settle(record: AgendaRecord, requestId: string) {
		let run = await this.state.options.storage.agendas.run(record.channelId, requestId);
		if (!run) {
			await this.#park(record, "research-failed", true);
			return;
		}
		if (Date.parse(run.deadline) <= this.state.clock().getTime()) {
			await this.#park(record, "research-timeout", true);
			return;
		}
		let workspaceId = await this.state.workspace(run);
		if (!workspaceId) {
			await this.#launch(record, run);
			return;
		}
		// An unlinked request reads as failed, but a persisted launch intent authorizes exact repair.
		let detail = await this.state.options.storage.research.get(record.channelId, workspaceId);
		if (detail && !detail.turns.find(turn => turn.kind === "initial")?.evidenceJobId) {
			await this.#launch(record, run);
			return;
		}
		try {
			await this.state.options.research.reconcile(record.channelId, workspaceId);
		} catch {
			await this.#park(record, "research-failed", true);
			return;
		}
		let request = await this.state.options.research.request(record.channelId, workspaceId);
		if (!request) {
			await this.#park(record, "research-failed", true);
			return;
		}
		if (
			request.state === "failed" || request.state === "cancelled" || request.state === "superseded"
		) {
			await this.#park(
				record,
				request.state === "failed" ? "research-failed" : "research-cancelled",
				true,
			);
			return;
		}
		if (request.stage !== "ready") return;
		await this.state.exclusive(record.channelId, async () => {
			let latest = await this.state.required(record.channelId);
			if (!runnable(latest, this.state.clock()) || latest.generation !== run.generation) return;
			await this.state.store({
				...latest,
				questions: latest.questions.map(question =>
					question.requestId === run.id
						? { ...question, state: "completed" }
						: question
				),
			});
		});
	}

	async #launch(record: AgendaRecord, run: AgendaRun) {
		try {
			await this.state.options.research.start({
				channelId: record.channelId,
				question: run.question,
				requestId: run.id,
				requestedBy: run.owner.userId,
				requestedByHandle: run.owner.userHandle,
			});
		} catch {
			await this.#park(record, "research-failed", true);
		}
	}

	async #material(
		record: AgendaRecord,
	): Promise<{ input: AgendaAssessmentInput; hashes: Map<string, string> }> {
		let document = await this.state.options.current(record.channelId);
		if (!document) throw new Error("agenda document unavailable");
		let hashes = new Map([[record.channelId, digest(document.source)]]);
		let evidence: string[] = [];
		for (let question of record.questions.filter(item => item.state === "completed")) {
			let run = question.requestId
				&& await this.state.options.storage.agendas.run(record.channelId, question.requestId);
			let workspaceId = run && await this.state.workspace(run);
			if (!workspaceId) continue;
			let detail = await this.state.options.storage.research.get(record.channelId, workspaceId);
			let childId = detail?.workspace.publishedChannelId;
			let child = childId && await this.state.options.current(childId);
			if (child && childId) {
				evidence.push(child.source.slice(0, 12_000));
				hashes.set(childId, digest(child.source));
			}
		}
		return {
			hashes,
			input: {
				scope: record.scope,
				questions: record.questions.filter(item => item.state === "queued").map(item => ({
					id: item.id,
					question: item.question,
					reason: item.reason,
					evidenceNeed: item.evidenceNeed,
					priority: item.priority,
				})),
				document: document.source.slice(0, 32_000),
				evidence,
			},
		};
	}

	async #assess(record: AgendaRecord) {
		let owner = record.owner?.userId;
		if (!owner || this.#modelOwners.has(owner) || this.#modelOwners.size >= 2) return;
		this.#modelOwners.add(owner);
		try {
			await this.#runAssessment(record);
		} finally {
			this.#modelOwners.delete(owner);
		}
	}

	async #runAssessment(record: AgendaRecord) {
		let reserved = await this.state.exclusive(record.channelId, async () => {
			let latest = await this.state.required(record.channelId);
			if (
				!runnable(latest, this.state.clock()) || latest.generation !== record.generation
				|| latest.assessment
			) return;
			if (
				latest.assessments >= AGENDA_LIMITS.maxAssessments
				|| latest.reservedAiCredits + MODEL_CREDITS > AGENDA_LIMITS.maxAiCredits
			) {
				await this.state.park(latest, "budget-exhausted");
				return;
			}
			return this.state.store({
				...latest,
				assessment: { id: this.state.id(), kind: latest.questions.length ? "assess" : "generate" },
				assessments: latest.assessments + 1,
				reservedAiCredits: latest.reservedAiCredits + MODEL_CREDITS,
			});
		});
		if (!reserved?.assessment) return;
		let tracked = this.state.track(record.channelId);
		let credential: AgendaCredential | undefined;
		try {
			credential = await this.state.credential(reserved);
			if (!credential) {
				await this.#park(reserved, "owner-unavailable");
				return;
			}
			let activeCredential = credential;
			let generated: Agenda.QuestionInput[] | undefined;
			let assessment: Assessment | undefined;
			let material: { input: AgendaAssessmentInput; hashes: Map<string, string> } | undefined;
			if (reserved.assessment.kind === "generate") {
				generated = uniqueQuestions((await this.state.options.assessor.generate(
					reserved.scope,
					credential,
					tracked.controller.signal,
				)).map(item => questionSchema.parse(item))).slice(0, AGENDA_LIMITS.maxQuestions);
			} else {
				material = await this.#material(reserved);
				assessment = assessmentSchema.parse(
					await this.state.options.assessor.assess(
						material.input,
						credential,
						tracked.controller.signal,
					),
				);
			}
			let run = await this.state.exclusive(record.channelId, async () => {
				let latest = await this.state.required(record.channelId);
				if (
					!runnable(latest, this.state.clock()) || latest.generation !== reserved.generation
					|| latest.assessment?.id !== reserved.assessment?.id || tracked.controller.signal.aborted
					|| !await activeCredential.authorize()
				) return;
				latest.assessment = undefined;
				if (material) {
					let fresh = true;
					for (let [channelId, hash] of material.hashes) {
						let current = await this.state.options.current(channelId);
						if (!current || digest(current.source) !== hash) fresh = false;
					}
					if (!fresh) {
						await this.state.store({
							...latest,
							nextRunAt: new Date(
								this.state.clock().getTime() + AGENDA_LIMITS.minIntervalMs,
							).toISOString(),
						});
						return;
					}
				}
				if (generated) {
					if (!generated.length) await this.state.park(latest, "nothing-useful");
					else {await this.state.store({
							...latest,
							questions: generated.map(item => ({ ...item, id: this.state.id(), state: "queued" })),
						});}
					return;
				}
				if (!assessment || assessment.decision !== "investigate") {
					await this.state.park(
						latest,
						assessment?.decision === "sufficient" ? "evidence-sufficient" : "nothing-useful",
					);
					return;
				}
				let question = latest.questions.find(item =>
					item.id === assessment.questionId && item.state === "queued"
				);
				if (!question) throw new Error("assessment selected an unknown question");
				if (latest.reservedAiCredits + 90 > AGENDA_LIMITS.maxAiCredits) {
					await this.state.park(latest, "budget-exhausted");
					return;
				}
				let now = this.state.clock();
				let run: AgendaRun = {
					id: this.state.id(),
					channelId: record.channelId,
					generation: latest.generation,
					questionId: question.id,
					question: publicBrief(latest.scope, question),
					owner: latest.owner!,
					createdAt: now.toISOString(),
					deadline: new Date(
						Math.min(now.getTime() + AGENDA_LIMITS.requestTimeoutMs, Date.parse(latest.expiresAt!)),
					).toISOString(),
				};
				await this.state.store({
					...latest,
					investigations: latest.investigations + 1,
					nextRunAt: new Date(now.getTime() + AGENDA_LIMITS.minIntervalMs).toISOString(),
					questions: latest.questions.map(item =>
						item.id === question.id
							? { ...item, state: "running", requestId: run.id }
							: item
					),
				}, run);
				return run;
			});
			if (run) await this.#launch(reserved, run);
		} catch {
			await this.#park(reserved, "assessment-failed", true);
		} finally {
			credential?.release();
			tracked.release();
		}
	}
}
