import { createHash } from "node:crypto";

import { jobDetail as serializedJobDetail } from "../jobs/browser";
import {
	parseResearchAnswerArtifact,
	parseResearchAnswerInput,
	parseResearchEvidenceArtifact,
} from "../jobs/research-workspace";
import { RESEARCH_REPOSITORY_WORKSPACE_LIMIT } from "../storage/model";
import * as Plan from "../plan/service";

import type { Job, Research } from "@chopin/protocol";
import type {
	ResearchAnswerInput,
	ResearchEvidence,
	ResearchReport,
} from "../jobs/research-workspace";
import type { JobDetail, JobService, JobView } from "../jobs/service";
import type { DocumentTarget } from "../plan/service";
import type {
	JsonValue,
	Lease,
	ResearchMessage,
	ResearchTurn,
	ResearchTurnKind,
	ResearchWorkspace,
	ResearchWorkspaceDetail,
	ResearchWorkspaceOrigin,
	ResearchWorkspaceRepositoryChannel,
} from "../storage/model";
import type { StorageAdapter } from "../storage/port";

export type ResearchWorkspaceErrorCode =
	| "active-turn"
	| "invalid-request"
	| "invalid-state"
	| "not-found"
	| "not-ready";

export class ResearchWorkspaceError extends Error {
	readonly code: ResearchWorkspaceErrorCode;

	constructor(code: ResearchWorkspaceErrorCode, message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "ResearchWorkspaceError";
		this.code = code;
	}
}

export type ResearchWorkspaceServiceOptions = {
	storage: StorageAdapter;
	jobs: JobService;
	lease: () => Lease;
	current: (channelId: string) => Promise<DocumentTarget | undefined>;
	publish: (
		channelId: string,
		workspaceId: string,
		revision: number,
	) => void | Promise<void>;
	clock?: () => Date;
	id?: () => string;
};

export type CreateResearchDraft = {
	channelId: string;
	question: string;
	origin: ResearchWorkspaceOrigin;
	createdBy: string;
	requestId?: string;
	originMessageId?: string;
};

export type CreateResearchDraftResult = {
	workspace: Research.WorkspaceSummary;
	repeated: boolean;
};

export type StartResearchRequest = {
	channelId: string;
	question: string;
	requestId: string;
	requestedBy: string;
	requestedByHandle?: string;
	beforeStart?: () => void | Promise<void>;
};

export type StartResearchRequestResult = {
	request: Research.RequestView;
	repeated: boolean;
};

export type ConfirmResearchDraft = {
	channelId: string;
	workspaceId: string;
	query: string;
	requestId: string;
	confirmedBy: string;
	confirmedByHandle?: string;
	beforeStart?: () => void | Promise<void>;
};

export type AppendResearchWorkspaceTurn = {
	channelId: string;
	workspaceId: string;
	kind: Exclude<ResearchTurnKind, "initial">;
	question: string;
	requestId: string;
	requestedBy: string;
	requestedByHandle?: string;
	beforeStart?: () => void | Promise<void>;
};

export type CancelResearchWorkspaceTurn = {
	channelId: string;
	workspaceId: string;
	turnId: string;
};

export type CancelResearchRequest = {
	channelId: string;
	workspaceId: string;
};

export type ResearchWorkspaceTurnView = Research.Turn & {
	readonly evidence?: Job.Detail;
	readonly answer?: Job.Detail;
};

export type ResearchWorkspaceView = Omit<Research.WorkspaceDetail, "turns"> & {
	readonly turns: readonly ResearchWorkspaceTurnView[];
};

export type ResearchWorkspaceParent = ResearchWorkspaceRepositoryChannel;

export type RepositoryResearchWorkspaceGroup = {
	channel: ResearchWorkspaceParent;
	workspaces: Research.WorkspaceSummary[];
};

export type RepositoryResearchWorkspaceList = {
	channels: RepositoryResearchWorkspaceGroup[];
	truncated: boolean;
};

const MAX_ID = 96;
const MAX_OPAQUE_ID = 255;
const MAX_ORIGIN_MESSAGE_ID = 128;
const MAX_QUESTION = 4_096;
const MAX_TITLE = 120;
const MAX_TURNS = 100;
const MAX_HISTORY = 100;
const MAX_HISTORY_TEXT = 4_096;
const MAX_HISTORY_BYTES = 256 * 1024;
const MAX_EVIDENCE_BATCHES = 32;
const MAX_EVIDENCE_FINDINGS = 64;
const MAX_EVIDENCE_SOURCES = 64;
const MAX_TARGET_SCAN = 1_000;
const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const HANDLE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const ACTIVE_JOB_STATES = new Set(["pending", "paused", "running"]);

