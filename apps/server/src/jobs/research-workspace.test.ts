import { createHash } from "node:crypto";
import { describe, expect, it } from "bun:test";

import {
	observedWebSourceUrls,
	parseResearchAnswerArtifact,
	parseResearchAnswerInput,
	parseResearchEvidenceArtifact,
	parseResearchEvidenceInput,
	publicResearchResultFailure,
	researchAnswerDefinition,
	researchEvidenceDefinition,
} from "./research-workspace";

import type { BackgroundJob, JsonValue } from "../storage/model";
import type { JobExecution } from "./registry";
import type {
	ResearchAnswerEngines,
	ResearchAnswerInput,
	ResearchEvidenceInput,
	ResearchInitialAnswerInput,
	ResearchReport,
} from "./research-workspace";

const WORKSPACE_ID = "research-workspace-1";
const TURN_ID = "research-turn-1";
const QUERY = "Which API contracts changed?";
const SOURCE = "# Private document\n\nThe wire contract retained compatibility.\n";
const SOURCE_HASH = `sha256:${createHash("sha256").update(SOURCE).digest("hex")}`;
const PUBLIC_SOURCE = { title: "Release notes", url: "https://example.com/releases/v3" };
const REPORT: ResearchReport = {
	title: "API compatibility",
	summary: "The wire contract remains compatible.",
	findings: [{ text: "Compatibility was retained.", sourceUrls: [PUBLIC_SOURCE.url] }],
	caveats: [],
};

function document() {
	return { source: SOURCE, revision: 7, sourceHash: SOURCE_HASH };
}

function initialInput(): ResearchInitialAnswerInput {
	return {
		workspaceId: WORKSPACE_ID,
		turnId: TURN_ID,
		kind: "initial",
		question: QUERY,
		document: document(),
		evidence: [{
			findings: ["The public release notes say compatibility was retained."],
			sources: [PUBLIC_SOURCE],
		}],
		history: [{ author: "member", text: QUERY }],
	};
}

function followUpInput(kind: "follow-up" | "search-more" = "follow-up"): ResearchAnswerInput {
	return {
		...initialInput(),
		kind,
		question: "Was the old client tested?",
		originalReport: REPORT,
		history: [
			{ author: "member", text: QUERY },
			{ author: "agent", text: REPORT.summary },
			{ author: "member", text: "Was the old client tested?" },
		],
	};
}

function execution<Input extends JsonValue>(
	type: string,
	input: Input,
	progress: JobExecution<Input>["progress"] = async () => {},
): JobExecution<Input> {
	let now = new Date();
	let job: BackgroundJob = {
		id: "job-1",
		channelId: "channel-1",
		type,
		version: 1,
		origin: "user",
		targetKey: `${type}:${TURN_ID}`,
		targetGeneration: 1,
		idempotencyKey: "request-1",
		fingerprint: "fingerprint-1",
		input,
		state: "running",
		revision: 1,
		attempts: 1,
		failures: 0,
		claimGeneration: 1,
		claimOwner: "worker-1",
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
			ownerSessionId: "session-1",
			ownerGeneration: 1,
			credentialRevision: 1,
			expiresAt: new Date(now.getTime() + 60_000),
			authorize: async () => true,
		},
		signal: new AbortController().signal,
		deadline: new Date(now.getTime() + 60_000),
		progress,
	};
}

function answerEngines(
	overrides: Partial<ResearchAnswerEngines> = {},
): ResearchAnswerEngines {
	return {
		private: async () => ({ findings: ["The private document confirms compatibility."] }),
		synthesize: async () => REPORT,
		answer: async () => ({
			text: "Yes, according to the supplied report.",
			sourceUrls: [PUBLIC_SOURCE.url],
		}),
		...overrides,
	};
}

