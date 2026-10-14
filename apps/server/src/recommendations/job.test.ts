import { describe, expect, it } from "bun:test";

import { JobRegistry } from "../jobs/registry";
import { buildRecommendationDefinition } from "./job";

import type { JobExecution } from "../jobs/registry";
import type { BackgroundJob } from "../storage/model";
import type { RecommendationArtifact, RecommendationInput } from "./schema";
import type { RecommendationEngine } from "./worker";
import type { BuildRecommendation } from "@chopin/protocol/recommendation";

function input(): RecommendationInput {
	return {
		key: `sha256:${"a".repeat(64)}`,
		planRevision: 1,
		evidence: [
			{
				id: "discussion:1",
				kind: "discussion",
				label: "Coworker feedback",
				detail: "I cannot discover how to create an open decision.",
			},
			{
				id: "repository:1",
				kind: "repository",
				label: "Current interface",
				detail: "Observed: decision creation is offered only in the editor toolbar.",
			},
		],
	};
}

function result(): Pick<RecommendationArtifact, "recommendation" | "model"> & {
	recommendation: BuildRecommendation;
} {
	return {
		model: "fixture",
		recommendation: {
			kind: "build",
			title: "Make open decision creation discoverable",
			scope: "Expose the existing decision action in the Decisions tab.",
			reasons: ["The existing creation action is hidden in the editor toolbar."],
			dependencies: [],
			optional: ["Explore broader onboarding separately."],
			evidenceIds: ["discussion:1", "repository:1"],
			nextAction:
				"Propose the smallest Decisions-tab entry point for the existing creation action.",
		},
	};
}

function execution(material = input()): JobExecution<RecommendationInput> {
	return {
		input: material,
		job: { channelId: "channel", input: material } as unknown as BackgroundJob,
		credential: {
			kind: "active-planner",
			token: "fixture-only",
			ownerSessionId: "owner",
			ownerGeneration: 1,
			credentialRevision: 1,
			expiresAt: new Date(Date.now() + 60_000),
			authorize: async () => true,
		},
		signal: new AbortController().signal,
		deadline: new Date(Date.now() + 60_000),
		progress: async () => {},
	};
}

function fixture(engine: RecommendationEngine = async () => result()) {
	let current: RecommendationInput | undefined = input();
	let definition = buildRecommendationDefinition({
		config: { agent: true, model: "fixture" },
		current: async () => current,
		engine,
	});
	return { definition, change: (value: RecommendationInput | undefined) => current = value };
}

