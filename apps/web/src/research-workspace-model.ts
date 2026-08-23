import type { Job } from "@chopin/protocol";
import type * as Api from "./api";

export type ResearchSubmission = {
	text: string;
	requestId?: string;
	submittedAction?: string;
	submittedText?: string;
};

export function editResearchSubmission(
	state: ResearchSubmission,
	text: string,
): ResearchSubmission {
	return text === state.submittedText
		? { ...state, text }
		: { text };
}

export function beginResearchSubmission(
	state: ResearchSubmission,
	action: string,
	id: () => string = () => crypto.randomUUID(),
): Required<ResearchSubmission> {
	if (
		state.requestId && state.submittedAction === action
		&& state.submittedText === state.text
	) {
		return state as Required<ResearchSubmission>;
	}
	return {
		text: state.text,
		requestId: id(),
		submittedAction: action,
		submittedText: state.text,
	};
}

export function completeResearchSubmission(): ResearchSubmission {
	return { text: "" };
}

export type ResearchSource = {
	title: string;
	url: string;
};

export type ResearchReport = {
	title: string;
	summary: string;
	findings: Array<{ text: string; sourceUrls: string[] }>;
	caveats: string[];
};

type ResearchArtifactBase = {
	workspaceId: string;
	turnId: string;
	documentRevision: number;
	documentSourceHash: string;
	model: string;
	sources: ResearchSource[];
};

export type ResearchInitialArtifact = ResearchArtifactBase & {
	kind: "initial";
	report: ResearchReport;
};

export type ResearchContinuationArtifact = ResearchArtifactBase & {
	kind: "follow-up" | "search-more";
	answer: { text: string; sourceUrls: string[] };
};

export type ResearchAnswerArtifact = ResearchInitialArtifact | ResearchContinuationArtifact;

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? value as Record<string, unknown>
		: undefined;
}

function text(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function textList(value: unknown): string[] | undefined {
	if (!Array.isArray(value) || value.some(item => typeof item !== "string")) return undefined;
	return value as string[];
}

export function externalResearchUrl(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	try {
		let url = new URL(value);
		return url.protocol === "https:" && !url.username && !url.password && url.hostname
			? value
			: undefined;
	} catch {
		return undefined;
	}
}

function sources(value: unknown): ResearchSource[] | undefined {
	if (!Array.isArray(value)) return undefined;
	let parsed: ResearchSource[] = [];
	let urls = new Set<string>();
	for (let candidate of value) {
		let item = record(candidate);
		let title = text(item?.title);
		let url = externalResearchUrl(item?.url);
		if (!title || !url || urls.has(url)) return undefined;
		urls.add(url);
		parsed.push({ title, url });
	}
	return parsed;
}

function citations(value: unknown, available: ReadonlySet<string>): string[] | undefined {
	let parsed = textList(value);
	return parsed?.every(url => available.has(url)) ? parsed : undefined;
}

function report(value: unknown, available: ReadonlySet<string>): ResearchReport | undefined {
	let item = record(value);
	let title = text(item?.title);
	let summary = text(item?.summary);
	let caveats = textList(item?.caveats);
	if (!title || !summary || !caveats || !Array.isArray(item?.findings)) return undefined;
	let findings: ResearchReport["findings"] = [];
	for (let candidate of item.findings) {
		let finding = record(candidate);
		let findingText = text(finding?.text);
		let sourceUrls = citations(finding?.sourceUrls, available);
		if (!findingText || !sourceUrls) return undefined;
		findings.push({ text: findingText, sourceUrls });
	}
	return { title, summary, findings, caveats };
}

export function decodeResearchAnswerArtifact(value: unknown): ResearchAnswerArtifact | undefined {
	let item = record(value);
	if (!item) return undefined;
	let workspaceId = text(item?.workspaceId);
	let turnId = text(item?.turnId);
	let documentRevision = item?.documentRevision;
	let documentSourceHash = text(item?.documentSourceHash);
	let model = text(item?.model);
	let parsedSources = sources(item?.sources);
	if (
		!workspaceId || !turnId || !Number.isSafeInteger(documentRevision)
		|| (documentRevision as number) < 0 || !documentSourceHash || !model || !parsedSources
	) return undefined;
	let basis: ResearchArtifactBase = {
		workspaceId,
		turnId,
		documentRevision: documentRevision as number,
		documentSourceHash,
		model,
		sources: parsedSources,
	};
	let available = new Set(parsedSources.map(source => source.url));
	if (item.kind === "initial") {
		let parsedReport = report(item.report, available);
		return parsedReport ? { ...basis, kind: "initial", report: parsedReport } : undefined;
	}
	if (item.kind === "follow-up" || item.kind === "search-more") {
		let answer = record(item.answer);
		let answerText = text(answer?.text);
		let sourceUrls = citations(answer?.sourceUrls, available);
		return answerText && sourceUrls
			? { ...basis, kind: item.kind, answer: { text: answerText, sourceUrls } }
			: undefined;
	}
	return undefined;
}

export function artifactFromJob(detail?: Job.Detail): ResearchAnswerArtifact | undefined {
	return detail?.artifact ? decodeResearchAnswerArtifact(detail.artifact.value) : undefined;
}

const ACTIVE_JOB_STATES = new Set<Job.State>(["pending", "paused", "running"]);

export function activeResearchJob(detail?: Job.Detail): boolean {
	return !!detail && ACTIVE_JOB_STATES.has(detail.job.state);
}

function newerJob(current: Job.Detail | undefined, next: Job.Detail | undefined) {
	if (!current) return next;
	if (!next) return current;
	return current.job.revision > next.job.revision ? current : next;
}

export function mergeResearchWorkspaceDetail(
	current: Api.ResearchWorkspaceDetail | undefined,
	next: Api.ResearchWorkspaceDetail,
): Api.ResearchWorkspaceDetail {
	if (!current || current.workspace.id !== next.workspace.id) return next;
	let currentTurns = new Map(current.turns.map(turn => [turn.id, turn]));
	return {
		...next,
		turns: next.turns.map(turn => {
			let previous = currentTurns.get(turn.id);
			if (!previous) return turn;
			let evidence = newerJob(previous.evidence, turn.evidence);
			let answer = newerJob(previous.answer, turn.answer);
			return {
				...turn,
				...(evidence ? { evidence } : {}),
				...(answer ? { answer } : {}),
			};
		}),
	};
}

export function latestResearchJobRevision(detail: Api.ResearchWorkspaceDetail): number {
	return Math.max(
		-1,
		...detail.turns.flatMap(turn => [turn.evidence?.revision ?? -1, turn.answer?.revision ?? -1]),
	);
}