describe("research workspace codecs", () => {
	it("accepts only exact, bounded evidence inputs and artifacts", () => {
		expect(parseResearchEvidenceInput({
			workspaceId: WORKSPACE_ID,
			turnId: TURN_ID,
			query: `  ${QUERY}  `,
		})).toEqual({ workspaceId: WORKSPACE_ID, turnId: TURN_ID, query: QUERY });
		expect(() =>
			parseResearchEvidenceInput({
				workspaceId: WORKSPACE_ID,
				turnId: TURN_ID,
				query: QUERY,
				extra: true,
			})
		).toThrow("unexpected fields");
		expect(() =>
			parseResearchEvidenceInput({
				workspaceId: "w".repeat(129),
				turnId: TURN_ID,
				query: QUERY,
			})
		).toThrow("workspace id");
		expect(() =>
			parseResearchEvidenceInput({
				workspaceId: WORKSPACE_ID,
				turnId: TURN_ID,
				query: "q".repeat(4_097),
			})
		).toThrow("query");

		let artifact = {
			workspaceId: WORKSPACE_ID,
			turnId: TURN_ID,
			query: QUERY,
			findings: ["A public finding"],
			sources: [PUBLIC_SOURCE],
			model: "research-model",
		};
		expect(parseResearchEvidenceArtifact(artifact)).toEqual(artifact);
		expect(() => parseResearchEvidenceArtifact({ ...artifact, extra: "provider detail" }))
			.toThrow("unexpected fields");
		expect(() =>
			parseResearchEvidenceArtifact({
				...artifact,
				sources: [PUBLIC_SOURCE, { ...PUBLIC_SOURCE }],
			})
		).toThrow("unique");
		for (
			let url of [
				"http://example.com/source",
				"https://user:secret@example.com/source",
				"https://example.com:8443/source",
				"https://localhost/source",
				"https://192.168.1.1/source",
			]
		) {
			expect(() =>
				parseResearchEvidenceArtifact({
					...artifact,
					sources: [{ title: "Unsafe", url }],
				})
			).toThrow("public HTTPS");
		}
	});

	it("strictly discriminates answer inputs and verifies document provenance", () => {
		expect(parseResearchAnswerInput(initialInput()).kind).toBe("initial");
		expect(parseResearchAnswerInput(followUpInput()).kind).toBe("follow-up");
		expect(() =>
			parseResearchAnswerInput({
				...initialInput(),
				originalReport: REPORT,
			})
		).toThrow("unexpected fields");
		let { originalReport: _originalReport, ...missingReport } = followUpInput() as
			& ReturnType<
				typeof followUpInput
			>
			& { originalReport: ResearchReport };
		expect(() => parseResearchAnswerInput(missingReport)).toThrow("unexpected fields");
		expect(() =>
			parseResearchAnswerInput({
				...initialInput(),
				document: { ...document(), sourceHash: `sha256:${"0".repeat(64)}` },
			})
		).toThrow("does not match");
		expect(() =>
			parseResearchAnswerInput({
				...initialInput(),
				history: Array.from({ length: 101 }, () => ({ author: "member", text: "bounded" })),
			})
		).toThrow("history");
		expect(() =>
			parseResearchAnswerInput({
				...initialInput(),
				history: Array.from(
					{ length: 65 },
					() => ({ author: "member", text: "x".repeat(4_096) }),
				),
			})
		).toThrow("history exceeds");
		expect(() =>
			parseResearchAnswerInput({
				...initialInput(),
				evidence: Array.from({ length: 7 }, (_, batch) => ({
					findings: [],
					sources: Array.from({ length: 10 }, (_, source) => ({
						title: `Source ${batch}-${source}`,
						url: `https://source-${batch}-${source}.example/item`,
					})),
				})),
			})
		).toThrow("aggregate bound");

		let definition = researchAnswerDefinition({
			config: { agent: true, model: "research-model" },
			engines: answerEngines(),
		});
		expect(definition.limits.maxInputBytes).toBeGreaterThanOrEqual(256 * 1024);
		expect(definition.limits.maxInputBytes).toBeLessThanOrEqual(2 * 1024 * 1024);
	});

	it("decodes immutable answer artifact variants and rejects shape confusion", () => {
		let initial = {
			workspaceId: WORKSPACE_ID,
			turnId: TURN_ID,
			kind: "initial" as const,
			report: REPORT,
			sources: [PUBLIC_SOURCE],
			publicFindings: ["Public"],
			privateFindings: ["Private"],
			documentRevision: 7,
			documentSourceHash: SOURCE_HASH,
			model: "research-model",
		};
		expect(parseResearchAnswerArtifact(initial)).toEqual(initial);
		expect(() =>
			parseResearchAnswerArtifact({
				...initial,
				answer: { text: "Wrong variant", sourceUrls: [] },
			})
		).toThrow("unexpected fields");

		let followUp = {
			workspaceId: WORKSPACE_ID,
			turnId: TURN_ID,
			kind: "follow-up" as const,
			answer: { text: "Grounded answer", sourceUrls: [PUBLIC_SOURCE.url] },
			sources: [PUBLIC_SOURCE],
			documentRevision: 7,
			documentSourceHash: SOURCE_HASH,
			model: "research-model",
		};
		expect(parseResearchAnswerArtifact(followUp)).toEqual(followUp);
		expect(() => parseResearchAnswerArtifact({ ...followUp, report: REPORT }))
			.toThrow("unexpected fields");
	});
});