describe("build recommendation job", () => {
	it("registers a bounded scheduler-only active-owner advisory job", async () => {
		let { definition } = fixture();
		expect(() => new JobRegistry([definition])).not.toThrow();
		expect(definition).toMatchObject({
			type: "build-recommendation",
			version: 1,
			credential: "active-planner",
			origins: ["scheduler"],
		});
		expect(definition.limits).toEqual({
			timeoutMs: 60_000,
			maxAttempts: 2,
			maxAiCredits: 30,
			maxInputBytes: 128 * 1024,
			maxArtifactBytes: 32 * 1024,
		});
		let output = await definition.execute(execution());
		expect(output).toEqual({ ...result(), key: input().key, planRevision: 1 });
		expect(output.recommendation?.optional).toEqual(["Explore broader onboarding separately."]);
	});

	it("refuses a stale input before calling the engine", async () => {
		let calls = 0;
		let { definition, change } = fixture(async () => {
			calls++;
			return result();
		});
		change({ ...input(), key: `sha256:${"b".repeat(64)}` });
		await expect(definition.execute(execution())).rejects.toThrow("recommendation-stale");
		expect(calls).toBe(0);
	});

	it("abstention remains bounded to current evidence and cannot bypass publication freshness", async () => {
		let { definition, change } = fixture(async () => ({ recommendation: null, model: "fixture" }));
		let artifact = await definition.execute(execution());
		expect(artifact).toEqual({
			key: input().key,
			planRevision: 1,
			recommendation: null,
			model: "fixture",
		});
		let commits = 0;
		let publication = {
			job: execution().job as BackgroundJob,
			artifact,
			commit: async () => {
				commits++;
			},
		};
		await definition.publish!(publication);
		expect(commits).toBe(1);
		change({ ...input(), key: `sha256:${"b".repeat(64)}` });
		await expect(definition.publish!(publication)).rejects.toThrow("recommendation-stale");
		expect(commits).toBe(1);
	});

	it("refuses a context change during analysis, including discussion changes at one document revision", async () => {
		let { definition, change } = fixture(async () => {
			change({ ...input(), key: `sha256:${"b".repeat(64)}` });
			return result();
		});
		await expect(definition.execute(execution())).rejects.toThrow("recommendation-stale");
	});

	it("refuses disappeared context and empty evidence without model spend", async () => {
		let calls = 0;
		let { definition, change } = fixture(async () => {
			calls++;
			return result();
		});
		change(undefined);
		await expect(definition.execute(execution())).rejects.toThrow("recommendation-unavailable");
		await expect(definition.execute(execution({ ...input(), evidence: [] }))).rejects.toThrow(
			"recommendation-evidence-unavailable",
		);
		expect(calls).toBe(0);
	});

	it("refuses invented evidence and a build with necessary unknowns", async () => {
		let { definition } = fixture(async () => ({
			...result(),
			recommendation: { ...result().recommendation, evidenceIds: ["made-up"] },
		}));
		await expect(definition.execute(execution())).rejects.toThrow("not supplied");
		let blocked = fixture(async () => ({
			...result(),
			recommendation: {
				...result().recommendation,
				dependencies: ["Verify required current behavior"],
			},
		}));
		await expect(blocked.definition.execute(execution())).rejects.toThrow(
			"unresolved dependencies",
		);
	});

	it("rechecks current context before its durable publication", async () => {
		let { definition, change } = fixture();
		let artifact = await definition.execute(execution());
		let commits = 0;
		let publication = {
			job: execution().job as BackgroundJob,
			artifact,
			commit: async () => {
				commits++;
			},
		};
		await definition.publish!(publication);
		expect(commits).toBe(1);
		change({ ...input(), key: `sha256:${"b".repeat(64)}` });
		await expect(definition.publish!(publication)).rejects.toThrow("recommendation-stale");
		expect(commits).toBe(1);
	});

	it("enforces owner authority even when the engine is injected", async () => {
		let calls = 0;
		let { definition } = fixture(async () => {
			calls++;
			return result();
		});
		await expect(definition.execute({ ...execution(), credential: { kind: "none" } })).rejects
			.toThrow("owner-unavailable");
		let revoked = execution();
		if (revoked.credential.kind !== "active-planner") throw new Error("fixture owner missing");
		await expect(
			definition.execute({
				...revoked,
				credential: { ...revoked.credential, authorize: async () => false },
			}),
		).rejects.toThrow("owner-unavailable");
		expect(calls).toBe(0);
	});

	it("refuses an owner revoked during analysis", async () => {
		let allowed = true;
		let { definition } = fixture(async () => {
			allowed = false;
			return result();
		});
		let run = execution();
		if (run.credential.kind !== "active-planner") throw new Error("fixture owner missing");
		await expect(
			definition.execute({
				...run,
				credential: { ...run.credential, authorize: async () => allowed },
			}),
		).rejects.toThrow("owner-unavailable");
	});

	it("refuses an expired owner or elapsed deadline before model spend", async () => {
		let calls = 0;
		let { definition } = fixture(async () => {
			calls++;
			return result();
		});
		let run = execution();
		if (run.credential.kind !== "active-planner") throw new Error("fixture owner missing");
		await expect(definition.execute({ ...run, deadline: new Date(0) })).rejects.toThrow(
			"recommendation-interrupted",
		);
		await expect(
			definition.execute({ ...run, credential: { ...run.credential, expiresAt: new Date(0) } }),
		).rejects.toThrow("owner-unavailable");
		expect(calls).toBe(0);
	});

	it("cancellation, owner signal and deadline interrupt an engine that never settles", async () => {
		for (let boundary of ["job", "owner", "deadline"]) {
			let started = Promise.withResolvers<void>();
			let { definition } = fixture(async () => {
				started.resolve();
				return new Promise(() => {});
			});
			let controller = new AbortController();
			let run = execution();
			if (run.credential.kind !== "active-planner") throw new Error("fixture owner missing");
			let pending = definition.execute({
				...run,
				...(boundary === "job" ? { signal: controller.signal } : {}),
				...(boundary === "owner"
					? { credential: { ...run.credential, signal: controller.signal } }
					: {}),
				...(boundary === "deadline" ? { deadline: new Date(Date.now() + 25) } : {}),
			});
			await started.promise;
			if (boundary !== "deadline") controller.abort();
			await expect(pending).rejects.toThrow("recommendation-interrupted");
		}
	});

	it("does not start a worker while the hosted agent is disabled", async () => {
		let calls = 0;
		let definition = buildRecommendationDefinition({
			config: { agent: false, model: "fixture" },
			current: async () => input(),
			engine: async () => {
				calls++;
				return result();
			},
		});
		await expect(definition.execute(execution())).rejects.toThrow("owner-unavailable");
		expect(calls).toBe(0);
	});
});
