import { JobExecutionError } from "../jobs/registry";
import {
	MAX_RECOMMENDATION_ARTIFACT_BYTES,
	MAX_RECOMMENDATION_INPUT_BYTES,
	parseRecommendationArtifact,
	parseRecommendationInput,
	RECOMMENDATION_AI_CREDITS,
} from "./schema";

import type { Config } from "../config";
import type { JobDefinition } from "../jobs/registry";
import type { RecommendationArtifact, RecommendationInput } from "./schema";
import type { RecommendationEngine } from "./worker";

export function buildRecommendationDefinition(options: {
	config: Pick<Config, "agent" | "model">;
	current: (channelId: string) => Promise<RecommendationInput | undefined>;
	engine?: RecommendationEngine;
}): JobDefinition<RecommendationInput, RecommendationArtifact> {
	let engine = options.engine ?? (async execution => {
		let { generateRecommendation } = await import("./worker");
		return generateRecommendation(options.config, execution);
	});
	let current = async (channelId: string, expected: RecommendationInput) => {
		let value = await options.current(channelId);
		if (!value) throw new JobExecutionError("recommendation-unavailable");
		if (value.key !== expected.key || value.planRevision !== expected.planRevision) {
			throw new JobExecutionError("recommendation-stale");
		}
	};
	return {
		type: "build-recommendation",
		version: 1,
		label: "Next useful build",
		description: "Proposes a small next build or the necessary uncertainty to resolve first.",
		origins: ["scheduler"],
		credential: "active-planner",
		limits: {
			timeoutMs: 60_000,
			maxAttempts: 2,
			maxAiCredits: RECOMMENDATION_AI_CREDITS,
			maxInputBytes: MAX_RECOMMENDATION_INPUT_BYTES,
			maxArtifactBytes: MAX_RECOMMENDATION_ARTIFACT_BYTES,
		},
		input: { parse: parseRecommendationInput },
		artifact: { parse: parseRecommendationArtifact },
		async execute(execution) {
			let input = parseRecommendationInput(execution.input);
			if (!input.evidence.length) {
				throw new JobExecutionError("recommendation-evidence-unavailable");
			}
			if (!options.config.agent || execution.credential.kind !== "active-planner") {
				throw new JobExecutionError("recommendation-owner-unavailable");
			}
			let credential = execution.credential;
			let signal = AbortSignal.any([
				execution.signal,
				...(credential.signal ? [credential.signal] : []),
				AbortSignal.timeout(Math.max(1, execution.deadline.getTime() - Date.now())),
				AbortSignal.timeout(Math.max(1, credential.expiresAt.getTime() - Date.now())),
			]);
			let stop!: () => void;
			let aborted = new Promise<never>((_, reject) => {
				stop = () => reject(new JobExecutionError("recommendation-interrupted"));
				if (signal.aborted) stop();
				else signal.addEventListener("abort", stop, { once: true });
			});
			try {
				let check = async () => {
					if (signal.aborted || execution.deadline.getTime() <= Date.now()) {
						throw new JobExecutionError("recommendation-interrupted");
					}
					if (!await credential.authorize() || credential.expiresAt.getTime() <= Date.now()) {
						throw new JobExecutionError("recommendation-owner-unavailable");
					}
				};
				await Promise.race([check(), aborted]);
				await Promise.race([current(execution.job.channelId, input), aborted]);
				let result = await Promise.race([engine({ ...execution, input, signal }), aborted]);
				await Promise.race([check(), aborted]);
				await Promise.race([current(execution.job.channelId, input), aborted]);
				return parseRecommendationArtifact({
					...result,
					key: input.key,
					planRevision: input.planRevision,
				}, input);
			} finally {
				signal.removeEventListener("abort", stop);
			}
		},
		async publish({ job, artifact, commit }) {
			let input = parseRecommendationInput(job.input);
			parseRecommendationArtifact(artifact, input);
			await current(job.channelId, input);
			await commit();
		},
	};
}