describe("research evidence provenance", () => {
	it("extracts only explicit public URLs from bounded web-search output", () => {
		let rich = JSON.stringify({
			text: { annotations: [{ url_citation: { url: "https://rich.example/source" } }] },
		});
		let urls = observedWebSourceUrls({
			citableSources: [{ url: "https://citable.example/source" }],
			structuredContent: {
				annotations: [{ url_citation: { url: "https://structured.example/source" } }],
			},
			content: rich,
			contents: [{ type: "resource_link", uri: "https://resource.example/source" }],
			mcpMeta: { url_citation: { url: "https://metadata-only.example/source" } },
			detailedContent: "A bare URL is not provenance: https://bare.example/source",
		});
		expect(new Set(urls)).toEqual(
			new Set([
				"https://citable.example/source",
				"https://structured.example/source",
				"https://rich.example/source",
				"https://resource.example/source",
			]),
		);
		expect(observedWebSourceUrls({
			citableSources: Array.from({ length: 100 }, (_, index) => ({
				url: `https://bounded-${index}.example/source`,
			})),
		})).toHaveLength(64);
	});

	it("rejects credentials, ports, localhost, private IPv4, and unobserved URLs", () => {
		let urls = observedWebSourceUrls({
			structuredContent: {
				annotations: [
					{ url_citation: { url: "http://insecure.example/source" } },
					{ url_citation: { url: "https://user:secret@example.com/source" } },
					{ url_citation: { url: "https://example.com:8443/source" } },
					{ url_citation: { url: "https://app.localhost/source" } },
					{ url_citation: { url: "https://127.0.0.1/source" } },
					{ url_citation: { url: "https://10.0.0.1/source" } },
					{ url_citation: { url: "https://100.64.0.1/source" } },
					{ url_citation: { url: "https://198.18.0.1/source" } },
					{ url_citation: { url: PUBLIC_SOURCE.url } },
				],
			},
		});
		expect(urls).toEqual([PUBLIC_SOURCE.url]);

		let result = { findings: ["Finding"], sources: [PUBLIC_SOURCE] };
		let metrics = {
			webCalls: 1,
			webSuccesses: 1,
			webFailures: 0,
			hostedCalls: 0,
			hostedCompleted: 0,
			resultInvalid: false,
			webSearchDenied: false,
		};
		expect(publicResearchResultFailure(result, new Set(), metrics))
			.toBe("research-sources-unverifiable");
		expect(publicResearchResultFailure(result, new Set(["https://other.example/"]), metrics))
			.toBe("research-source-mismatch");
		expect(publicResearchResultFailure(result, new Set([PUBLIC_SOURCE.url]), metrics))
			.toBeUndefined();
		expect(publicResearchResultFailure(result, new Set([PUBLIC_SOURCE.url]), {
			...metrics,
			webSuccesses: 0,
		})).toBe("web-search-failed");
		expect(publicResearchResultFailure(result, new Set([PUBLIC_SOURCE.url]), {
			...metrics,
			resultInvalid: true,
		})).toBe("research-result-invalid");
	});
});

