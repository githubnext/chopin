import { describe, expect, it } from "bun:test";

import {
	findResearchQuestion,
	isPublicWebSearch,
	observedWebSourceUrls,
	publicResearchFailureReason,
	publicResearchResultFailure,
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

function execution(
	value: DocumentTarget,
	progress: JobExecution<ResearchQuestionInput>["progress"] = async () => {},
): JobExecution<ResearchQuestionInput> {
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
		progress: [],
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
		progress,
	};
}

describe("research question job", () => {
	it("extracts only public source URLs directly present in web-search output", () => {
		let rich = JSON.stringify({
			text: {
				value: "Answer",
				annotations: [{
					url_citation: { title: "Rich", url: "https://rich.example/source" },
				}],
			},
		});
		let urls = observedWebSourceUrls({
			citableSources: [{ url: "https://citable.example/source" }],
			structuredContent: {
				text: { annotations: [{ url_citation: { url: "https://structured.example/source" } }] },
			},
			content: rich,
			detailedContent: "[Detailed](https://detailed.example/source)",
			contents: [{ type: "text", text: "Source: <https://text.example/source>" }, {
				type: "resource_link",
				uri: "https://resource.example/source",
			}, {
				type: "resource",
				resource: { uri: "https://embedded.example/source", text: rich },
			}],
			mcpMeta: {
				url_citation: { url: "https://metadata-only.example/source" },
			},
		});
		expect(new Set(urls)).toEqual(
			new Set([
				"https://citable.example/source",
				"https://structured.example/source",
				"https://rich.example/source",
				"https://resource.example/source",
				"https://embedded.example/source",
			]),
		);
	});

	it("rejects unsafe and metadata-only web-search URLs", () => {
		let urls = observedWebSourceUrls({
			structuredContent: {
				text: {
					annotations: [
						{ url_citation: { url: "http://insecure.example/source" } },
						{ url_citation: { url: "https://user:secret@example.com/source" } },
						{ url_citation: { url: "https://example.com:8443/source" } },
						{ url_citation: { url: "https://127.0.0.1/source" } },
						{ url_citation: { url: "https://10.0.0.1/source" } },
						{ url_citation: { url: "https://100.64.0.1/source" } },
						{ url_citation: { url: "https://198.18.0.1/source" } },
						{ url_citation: { url: "https://app.localhost/source" } },
						{ url_citation: { url: "https://safe.example/source" } },
					],
				},
			},
			content: [
				"<http://insecure.example/source>",
				"<https://user:secret@example.com/source>",
				"<https://example.com:8443/source>",
				"<https://127.0.0.1/source>",
				"<https://10.0.0.1/source>",
				"<https://100.64.0.1/source>",
				"<https://198.18.0.1/source>",
				"<https://app.localhost/source>",
				"<https://safe.example/source>",
				"A bare mention is not provenance: https://bare.example/source",
			].join(" "),
			mcpMeta: { url_citation: { url: "https://metadata-only.example/source" } },
		});
		expect(urls).toEqual(["https://safe.example/source"]);
	});

	it("bounds web-search provenance extraction", () => {
		let citableSources = Array.from({ length: 100 }, (_, index) => ({
			url: `https://source-${index}.example/item`,
		}));
		expect(observedWebSourceUrls({ citableSources })).toHaveLength(64);
		expect(observedWebSourceUrls({
			citableSources: Array.from({ length: 5_000 }, () => ({ url: "not a URL" })),
		})).toEqual([]);
	});

	it("classifies unavailable public web search without exposing provider errors", () => {
		expect(publicResearchFailureReason(new Error("Background worker MCP readiness timed out.")))
			.toBe("web-search-unavailable");
		expect(publicResearchFailureReason(new Error("Background worker capability audit failed.")))
			.toBe("web-search-unavailable");
		expect(publicResearchFailureReason(new Error("provider failed")))
			.toBe("public-research-failed");
	});

	it("distinguishes public search and result failures", () => {
		let base = {
			webCalls: 1,
			webSuccesses: 1,
			webFailures: 0,
			hostedCalls: 0,
			hostedCompleted: 0,
			resultInvalid: false,
			webSearchDenied: false,
		};
		expect(publicResearchResultFailure(undefined, new Set(), { ...base, webCalls: 0 }))
			.toBe("web-search-not-invoked");
		expect(publicResearchResultFailure(undefined, new Set(), {
			...base,
			webSuccesses: 0,
			webFailures: 1,
		})).toBe("web-search-failed");
		expect(publicResearchResultFailure(undefined, new Set(), base))
			.toBe("research-result-missing");
		expect(publicResearchResultFailure(undefined, new Set(), { ...base, resultInvalid: true }))
			.toBe("research-result-invalid");
		expect(publicResearchResultFailure(undefined, new Set(), { ...base, webSearchDenied: true }))
			.toBe("research-permission-denied");
		expect(publicResearchResultFailure({ findings: [], sources: [] }, new Set(), {
			...base,
			webSuccesses: 0,
			webFailures: 1,
		})).toBe("web-search-failed");
		expect(publicResearchResultFailure({ findings: [], sources: [] }, new Set(), base))
			.toBeUndefined();
		let evidence = {
			findings: ["A finding"],
			sources: [{ title: "Source", url: "https://example.com/source" }],
		};
		expect(publicResearchResultFailure(evidence, new Set(), base))
			.toBe("research-sources-unverifiable");
		expect(publicResearchResultFailure(evidence, new Set(), {
			...base,
			hostedCalls: 1,
			hostedCompleted: 1,
		})).toBe("hosted-search-sources-unverifiable");
		expect(publicResearchResultFailure(undefined, new Set(), {
			...base,
			webSuccesses: 0,
			hostedCalls: 1,
			hostedCompleted: 0,
		})).toBe("web-search-failed");
		expect(publicResearchResultFailure(evidence, new Set(["https://example.com/other"]), base))
			.toBe("research-source-mismatch");
		expect(publicResearchResultFailure(evidence, new Set(["https://example.com/source"]), base))
			.toBeUndefined();
	});

	it("extracts the uniquely identified question prose", () => {
		expect(findResearchQuestion(parse(SOURCE), ID)).toBe(QUESTION);
		expect(findResearchQuestion(parse(SOURCE), "01K0N4V4E7Y6P4MJ5WD8XZF3B2"))
			.toBeUndefined();
	});

	it("recognizes only the permission-visible built-in web search", () => {
		expect(isPublicWebSearch({
			mcpServerName: "github-mcp-server",
			mcpToolName: "web_search",
		})).toBe(true);
		expect(isPublicWebSearch({ mcpServerName: "github", mcpToolName: "web_search" })).toBe(false);
		expect(isPublicWebSearch({ mcpServerName: "github-mcp-server", mcpToolName: "get_file" }))
			.toBe(false);
	});

	it("keeps public and private research inputs separated before synthesis", async () => {
		let current = target();
		let calls: string[] = [];
		let progress: string[] = [];
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
		expect(definition.limits.maxAiCredits).toBe(90);

		let artifact = await definition.execute(execution(current, async (stage, state) => {
			progress.push(`${stage}:${state}`);
		}));
		expect(calls).toEqual([
			`public:${QUESTION}`,
			`private:${QUESTION}:true`,
			`synthesis:${QUESTION}:1:1`,
		]);
		expect(progress).toEqual([
			"public-web:started",
			"public-web:completed",
			"private-document:started",
			"private-document:completed",
			"report-synthesis:started",
			"report-synthesis:completed",
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
		let progress: string[] = [];
		let valid = execution(target(), async (stage, state) => {
			progress.push(`${stage}:${state}`);
		});
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
		await expect(citing.execute(valid)).rejects.toMatchObject({
			progressReason: "source-validation-failed",
		});
		expect(progress.at(-1)).toBe("report-synthesis:started");
		expect(progress).not.toContain("report-synthesis:completed");
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
