import { describe, expect, it } from "bun:test";

import {
	findResearchQuestion,
	researchQuestionDefinition,
	researchQuestionSnapshot,
} from "./research-question";
import { parse } from "@chopin/dialect/parse";
import { sourceHash } from "../plan/service";

import type { JobExecution } from "./registry";
import type { ResearchQuestionInput } from "./research-question";
import type { DocumentTarget } from "../plan/service";
import type { BackgroundJob } from "../storage/model";

const ID = "01K0N4TR8K7JGM4R1J7PW4R8YJ";
const SOURCE = `<ResearchQuestion id="${ID}">\n\nWhat changed in the API?\n\n</ResearchQuestion>\n`;
const QUESTION = "What changed in the API?";
const QUESTION_HASH = researchQuestionSnapshot(SOURCE, ID)!.questionHash;

function target(source = SOURCE, revision = 3): DocumentTarget {
	return { channelId: "channel", revision, source, sourceHash: sourceHash(source) };
}

function execution(value: DocumentTarget): JobExecution<ResearchQuestionInput> {
	let now = new Date();
	let input = {
		questionId: ID,
		question: QUESTION,
		questionHash: QUESTION_HASH,
		revision: value.revision,
	};
	let job: BackgroundJob = {
		id: "job",
		channelId: value.channelId,
		type: "research-question",
		version: 1,
		origin: "user",
		targetKey: `research-question:${ID}`,
		targetGeneration: 1,
		idempotencyKey: "request",
		fingerprint: "fingerprint",
		input,
		state: "running",
		revision: 2,
		attempts: 1,
		failures: 0,
		claimGeneration: 1,
		claimOwner: "worker",
		claimBinding: undefined,
		claimExpiresAt: new Date(now.getTime() + 60_000),
		availableAt: now,
		reason: undefined,
		createdAt: now,
		updatedAt: now,
	};
	return {
		job,
		input,
		credential: {
			kind: "active-planner",
			token: "ghu_owner",
			ownerSessionId: "session",
			ownerGeneration: 2,
			credentialRevision: 3,
			expiresAt: new Date(now.getTime() + 60_000),
			authorize: async () => true,
		},
		signal: new AbortController().signal,
		deadline: new Date(now.getTime() + 60_000),
	};
}

describe("research question job", () => {
	it("extracts the uniquely identified question prose", () => {
		expect(findResearchQuestion(parse(SOURCE), ID)).toBe(QUESTION);
		expect(findResearchQuestion(parse(SOURCE), "01K0N4V4E7Y6P4MJ5WD8XZF3B2"))
			.toBeUndefined();
	});

	it("keeps public and private research inputs separated before synthesis", async () => {
		let current = target();
		let calls: string[] = [];
		let definition = researchQuestionDefinition({
			config: { agent: true, model: "research-model" },
			current: async () => current,
			commitCurrent: async (_channel, _id, _hash, _revision, _sourceHash, commit) => {
				await commit();
				return true;
			},
			engines: {
				public: async (_execution, question) => {
					calls.push(`public:${question}`);
					return {
						findings: ["A public finding"],
						sources: [{ title: "Source", url: "https://example.com/source" }],
					};
				},
				private: async (_execution, question, source) => {
					calls.push(`private:${question}:${source === SOURCE}`);
					return { findings: ["A private finding"] };
				},
				synthesize: async (_execution, question, publicValue, privateValue) => {
					calls.push(
						`synthesis:${question}:${publicValue.findings.length}:${privateValue.findings.length}`,
					);
					return {
						title: "API research",
						summary: "Combined report",
						findings: [{ text: "Finding", sourceUrls: ["https://example.com/source"] }],
						caveats: [],
					};
				},
			},
		});

		let artifact = await definition.execute(execution(current));
		expect(calls).toEqual([
			`public:${QUESTION}`,
			`private:${QUESTION}:true`,
			`synthesis:${QUESTION}:1:1`,
		]);
		expect(artifact).toMatchObject({
			questionId: ID,
			questionHash: QUESTION_HASH,
			documentRevision: 3,
			documentSourceHash: current.sourceHash,
			model: "research-model",
			sources: [{ url: "https://example.com/source" }],
			report: { summary: "Combined report" },
		});
	});

	it("rejects changed questions and unknown synthesized citations", async () => {
		let current = target(
			`<ResearchQuestion id="${ID}">\n\nA different question?\n\n</ResearchQuestion>\n`,
			4,
		);
		let definition = researchQuestionDefinition({
			config: { agent: true, model: "research-model" },
			current: async () => current,
			commitCurrent: async () => false,
			engines: {
				public: async () => ({ findings: [], sources: [] }),
				private: async () => ({ findings: [] }),
				synthesize: async () => ({
					title: "Report",
					summary: "Summary",
					findings: [],
					caveats: [],
				}),
			},
		});
		await expect(definition.execute(execution(target()))).rejects.toThrow("changed");
		let valid = execution(target());
		current = target();
		let citing = researchQuestionDefinition({
			config: { agent: true, model: "research-model" },
			current: async () => current,
			commitCurrent: async () => false,
			engines: {
				public: async () => ({ findings: [], sources: [] }),
				private: async () => ({ findings: [] }),
				synthesize: async () => ({
					title: "Report",
					summary: "Summary",
					findings: [{ text: "Claim", sourceUrls: ["https://unknown.example/source"] }],
					caveats: [],
				}),
			},
		});
		await expect(citing.execute(valid)).rejects.toThrow("unknown source");
	});

	it("validates the immutable question snapshot", () => {
		let definition = researchQuestionDefinition({
			config: { agent: true, model: "research-model" },
			current: async () => target(),
			commitCurrent: async () => false,
			engines: {
				public: async () => ({ findings: [], sources: [] }),
				private: async () => ({ findings: [] }),
				synthesize: async () => ({
					title: "Report",
					summary: "Summary",
					findings: [],
					caveats: [],
				}),
			},
		});
		expect(() =>
			definition.input.parse({
				questionId: ID,
				question: QUESTION,
				questionHash: "bad-hash",
				revision: 3,
			})
		).toThrow("hash");
	});
});