function digest(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function fingerprint(kind: string, value: JsonValue): string {
	return digest(`${kind}\0${JSON.stringify(value)}`);
}

function safeId(value: unknown, field: string, maximum = MAX_ID): string {
	if (
		typeof value !== "string" || value.length < 1 || value.length > maximum
		|| !SAFE_ID.test(value)
	) {
		throw new ResearchWorkspaceError("invalid-request", `${field} is invalid.`);
	}
	return value;
}

function requestId(value: unknown): string {
	if (typeof value !== "string" || !REQUEST_ID.test(value)) {
		throw new ResearchWorkspaceError("invalid-request", "Request id is invalid.");
	}
	return value;
}

function handle(value: string | undefined): string | undefined {
	if (value === undefined) return undefined;
	if (!HANDLE.test(value)) {
		throw new ResearchWorkspaceError("invalid-request", "Member handle is invalid.");
	}
	return value;
}

function hasControlCharacter(value: string): boolean {
	for (let index = 0; index < value.length; index++) {
		let code = value.charCodeAt(index);
		if (code <= 8 || code === 11 || code === 12 || code >= 14 && code <= 31 || code === 127) {
			return true;
		}
	}
	return false;
}

/** GitHub node IDs are opaque and may use padded Base64 characters such as `=`. */
function opaqueId(value: unknown, field: string): string {
	if (
		typeof value !== "string" || value.length < 1 || value.length > MAX_OPAQUE_ID
		|| hasControlCharacter(value)
	) throw new ResearchWorkspaceError("invalid-request", `${field} is invalid.`);
	return value;
}

export function normalizeResearchPrompt(value: unknown): string {
	if (typeof value !== "string") {
		throw new ResearchWorkspaceError("invalid-request", "Research question is invalid.");
	}
	let normalized = value.trim().replace(/\s+/g, " ");
	if (!normalized || normalized.length > MAX_QUESTION || hasControlCharacter(normalized)) {
		throw new ResearchWorkspaceError(
			"invalid-request",
			`Research question must contain between 1 and ${MAX_QUESTION} characters.`,
		);
	}
	return normalized;
}

function researchBrief(value: unknown): string {
	if (
		typeof value !== "string" || !value.trim() || value.length > MAX_QUESTION
		|| hasControlCharacter(value)
	) {
		throw new ResearchWorkspaceError(
			"invalid-request",
			`Research question must contain between 1 and ${MAX_QUESTION} characters.`,
		);
	}
	return value;
}

export function researchWorkspaceTitle(question: string): string {
	let points = [...normalizeResearchPrompt(question)];
	return points.length <= MAX_TITLE
		? points.join("")
		: `${points.slice(0, MAX_TITLE - 3).join("").trimEnd()}...`;
}

function suffixedResearchTitle(title: string, suffix: string): string {
	let points = [...title];
	let suffixPoints = [...suffix];
	return `${points.slice(0, MAX_TITLE - suffixPoints.length).join("").trimEnd()}${suffix}`;
}

function researchReportText(value: string): string {
	return value.trim().replace(/\s+/g, " ").replace(/[\\`*_[\]{}<>]/g, "\\$&");
}

function researchReportSource(
	report: ResearchReport,
	sources: ResearchEvidence["sources"],
): string {
	let blocks = [`# ${researchReportText(report.title)}`, researchReportText(report.summary)];
	if (report.findings.length > 0) {
		blocks.push("## Findings");
		for (let finding of report.findings) {
			let sourceText = finding.sourceUrls.length > 0
				? ` Sources: ${finding.sourceUrls.join(", ")}`
				: "";
			blocks.push(`- ${researchReportText(finding.text)}${sourceText}`);
		}
	}
	if (report.caveats.length > 0) {
		blocks.push("## Caveats");
		for (let caveat of report.caveats) blocks.push(`- ${researchReportText(caveat)}`);
	}
	if (sources.length > 0) {
		blocks.push("## Sources");
		for (let source of sources) {
			blocks.push(`- ${researchReportText(source.title)}: ${source.url}`);
		}
	}
	return `${blocks.join("\n\n")}\n`;
}

function summary(value: ResearchWorkspace): Research.WorkspaceSummary {
	return {
		id: value.id,
		channelId: value.channelId,
		title: value.title,
		proposedQuestion: value.proposedQuestion,
		...(value.confirmedQuery !== undefined ? { confirmedQuery: value.confirmedQuery } : {}),
		origin: value.origin,
		...(value.originMessageId !== undefined ? { originMessageId: value.originMessageId } : {}),
		createdBy: value.createdBy,
		...(value.confirmedBy !== undefined ? { confirmedBy: value.confirmedBy } : {}),
		revision: value.revision,
		createdAt: value.createdAt.toISOString(),
		updatedAt: value.updatedAt.toISOString(),
	};
}

function message(value: ResearchMessage): Research.Message {
	return {
		id: value.id,
		workspaceId: value.workspaceId,
		sequence: value.sequence,
		...(value.turnId !== undefined ? { turnId: value.turnId } : {}),
		authorKind: value.authorKind,
		...(value.userId !== undefined ? { userId: value.userId } : {}),
		...(value.userHandle !== undefined ? { userHandle: value.userHandle } : {}),
		text: value.text,
		...(value.sourceJobId !== undefined ? { sourceJobId: value.sourceJobId } : {}),
		createdAt: value.createdAt.toISOString(),
	};
}

function turn(value: ResearchTurn): Research.Turn {
	return {
		id: value.id,
		workspaceId: value.workspaceId,
		ordinal: value.ordinal,
		kind: value.kind,
		question: value.question,
		requestedBy: value.requestedBy,
		...(value.evidenceJobId !== undefined ? { evidenceJobId: value.evidenceJobId } : {}),
		...(value.answerJobId !== undefined ? { answerJobId: value.answerJobId } : {}),
		createdAt: value.createdAt.toISOString(),
		updatedAt: value.updatedAt.toISOString(),
	};
}

function boundedHistoryText(value: string, maximumBytes: number): string {
	let output = "";
	let bytes = 0;
	let characters = 0;
	for (let point of value.trim()) {
		let size = Buffer.byteLength(point);
		if (characters >= MAX_HISTORY_TEXT || bytes + size > maximumBytes) break;
		output += point;
		bytes += size;
		characters++;
	}
	return output.trim();
}

export function boundedResearchEvidence(evidence: ResearchEvidence[]): ResearchEvidence[] {
	if (evidence.length <= 1) return evidence.map(batch => structuredClone(batch));
	let selected = [evidence[0]!, ...evidence.slice(1).toReversed()];
	let bounded: ResearchEvidence[] = [];
	let findings = 0;
	let sources = 0;
	for (let batch of selected) {
		if (bounded.length >= MAX_EVIDENCE_BATCHES) break;
		let remainingFindings = MAX_EVIDENCE_FINDINGS - findings;
		let remainingSources = MAX_EVIDENCE_SOURCES - sources;
		if (remainingFindings <= 0 && remainingSources <= 0) break;
		let nextSources = batch.sources.slice(0, Math.max(0, remainingSources))
			.map(source => ({ ...source }));
		let nextFindings = nextSources.length > 0
			? batch.findings.slice(0, Math.max(0, remainingFindings))
			: [];
		if (nextFindings.length === 0 && nextSources.length === 0) continue;
		bounded.push({ findings: nextFindings, sources: nextSources });
		findings += nextFindings.length;
		sources += nextSources.length;
	}
	return bounded;
}

/** Coordinates durable workspace state with independently durable background jobs. */
export class ResearchWorkspaceService {
	#storage: StorageAdapter;
	#jobs: JobService;
	#lease: () => Lease;
	#current: (channelId: string) => Promise<DocumentTarget | undefined>;
	#publish: ResearchWorkspaceServiceOptions["publish"];
	#clock: () => Date;
	#id: () => string;
	#tails = new Map<string, Promise<void>>();

	constructor(options: ResearchWorkspaceServiceOptions) {
		this.#storage = options.storage;
		this.#jobs = options.jobs;
		this.#lease = options.lease;
		this.#current = options.current;
		this.#publish = options.publish;
		this.#clock = options.clock ?? (() => new Date());
		this.#id = options.id ?? (() => crypto.randomUUID());
	}

	async start(input: StartResearchRequest): Promise<StartResearchRequestResult> {
		let channelId = safeId(input.channelId, "Channel id");
		let question = researchBrief(input.question);
		let durableRequestId = requestId(input.requestId);
		let requestedBy = opaqueId(input.requestedBy, "Requesting member id");
		let requestedByHandle = handle(input.requestedByHandle);
		this.#requireDefinition("research-evidence");
		this.#requireDefinition("research-answer");
		await input.beforeStart?.();
		let requestFingerprint = fingerprint("research-inline", {
			channelId,
			question,
			requestedBy,
			requestedByHandle: requestedByHandle ?? null,
		});
		let stored = await this.#storage.research.start({
			id: this.#newId("Workspace id"),
			channelId,
			title: researchWorkspaceTitle(question),
			question,
			createdBy: requestedBy,
			...(requestedByHandle ? { createdByHandle: requestedByHandle } : {}),
			turnId: this.#newId("Turn id"),
			messageId: this.#newId("Message id"),
			requestId: durableRequestId,
			idempotencyKey: `research-inline:${digest(durableRequestId).slice(0, 48)}`,
			fingerprint: requestFingerprint,
			now: this.#time(),
			lease: this.#lease(),
		});
		if (!stored.repeated) await this.#published(stored.workspace);
		await this.#ensureEvidence(stored.workspace, stored.turn);
		let request = await this.request(channelId, stored.workspace.id);
		if (!request) throw new ResearchWorkspaceError("not-found", "Research request not found.");
		return { request, repeated: stored.repeated };
	}

	async createDraft(input: CreateResearchDraft): Promise<CreateResearchDraftResult> {
		let channelId = safeId(input.channelId, "Channel id");
		let createdBy = opaqueId(input.createdBy, "Creating member id");
		let proposedQuestion = normalizeResearchPrompt(input.question);
		let scope: string;
		let originMessageId: string | undefined;
		if (input.origin === "sidebar") {
			if (input.originMessageId !== undefined) {
				throw new ResearchWorkspaceError(
					"invalid-request",
					"Sidebar drafts cannot have an origin message.",
				);
			}
			scope = requestId(input.requestId);
		} else if (input.origin === "planner") {
			if (input.requestId !== undefined) requestId(input.requestId);
			originMessageId = safeId(
				input.originMessageId,
				"Origin message id",
				MAX_ORIGIN_MESSAGE_ID,
			);
			scope = originMessageId;
		} else {
			throw new ResearchWorkspaceError("invalid-request", "Research draft origin is invalid.");
		}

		let stored = await this.#storage.research.create({
			id: this.#newId("Workspace id"),
			channelId,
			title: researchWorkspaceTitle(proposedQuestion),
			proposedQuestion,
			origin: input.origin,
			...(originMessageId ? { originMessageId } : {}),
			createdBy,
			idempotencyKey: `research-draft:${input.origin}:${digest(scope).slice(0, 48)}`,
			fingerprint: fingerprint("research-draft", {
				channelId,
				proposedQuestion,
				origin: input.origin,
				originMessageId: originMessageId ?? null,
				createdBy,
			}),
			now: this.#time(),
			lease: this.#lease(),
		});
		if (!stored.repeated) await this.#published(stored.workspace);
		return { workspace: summary(stored.workspace), repeated: stored.repeated };
	}

	async confirm(input: ConfirmResearchDraft): Promise<ResearchWorkspaceView> {
		let channelId = safeId(input.channelId, "Channel id");
		let workspaceId = safeId(input.workspaceId, "Workspace id");
		let query = normalizeResearchPrompt(input.query);
		let durableRequestId = requestId(input.requestId);
		let confirmedBy = opaqueId(input.confirmedBy, "Confirming member id");
		let confirmedByHandle = handle(input.confirmedByHandle);
		let requestFingerprint = fingerprint("research-confirm", {
			workspaceId,
			query,
			confirmedBy,
			confirmedByHandle: confirmedByHandle ?? null,
		});

		return this.#exclusive(channelId, workspaceId, async () => {
			let current = await this.#storage.research.get(channelId, workspaceId);
			if (!current) {
				throw new ResearchWorkspaceError("not-found", "Research workspace not found.");
			}
			let repeated = current.turns.some(value => value.requestId === durableRequestId);
			if (!repeated) {
				if (current.workspace.confirmedQuery !== undefined) {
					throw new ResearchWorkspaceError("not-ready", "Research workspace is already confirmed.");
				}
				this.#requireDefinition("research-evidence");
				this.#requireDefinition("research-answer");
				await input.beforeStart?.();
			}
			let stored = await this.#storage.research.confirm({
				channelId,
				workspaceId,
				turnId: this.#newId("Turn id"),
				messageId: this.#newId("Message id"),
				requestId: durableRequestId,
				fingerprint: requestFingerprint,
				confirmedQuery: query,
				confirmedBy,
				...(confirmedByHandle ? { confirmedByHandle } : {}),
				now: this.#time(),
				lease: this.#lease(),
			});
			if (!stored.repeated) await this.#published(stored.workspace);
			if (this.#hasDefinition("research-evidence")) {
				await this.#ensureEvidence(stored.workspace, stored.turn);
			}
			return this.#requiredView(channelId, workspaceId);
		});
	}

	async appendTurn(input: AppendResearchWorkspaceTurn): Promise<ResearchWorkspaceView> {
		let channelId = safeId(input.channelId, "Channel id");
		let workspaceId = safeId(input.workspaceId, "Workspace id");
		if (input.kind !== "follow-up" && input.kind !== "search-more") {
			throw new ResearchWorkspaceError("invalid-request", "Research turn kind is invalid.");
		}
		let question = normalizeResearchPrompt(input.question);
		let durableRequestId = requestId(input.requestId);
		let requestedBy = opaqueId(input.requestedBy, "Requesting member id");
		let requestedByHandle = handle(input.requestedByHandle);
		let requestFingerprint = fingerprint("research-turn", {
			workspaceId,
			kind: input.kind,
			question,
			requestedBy,
			requestedByHandle: requestedByHandle ?? null,
		});

		return this.#exclusive(channelId, workspaceId, async () => {
			let detail = await this.#reconciled(channelId, workspaceId);
			if (!detail) throw new ResearchWorkspaceError("not-found", "Research workspace not found.");
			let repeated = detail.turns.some(value => value.requestId === durableRequestId);
			if (!repeated) {
				if (detail.workspace.confirmedQuery === undefined) {
					throw new ResearchWorkspaceError("not-ready", "Research workspace is not confirmed.");
				}
				if (!await this.#initialReport(detail)) {
					throw new ResearchWorkspaceError(
						"not-ready",
						"The initial research report is not ready.",
					);
				}
				if (detail.turns.length >= MAX_TURNS) {
					throw new ResearchWorkspaceError("invalid-state", "Research workspace is full.");
				}
				if (await this.#hasActiveTurn(detail)) {
					throw new ResearchWorkspaceError(
						"active-turn",
						"Another research turn is still active.",
					);
				}
				if (input.kind === "search-more") this.#requireDefinition("research-evidence");
				this.#requireDefinition("research-answer");
				await input.beforeStart?.();
			}

			let stored = await this.#storage.research.appendTurn({
				channelId,
				workspaceId,
				turnId: this.#newId("Turn id"),
				messageId: this.#newId("Message id"),
				kind: input.kind,
				requestId: durableRequestId,
				fingerprint: requestFingerprint,
				question,
				requestedBy,
				...(requestedByHandle ? { requestedByHandle } : {}),
				now: this.#time(),
				lease: this.#lease(),
			});
			if (!stored.repeated) await this.#published(stored.workspace);
			if (stored.turn.kind === "search-more") {
				if (this.#hasDefinition("research-evidence")) {
					await this.#ensureEvidence(stored.workspace, stored.turn);
				}
			} else if (this.#hasDefinition("research-answer")) {
				let reloaded = await this.#stored(channelId, workspaceId);
				await this.#ensureAnswer(reloaded, stored.turn);
			}
			return this.#requiredView(channelId, workspaceId);
		});
	}

	async get(channelId: string, workspaceId: string): Promise<ResearchWorkspaceView | undefined> {
		if (!this.#validId(channelId) || !this.#validId(workspaceId)) return undefined;
		return this.#exclusive(channelId, workspaceId, async () => {
			let detail = await this.#reconciled(channelId, workspaceId);
			return detail && this.#browserView(detail);
		});
	}

	async request(channelId: string, workspaceId: string): Promise<Research.RequestView | undefined> {
		if (!this.#validId(channelId) || !this.#validId(workspaceId)) return undefined;
		return this.#exclusive(channelId, workspaceId, async () => {
			let detail = await this.#reconciled(channelId, workspaceId);
			return detail && this.#requestView(detail);
		});
	}

	read(channelId: string, workspaceId: string): Promise<ResearchWorkspaceView | undefined> {
		return this.get(channelId, workspaceId);
	}

	async list(channelId: string, limit = 100): Promise<Research.WorkspaceSummary[]> {
		safeId(channelId, "Channel id");
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
			throw new ResearchWorkspaceError("invalid-request", "Research workspace limit is invalid.");
		}
		return (await this.#storage.research.list(channelId, limit)).map(summary);
	}

	async listRepository(
		repositoryId: string,
		limit = RESEARCH_REPOSITORY_WORKSPACE_LIMIT,
		includeArchived = false,
	): Promise<RepositoryResearchWorkspaceList> {
		opaqueId(repositoryId, "Repository id");
		if (
			!Number.isSafeInteger(limit) || limit < 1
			|| limit > RESEARCH_REPOSITORY_WORKSPACE_LIMIT
		) {
			throw new ResearchWorkspaceError("invalid-request", "Repository listing limit is invalid.");
		}
		let listed = await this.#storage.research.listRepository(
			repositoryId,
			limit,
			includeArchived,
		);
		return {
			channels: listed.channels.map(group => ({
				channel: group.channel,
				workspaces: group.workspaces.map(summary),
			})),
			truncated: listed.truncated,
		};
	}

	async cancelTurn(input: CancelResearchWorkspaceTurn): Promise<ResearchWorkspaceView> {
		let channelId = safeId(input.channelId, "Channel id");
		let workspaceId = safeId(input.workspaceId, "Workspace id");
		let turnId = safeId(input.turnId, "Turn id");
		return this.#exclusive(channelId, workspaceId, async () => {
			let detail = await this.#reconciled(channelId, workspaceId);
			if (!detail) throw new ResearchWorkspaceError("not-found", "Research workspace not found.");
			let found = detail.turns.find(value => value.id === turnId);
			if (!found) throw new ResearchWorkspaceError("not-found", "Research turn not found.");
			await this.#cancelActiveTurn(detail, found);
			return this.#requiredView(channelId, workspaceId);
		});
	}

	async cancelRequest(input: CancelResearchRequest): Promise<Research.RequestView> {
		let channelId = safeId(input.channelId, "Channel id");
		let workspaceId = safeId(input.workspaceId, "Workspace id");
		return this.#exclusive(channelId, workspaceId, async () => {
			let detail = await this.#reconciled(channelId, workspaceId);
			if (!detail) throw new ResearchWorkspaceError("not-found", "Research request not found.");
			let initial = detail.turns.find(value => value.kind === "initial");
			if (!initial) {
				throw new ResearchWorkspaceError("invalid-state", "Research request has no initial work.");
			}
			await this.#cancelActiveTurn(detail, initial);
			let refreshed = await this.#reconciled(channelId, workspaceId);
			if (!refreshed) throw new ResearchWorkspaceError("not-found", "Research request not found.");
			return this.#requestView(refreshed);
		});
	}

	async #cancelActiveTurn(
		detail: ResearchWorkspaceDetail,
		found: ResearchTurn,
	): Promise<void> {
		let candidates = [
			...(found.answerJobId ? [{ id: found.answerJobId, role: "answer" as const }] : []),
			...(found.evidenceJobId
				? [{ id: found.evidenceJobId, role: "evidence" as const }]
				: []),
		];
		let active: JobDetail | undefined;
		let alreadyCancelled = false;
		for (let candidate of candidates) {
			let current = await this.#jobs.get(detail.workspace.channelId, candidate.id);
			if (current) this.#assertLinkedJob(current, detail.workspace, found, candidate.role);
			if (current?.job.state === "cancelled") alreadyCancelled = true;
			if (current && ACTIVE_JOB_STATES.has(current.job.state)) {
				active = current;
				break;
			}
		}
		if (!active) {
			if (alreadyCancelled) return;
			throw new ResearchWorkspaceError("not-ready", "Research turn is not cancellable.");
		}
		await this.#jobs.cancel({ channelId: detail.workspace.channelId, jobId: active.job.id });
		await this.#published(detail.workspace);
	}

	async jobChanged(job: JobView): Promise<void> {
		if (
			job.state !== "completed"
			|| (job.type !== "research-evidence" && job.type !== "research-answer")
			|| !this.#validId(job.channelId)
		) return;
		let linked = await this.#storage.research.findTurnByJob(job.channelId, job.id);
		if (!linked) return;
		await this.#exclusive(job.channelId, linked.workspaceId, async () => {
			await this.#reconciled(job.channelId, linked.workspaceId);
		});
	}

	async #requiredView(channelId: string, workspaceId: string): Promise<ResearchWorkspaceView> {
		let detail = await this.#reconciled(channelId, workspaceId);
		if (!detail) throw new ResearchWorkspaceError("not-found", "Research workspace not found.");
		return this.#browserView(detail);
	}

	async #reconciled(
		channelId: string,
		workspaceId: string,
	): Promise<ResearchWorkspaceDetail | undefined> {
		let maximum = MAX_TURNS * 3 + 1;
		for (let pass = 0; pass < maximum; pass++) {
			let detail = await this.#storage.research.get(channelId, workspaceId);
			if (!detail) return undefined;
			if (detail.turns.length > MAX_TURNS) {
				throw new ResearchWorkspaceError("invalid-state", "Research workspace is too large.");
			}
			let changed = false;
			for (let savedTurn of detail.turns) {
				if (
					(savedTurn.kind === "initial" || savedTurn.kind === "search-more")
					&& savedTurn.evidenceJobId === undefined
					&& this.#hasDefinition("research-evidence")
				) {
					changed = await this.#ensureEvidence(detail.workspace, savedTurn);
					if (changed) break;
				}
				if (savedTurn.evidenceJobId && savedTurn.answerJobId === undefined) {
					let evidence = await this.#jobs.get(channelId, savedTurn.evidenceJobId);
					if (evidence?.job.state === "completed" && this.#hasDefinition("research-answer")) {
						changed = await this.#ensureAnswer(detail, savedTurn);
						if (changed) break;
					}
				}
				if (
					savedTurn.kind === "follow-up" && savedTurn.answerJobId === undefined
					&& this.#hasDefinition("research-answer")
				) {
					if (await this.#initialReport(detail)) {
						changed = await this.#ensureAnswer(detail, savedTurn);
						if (changed) break;
					}
				}
				if (savedTurn.answerJobId) {
					let answer = await this.#jobs.get(channelId, savedTurn.answerJobId);
					if (
						savedTurn.kind === "initial" && answer?.job.state === "completed"
						&& detail.workspace.publishedChannelId === undefined
					) {
						changed = await this.#publishInitialReport(detail, savedTurn, answer);
						if (changed) break;
					}
					let alreadyAppended = detail.messages.some(value =>
						value.authorKind === "agent"
						&& value.turnId === savedTurn.id
						&& value.sourceJobId === savedTurn.answerJobId
					);
					if (answer?.job.state === "completed" && !alreadyAppended) {
						changed = await this.#appendCompletedAnswer(detail, savedTurn, answer);
						if (changed) break;
					}
				}
			}
			if (!changed) return detail;
		}
		throw new ResearchWorkspaceError("invalid-state", "Research reconciliation did not converge.");
	}

	async #publishInitialReport(
		detail: ResearchWorkspaceDetail,
		savedTurn: ResearchTurn,
		job: JobDetail,
	): Promise<boolean> {
		let artifact = this.#answerArtifact(job, detail.workspace, savedTurn);
		if (artifact.kind !== "initial") {
			throw new ResearchWorkspaceError("invalid-state", "Initial research report is invalid.");
		}
		let initial = await Plan.initial(researchReportSource(artifact.report, artifact.sources));
		let published = await this.#storage.research.publishInitialReport({
			channelId: detail.workspace.channelId,
			workspaceId: detail.workspace.id,
			answerJobId: job.job.id,
			title: await this.#publicationTitle(
				detail.workspace.channelId,
				researchWorkspaceTitle(artifact.report.title),
			),
			initial,
			now: this.#time(),
			lease: this.#lease(),
		});
		if (!published.repeated) await this.#published(published.workspace);
		return true;
	}

	async #publicationTitle(channelId: string, requested: string): Promise<string> {
		let parent = await this.#storage.channels.get(channelId);
		if (!parent) {
			throw new ResearchWorkspaceError("not-ready", "The parent document is unavailable.");
		}
		let titles = new Set<string>();
		let after: { updatedAt: Date; id: string } | undefined;
		do {
			let page = await this.#storage.channels.list(
				parent.repositoryId,
				100,
				after,
				undefined,
				true,
			);
			for (let channel of page.channels) titles.add(channel.title.toLowerCase());
			after = page.next;
		} while (after);
		if (!titles.has(requested.toLowerCase())) return requested;
		for (let index = 2; index <= titles.size + 2; index++) {
			let candidate = suffixedResearchTitle(requested, ` (${index})`);
			if (!titles.has(candidate.toLowerCase())) return candidate;
		}
		throw new ResearchWorkspaceError("invalid-state", "A research child title is unavailable.");
	}

	async #ensureEvidence(workspace: ResearchWorkspace, savedTurn: ResearchTurn): Promise<boolean> {
		if (savedTurn.evidenceJobId !== undefined) return false;
		this.#requireDefinition("research-evidence");
		let targetKey = this.#target(workspace.id, savedTurn.id, "evidence");
		let existing = await this.#targetJob(workspace.channelId, "research-evidence", targetKey);
		let job = existing ?? (await this.#jobs.enqueueUser({
			channelId: workspace.channelId,
			type: "research-evidence",
			targetKey,
			idempotencyKey: `research-evidence:${savedTurn.id}`,
			input: {
				workspaceId: workspace.id,
				turnId: savedTurn.id,
				query: savedTurn.question,
			},
		})).job;
		let linked = await this.#storage.research.linkJob({
			channelId: workspace.channelId,
			workspaceId: workspace.id,
			turnId: savedTurn.id,
			role: "evidence",
			jobId: job.id,
			now: this.#time(),
			lease: this.#lease(),
		});
		if (!linked.repeated) await this.#published(linked.workspace);
		return true;
	}

	async #ensureAnswer(detail: ResearchWorkspaceDetail, savedTurn: ResearchTurn): Promise<boolean> {
		if (savedTurn.answerJobId !== undefined) return false;
		this.#requireDefinition("research-answer");
		let workspace = detail.workspace;
		let targetKey = this.#target(workspace.id, savedTurn.id, "answer");
		let existing = await this.#targetJob(workspace.channelId, "research-answer", targetKey);
		let job: JobView;
		if (existing) job = existing;
		else {
			let input = await this.#answerInput(detail, savedTurn);
			let enqueued = await this.#jobs.enqueueUser({
				channelId: workspace.channelId,
				type: "research-answer",
				targetKey,
				idempotencyKey: `research-answer:${savedTurn.id}`,
				input: input as JsonValue,
			});
			job = enqueued.job;
		}
		let linked = await this.#storage.research.linkJob({
			channelId: workspace.channelId,
			workspaceId: workspace.id,
			turnId: savedTurn.id,
			role: "answer",
			jobId: job.id,
			now: this.#time(),
			lease: this.#lease(),
		});
		if (!linked.repeated) await this.#published(linked.workspace);
		return true;
	}

	async #answerInput(
		detail: ResearchWorkspaceDetail,
		savedTurn: ResearchTurn,
	): Promise<ResearchAnswerInput> {
		let document = await this.#current(detail.workspace.channelId);
		if (!document || document.channelId !== detail.workspace.channelId) {
			throw new ResearchWorkspaceError("not-ready", "The parent document is not available.");
		}
		let evidence = await this.#committedEvidence(detail);
		let history = this.#history(detail.messages);
		let base = {
			workspaceId: detail.workspace.id,
			turnId: savedTurn.id,
			question: savedTurn.question,
			document: {
				source: document.source,
				revision: document.revision,
				sourceHash: document.sourceHash,
			},
			evidence,
			history,
		};
		let input: JsonValue;
		if (savedTurn.kind === "initial") input = { ...base, kind: "initial" } as JsonValue;
		else {
			let originalReport = await this.#initialReport(detail);
			if (!originalReport) {
				throw new ResearchWorkspaceError("not-ready", "The initial research report is not ready.");
			}
			input = {
				...base,
				kind: savedTurn.kind,
				originalReport: structuredClone(originalReport),
			} as JsonValue;
		}
		try {
			return parseResearchAnswerInput(input);
		} catch (err) {
			throw new ResearchWorkspaceError(
				"invalid-state",
				"Research answer material is invalid.",
				{ cause: err },
			);
		}
	}

	async #committedEvidence(detail: ResearchWorkspaceDetail): Promise<ResearchEvidence[]> {
		let evidence: ResearchEvidence[] = [];
		for (let savedTurn of detail.turns) {
			if (!savedTurn.evidenceJobId) continue;
			let job = await this.#jobs.get(detail.workspace.channelId, savedTurn.evidenceJobId);
			if (!job || job.job.type !== "research-evidence") {
				throw new ResearchWorkspaceError("invalid-state", "Linked research evidence is missing.");
			}
			if (job.job.state !== "completed") continue;
			let artifact = this.#evidenceArtifact(job, detail.workspace, savedTurn);
			evidence.push({
				findings: [...artifact.findings],
				sources: artifact.sources.map(value => ({ ...value })),
			});
		}
		return boundedResearchEvidence(evidence);
	}

	async #initialReport(detail: ResearchWorkspaceDetail): Promise<ResearchReport | undefined> {
		let initial = detail.turns.find(value => value.kind === "initial");
		if (!initial?.answerJobId) return undefined;
		let job = await this.#jobs.get(detail.workspace.channelId, initial.answerJobId);
		if (!job || job.job.type !== "research-answer" || job.job.state !== "completed") {
			return undefined;
		}
		let artifact = this.#answerArtifact(job, detail.workspace, initial);
		return artifact.kind === "initial" ? structuredClone(artifact.report) : undefined;
	}

	#history(messages: ResearchMessage[]): Array<{ author: "member" | "agent"; text: string }> {
		let candidates = messages.filter(
			(value): value is ResearchMessage & { authorKind: "member" | "agent" } =>
				value.authorKind === "member" || value.authorKind === "agent",
		).slice(-MAX_HISTORY);
		let history: Array<{ author: "member" | "agent"; text: string }> = [];
		let remaining = MAX_HISTORY_BYTES;
		for (let value of candidates.toReversed()) {
			let text = boundedHistoryText(value.text, remaining);
			if (!text) break;
			history.push({ author: value.authorKind, text });
			remaining -= Buffer.byteLength(text);
			if (remaining <= 0) break;
		}
		return history.toReversed();
	}

	async #appendCompletedAnswer(
		detail: ResearchWorkspaceDetail,
		savedTurn: ResearchTurn,
		job: JobDetail,
	): Promise<boolean> {
		let artifact = this.#answerArtifact(job, detail.workspace, savedTurn);
		let text = artifact.kind === "initial" ? artifact.report.summary : artifact.answer.text;
		let stored = await this.#storage.research.appendAgentMessage({
			channelId: detail.workspace.channelId,
			workspaceId: detail.workspace.id,
			id: `research-answer-${digest(job.job.id).slice(0, 32)}`,
			turnId: savedTurn.id,
			text,
			sourceJobId: job.job.id,
			now: this.#time(),
			lease: this.#lease(),
		});
		if (!stored.repeated) await this.#published(stored.workspace);
		return true;
	}

	#evidenceArtifact(job: JobDetail, workspace: ResearchWorkspace, savedTurn: ResearchTurn) {
		this.#assertLinkedJob(job, workspace, savedTurn, "evidence");
		if (!job.artifact || job.job.targetGeneration !== job.target.generation) {
			throw new ResearchWorkspaceError("invalid-state", "Research evidence artifact is missing.");
		}
		try {
			let artifact = parseResearchEvidenceArtifact(job.artifact.value);
			if (
				artifact.workspaceId !== workspace.id || artifact.turnId !== savedTurn.id
				|| artifact.query !== savedTurn.question
			) throw new Error("artifact target does not match");
			return artifact;
		} catch (err) {
			throw new ResearchWorkspaceError(
				"invalid-state",
				"Research evidence artifact is invalid.",
				{ cause: err },
			);
		}
	}

	#answerArtifact(job: JobDetail, workspace: ResearchWorkspace, savedTurn: ResearchTurn) {
		this.#assertLinkedJob(job, workspace, savedTurn, "answer");
		if (!job.artifact || job.job.targetGeneration !== job.target.generation) {
			throw new ResearchWorkspaceError("invalid-state", "Research answer artifact is missing.");
		}
		try {
			let artifact = parseResearchAnswerArtifact(job.artifact.value);
			if (
				artifact.workspaceId !== workspace.id || artifact.turnId !== savedTurn.id
				|| artifact.kind !== savedTurn.kind
			) throw new Error("artifact target does not match");
			return artifact;
		} catch (err) {
			throw new ResearchWorkspaceError(
				"invalid-state",
				"Research answer artifact is invalid.",
				{ cause: err },
			);
		}
	}

	async #hasActiveTurn(detail: ResearchWorkspaceDetail): Promise<boolean> {
		for (let savedTurn of detail.turns) {
			if (
				detail.messages.some(value => value.authorKind === "agent" && value.turnId === savedTurn.id)
			) {
				continue;
			}
			let jobId = savedTurn.answerJobId ?? savedTurn.evidenceJobId;
			if (!jobId) return true;
			let job = await this.#jobs.get(detail.workspace.channelId, jobId);
			if (!job) {
				throw new ResearchWorkspaceError("invalid-state", "Linked research work is missing.");
			}
			if (ACTIVE_JOB_STATES.has(job.job.state)) return true;
		}
		return false;
	}

	async #browserView(detail: ResearchWorkspaceDetail): Promise<ResearchWorkspaceView> {
		let turns: ResearchWorkspaceTurnView[] = [];
		for (let savedTurn of detail.turns) {
			let evidence = savedTurn.evidenceJobId
				? await this.#browserJob(detail.workspace, savedTurn, savedTurn.evidenceJobId, "evidence")
				: undefined;
			let answer = savedTurn.answerJobId
				? await this.#browserJob(detail.workspace, savedTurn, savedTurn.answerJobId, "answer")
				: undefined;
			turns.push({
				...turn(savedTurn),
				...(evidence ? { evidence } : {}),
				...(answer ? { answer } : {}),
			});
		}
		return {
			workspace: summary(detail.workspace),
			turns,
			messages: detail.messages.map(message),
		};
	}

	async #requestView(detail: ResearchWorkspaceDetail): Promise<Research.RequestView> {
		let savedTurn = detail.turns.find(value => value.kind === "initial");
		if (!savedTurn) {
			throw new ResearchWorkspaceError("invalid-state", "Research request has no initial work.");
		}
		let evidence = savedTurn.evidenceJobId
			? await this.#jobs.get(detail.workspace.channelId, savedTurn.evidenceJobId)
			: undefined;
		let answer = savedTurn.answerJobId
			? await this.#jobs.get(detail.workspace.channelId, savedTurn.answerJobId)
			: undefined;
		if (evidence) this.#assertLinkedJob(evidence, detail.workspace, savedTurn, "evidence");
		if (answer) this.#assertLinkedJob(answer, detail.workspace, savedTurn, "answer");
		let sources: ResearchEvidence["sources"] = [];
		if (evidence?.job.state === "completed") {
			sources = this.#evidenceArtifact(evidence, detail.workspace, savedTurn).sources;
		}
		let state: Research.RequestState = answer?.job.state ?? evidence?.job.state ?? "pending";
		let stage: Research.RequestStage = "queued";
		let error: string | undefined;
		if (state === "failed") {
			stage = "failed";
			error = "Research could not be completed.";
		} else if (state === "cancelled" || state === "superseded") {
			stage = "cancelled";
		} else if (detail.workspace.publishedChannelId) stage = "ready";
		else if (answer?.job.state === "completed") stage = "publishing";
		else if (answer) {
			stage = answer.job.progress.some(value =>
					value.stage === "report-synthesis" && value.state === "started"
				)
				? "writing"
				: "analyzing";
		} else if (
			evidence?.job.progress.some(value =>
				value.stage === "public-web" && value.state === "started"
			)
		) stage = "searching";
		let child: Research.ReadyChild | undefined;
		if (detail.workspace.publishedChannelId) {
			let channel = await this.#storage.channels.get(detail.workspace.publishedChannelId);
			let report = await this.#initialReport(detail);
			if (!channel || !report) {
				throw new ResearchWorkspaceError("invalid-state", "Published research child is invalid.");
			}
			child = {
				id: channel.id,
				title: channel.title,
				slug: channel.slug,
				summary: report.summary,
				sourceCount: sources.length,
			};
		}
		return {
			id: detail.workspace.id,
			channelId: detail.workspace.channelId,
			question: savedTurn.question,
			state,
			stage,
			...(error ? { error } : {}),
			sources: sources.map(value => ({ ...value })),
			...(child ? { child } : {}),
			createdAt: detail.workspace.createdAt.toISOString(),
			updatedAt: detail.workspace.updatedAt.toISOString(),
		};
	}

	async #browserJob(
		workspace: ResearchWorkspace,
		savedTurn: ResearchTurn,
		jobId: string,
		role: "evidence" | "answer",
	): Promise<Job.Detail> {
		let job = await this.#jobs.get(workspace.channelId, jobId);
		if (!job) {
			throw new ResearchWorkspaceError("invalid-state", `Linked research ${role} is missing.`);
		}
		this.#assertLinkedJob(job, workspace, savedTurn, role);
		if (job.artifact) {
			let value = role === "evidence"
				? this.#evidenceArtifact(job, workspace, savedTurn)
				: this.#answerArtifact(job, workspace, savedTurn);
			job = { ...job, artifact: { ...job.artifact, value: value as JsonValue } };
		}
		return serializedJobDetail(job);
	}

	async #targetJob(
		channelId: string,
		type: "research-evidence" | "research-answer",
		targetKey: string,
	): Promise<JobView | undefined> {
		let expected = `${type}:${targetKey}`;
		let cursor;
		let scanned = 0;
		let selected: JobView | undefined;
		do {
			let page = await this.#jobs.list(channelId, 100, cursor);
			if (!page) return undefined;
			for (let job of page.jobs) {
				scanned++;
				if (
					job.type === type && job.targetKey === expected
					&& (!selected || job.targetGeneration > selected.targetGeneration)
				) selected = job;
				if (scanned >= MAX_TARGET_SCAN) break;
			}
			if (selected || scanned >= MAX_TARGET_SCAN) break;
			cursor = page.next;
		} while (cursor);
		return selected;
	}

	#target(workspaceId: string, turnId: string, role: "evidence" | "answer"): string {
		return `workspace:${workspaceId}:turn:${turnId}:${role}`;
	}

	#assertLinkedJob(
		job: JobDetail,
		workspace: ResearchWorkspace,
		savedTurn: ResearchTurn,
		role: "evidence" | "answer",
	): void {
		let type = role === "evidence" ? "research-evidence" : "research-answer";
		if (
			job.job.channelId !== workspace.channelId || job.job.type !== type
			|| job.job.targetKey !== `${type}:${this.#target(workspace.id, savedTurn.id, role)}`
		) {
			throw new ResearchWorkspaceError("invalid-state", `Linked research ${role} is invalid.`);
		}
	}

	async #stored(channelId: string, workspaceId: string): Promise<ResearchWorkspaceDetail> {
		let detail = await this.#storage.research.get(channelId, workspaceId);
		if (!detail) throw new ResearchWorkspaceError("not-found", "Research workspace not found.");
		return detail;
	}

	#newId(field: string): string {
		return safeId(this.#id(), field);
	}

	#time(): Date {
		let value = this.#clock();
		if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
			throw new Error("Research workspace clock returned an invalid time.");
		}
		return new Date(value);
	}

	#validId(value: string): boolean {
		return value.length >= 1 && value.length <= MAX_ID && SAFE_ID.test(value);
	}

	#hasDefinition(type: "research-evidence" | "research-answer"): boolean {
		return this.#jobs.definition(type, 1) !== undefined;
	}

	#requireDefinition(type: "research-evidence" | "research-answer"): void {
		if (this.#hasDefinition(type)) return;
		throw new ResearchWorkspaceError("not-ready", "Research execution is unavailable.");
	}

	async #published(workspace: ResearchWorkspace): Promise<void> {
		try {
			await this.#publish(workspace.channelId, workspace.id, workspace.revision);
		} catch (err) {
			console.warn(
				`[research] could not publish workspace ${workspace.id} revision ${workspace.revision}:`,
				err,
			);
		}
	}

	async #exclusive<T>(
		channelId: string,
		workspaceId: string,
		action: () => Promise<T>,
	): Promise<T> {
		let key = `${channelId}\0${workspaceId}`;
		let previous = this.#tails.get(key) ?? Promise.resolve();
		let release = Promise.withResolvers<void>();
		let current = previous.then(() => release.promise);
		this.#tails.set(key, current);
		await previous;
		try {
			return await action();
		} finally {
			release.resolve();
			if (this.#tails.get(key) === current) this.#tails.delete(key);
		}
	}
}