describe("research workspace execution", () => {
	it("keeps the public evidence worker input isolated and uses one attempt", async () => {
		let observed: unknown;
		let progress: string[] = [];
		let definition = researchEvidenceDefinition({
			config: { agent: true, model: "research-model" },
			engine: async (execution, query) => {
				observed = { input: execution.input, query };
				return { findings: ["Public finding"], sources: [PUBLIC_SOURCE] };
			},
		});
		let input: ResearchEvidenceInput = {
			workspaceId: WORKSPACE_ID,
			turnId: TURN_ID,
			query: QUERY,
		};
		let artifact = await definition.execute(execution(
			"research-evidence",
			input,
			async (stage, state) => {
				progress.push(`${stage}:${state}`);
			},
		));
		expect(observed).toEqual({ input, query: QUERY });
		expect(Object.keys(input).sort()).toEqual(["query", "turnId", "workspaceId"]);
		expect(definition).toMatchObject({
			type: "research-evidence",
			version: 1,
			origins: ["user", "planner"],
			credential: "active-planner",
			limits: { maxAttempts: 1 },
		});
		expect(progress).toEqual(["public-web:started", "public-web:completed"]);
		expect(artifact).toMatchObject({ ...input, model: "research-model" });
	});

	it("separates private document analysis from report synthesis", async () => {
		let calls: string[] = [];
		let publicCalls = 0;
		let progress: string[] = [];
		let injected = {
			...answerEngines({
				private: async (_execution, question, source) => {
					calls.push(`private:${question}:${source === SOURCE}`);
					return { findings: ["Private finding"] };
				},
				synthesize: async (_execution, question, publicValue, privateValue) => {
					calls.push(
						`synthesize:${question}:${publicValue.findings.length}:${privateValue.findings.length}`,
					);
					expect(publicValue).not.toHaveProperty("document");
					return REPORT;
				},
				answer: async () => {
					calls.push("answer");
					return { text: "Unused", sourceUrls: [] };
				},
			}),
			public: async () => {
				publicCalls++;
			},
		};
		let definition = researchAnswerDefinition({
			config: { agent: true, model: "research-model" },
			engines: injected,
		});
		expect(definition).toMatchObject({
			type: "research-answer",
			version: 1,
			origins: ["user", "planner"],
			credential: "active-planner",
		});
		let input = initialInput();
		input.evidence.push({ findings: [], sources: [{ ...PUBLIC_SOURCE }] });
		let artifact = await definition.execute(execution(
			"research-answer",
			input,
			async (stage, state) => {
				progress.push(`${stage}:${state}`);
			},
		));
		expect(calls).toEqual([
			`private:${QUERY}:true`,
			`synthesize:${QUERY}:1:1`,
		]);
		expect(publicCalls).toBe(0);
		expect(progress).toEqual([
			"private-document:started",
			"private-document:completed",
			"report-synthesis:started",
			"report-synthesis:completed",
		]);
		expect(artifact).toMatchObject({
			kind: "initial",
			sources: [PUBLIC_SOURCE],
			publicFindings: ["The public release notes say compatibility was retained."],
			privateFindings: ["Private finding"],
			documentRevision: 7,
			documentSourceHash: SOURCE_HASH,
		});
	});

	it("uses one no-web private answer stage for follow-up and search-more turns", async () => {
		for (let kind of ["follow-up", "search-more"] as const) {
			let calls: string[] = [];
			let publicCalls = 0;
			let material: unknown;
			let injected = {
				...answerEngines({
					private: async () => {
						calls.push("private");
						return { findings: [] };
					},
					synthesize: async () => {
						calls.push("synthesize");
						return REPORT;
					},
					answer: async (_execution, value) => {
						calls.push("answer");
						material = value;
						return { text: "The old client was tested.", sourceUrls: [PUBLIC_SOURCE.url] };
					},
				}),
				public: async () => {
					publicCalls++;
				},
			};
			let progress: string[] = [];
			let definition = researchAnswerDefinition({
				config: { agent: true, model: "research-model" },
				engines: injected,
			});
			let artifact = await definition.execute(execution(
				"research-answer",
				followUpInput(kind),
				async (stage, state) => {
					progress.push(`${stage}:${state}`);
				},
			));
			expect(calls).toEqual(["answer"]);
			expect(publicCalls).toBe(0);
			expect(material).toMatchObject({
				kind,
				question: "Was the old client tested?",
				document: document(),
				originalReport: REPORT,
			});
			expect(progress).toEqual(["private-answer:started", "private-answer:completed"]);
			expect(artifact).toMatchObject({
				kind,
				answer: { text: "The old client was tested." },
				documentRevision: 7,
				documentSourceHash: SOURCE_HASH,
			});
		}
	});

	it("rejects report and answer citations absent from supplied evidence", async () => {
		let initial = researchAnswerDefinition({
			config: { agent: true, model: "research-model" },
			engines: answerEngines({
				synthesize: async () => ({
					...REPORT,
					findings: [{ text: "Unsupported", sourceUrls: ["https://unknown.example/source"] }],
				}),
			}),
		});
		await expect(initial.execute(execution("research-answer", initialInput())))
			.rejects.toMatchObject({ progressReason: "source-validation-failed" });

		let followUp = researchAnswerDefinition({
			config: { agent: true, model: "research-model" },
			engines: answerEngines({
				answer: async () => ({
					text: "Unsupported",
					sourceUrls: ["https://unknown.example/source"],
				}),
			}),
		});
		await expect(followUp.execute(execution("research-answer", followUpInput())))
			.rejects.toMatchObject({ progressReason: "source-validation-failed" });
	});
});
