import { JobRegistry } from "../jobs/registry";
import { researchAnswerDefinition, researchEvidenceDefinition } from "../jobs/research-workspace";
import { JobService } from "../jobs/service";
import { ResearchWorkspaceService } from "../research/service";
import { answerArtifact, evidenceArtifact, REPORT } from "../research/test-support";
import { MemoryStorage } from "../storage/memory/adapter";
import { AgendaService } from "./service";
import type { Agenda } from "@chopin/protocol";
import type { AgendaAssessor } from "./assessor";
import type { AgendaOwner } from "../storage/agenda";
import type { JobExecutionCredential } from "../jobs/registry";

export const SCOPE =
	"Public patterns for teaching the difference between open and resolved decisions.";
export const QUESTIONS: Agenda.QuestionInput[] = [{
	question: "How do collaborative tools explain open versus resolved decisions?",
	reason: "New users confuse decisions with completed choices.",
	evidenceNeed: "Public examples and usability evidence of status explanations.",
	priority: 1,
}, {
	question: "How do public products teach creating a new decision?",
	reason: "A first attempt may reveal whether creation is discoverable.",
	evidenceNeed: "Public onboarding examples with concrete creation paths.",
	priority: 2,
}];

export async function agendaFixture(overrides: Partial<AgendaAssessor> = {}) {
	let now = new Date("2026-10-14T21:00:00.000Z");
	let storage = new MemoryStorage();
	let channelId = crypto.randomUUID();
	let owner: AgendaOwner = {
		userId: "user-agenda",
		userHandle: "octocat",
		sessionId: "owner-session",
		generation: 1,
		credentialRevision: 1,
	};
	await storage.users.put({ id: owner.userId, login: owner.userHandle, avatarUrl: "avatar", now });
	await storage.channels.create({
		id: channelId,
		repositoryId: "repo-agenda",
		repositoryOwner: "octo-org",
		repositoryName: "score",
		title: "Decisions onboarding",
		createdBy: owner.userId,
		now,
	});
	let lease = await storage.leases.acquire("chopin:writer", "agenda-tests", 60_000);
	if (!lease) throw new Error("missing lease");
	let registry = new JobRegistry();
	let jobs = new JobService({ storage, registry, lease: () => lease, now: () => now });
	let agenda!: AgendaService;
	let source =
		"# Decisions onboarding\n\nA coworker asks how to create an open decision. PRIVATE_MARKER.\n";
	let research = new ResearchWorkspaceService({
		storage,
		jobs,
		lease: () => lease,
		clock: () => now,
		current: async channelId => ({
			channelId,
			revision: 1,
			source,
			sourceHash: `sha256:${new Bun.CryptoHasher("sha256").update(source).digest("hex")}`,
		}),
		publish: () => {},
		guard: (...args) => agenda.guardResearch(...args),
	});
	let available = true;
	let authorized = true;
	let seen: { public: string[]; private: string[]; worker: string[] } = {
		public: [],
		private: [],
		worker: [],
	};
	let options = {
		storage,
		research,
		lease: () => lease,
		available: () => available,
		current: async (_channelId: string) => ({ source }),
		clock: () => now,
		resolveOwner: async (_channelId: string) =>
			authorized
				? {
					owner,
					token: () => "test-token",
					signal: new AbortController().signal,
					authorize: async () => authorized,
					release: () => {},
				}
				: undefined,
		assessor: {
			generate: async (...args: Parameters<AgendaAssessor["generate"]>) => {
				seen.public.push(args[0]);
				return overrides.generate ? overrides.generate(...args) : QUESTIONS;
			},
			assess: async (...args: Parameters<AgendaAssessor["assess"]>) => {
				seen.private.push(JSON.stringify(args[0]));
				return overrides.assess ? overrides.assess(...args) : {
					decision: "investigate" as const,
					questionId: args[0].questions[0]!.id,
					reason: "This public evidence informs the next useful change.",
				};
			},
		},
	};
	agenda = new AgendaService(options);
	// Tests explicitly tick so concurrent calls can be controlled deterministically.
	agenda.wake = () => {};
	let evidence = agenda.wrapResearchDefinition(researchEvidenceDefinition({
		config: { agent: true, model: "fake" },
		engine: async (_execution, query) => {
			seen.worker.push(query);
			return { findings: [], sources: [] };
		},
	}));
	let answer = agenda.wrapResearchDefinition(researchAnswerDefinition({
		config: { agent: true, model: "fake" },
		engines: {
			private: async () => ({ findings: [] }),
			synthesize: async () => REPORT,
			answer: async () => ({ text: "Answer", sourceUrls: [] }),
		},
	}));
	registry.register(evidence);
	registry.register(answer);
	let credential: JobExecutionCredential = {
		kind: "active-planner",
		token: "test-token",
		ownerSessionId: owner.sessionId,
		ownerGeneration: owner.generation,
		credentialRevision: owner.credentialRevision,
		expiresAt: new Date(now.getTime() + 24 * 60 * 60_000),
		authorize: async () => authorized,
	};
	return {
		storage,
		channelId,
		owner,
		lease,
		jobs,
		research,
		agenda,
		options,
		seen,
		credential,
		evidence,
		answer,
		clock: () => now,
		advance: (ms: number) => {
			now = new Date(now.getTime() + ms);
		},
		authorize: (value: boolean) => {
			authorized = value;
		},
		capability: (value: boolean) => {
			available = value;
		},
		document: (value: string) => {
			source = value;
		},
		async activate(questions = QUESTIONS) {
			await agenda.save(channelId, { expectedRevision: 0, scope: SCOPE, questions });
			await agenda.activate(channelId, 1, owner);
		},
		async complete(type: "research-evidence" | "research-answer") {
			let [claimed] = await storage.jobs.claim({
				channelId,
				claimOwner: "worker",
				count: 1,
				ttlMs: 30_000,
				now,
				lease,
			});
			if (!claimed || claimed.type !== type) throw new Error(`Missing ${type}`);
			let definition = type === "research-evidence" ? evidence : answer;
			await definition.execute({
				job: claimed,
				input: claimed.input as never,
				credential,
				signal: new AbortController().signal,
				deadline: new Date(now.getTime() + 300_000),
				progress: async () => {},
			});
			return jobs.settle({
				channelId,
				jobId: claimed.id,
				claimOwner: "worker",
				claimGeneration: claimed.claimGeneration,
				artifact: type === "research-evidence"
					? evidenceArtifact(claimed)
					: answerArtifact(claimed),
			});
		},
	};
}
