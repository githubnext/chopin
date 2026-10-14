import type { Config } from "../config";
import { type JobDefinition, JobExecutionError } from "../jobs/registry";
import {
	DOCUMENT_DEVELOPMENT_MAX_INPUT_BYTES,
	type DocumentDevelopmentArtifact,
	type DocumentDevelopmentInput,
	parseDocumentDevelopmentArtifact,
	parseDocumentDevelopmentInput,
	parseDocumentDevelopmentOutput,
} from "./schema";
import {
	DOCUMENT_DEVELOPMENT_CREDITS,
	type DocumentDevelopmentEngine,
	generateDocumentDevelopment,
} from "./worker";

export function documentDevelopmentDefinition(options: {
	config: Pick<Config, "agent" | "model">;
	engine?: DocumentDevelopmentEngine;
}): JobDefinition<DocumentDevelopmentInput, DocumentDevelopmentArtifact> {
	return {
		type: "document-development",
		version: 1,
		label: "Document development",
		description: "Develops provisional generated passages from the current human discussion.",
		origins: ["scheduler"],
		credential: "active-planner",
		limits: {
			timeoutMs: 60_000,
			maxAttempts: 1,
			maxAiCredits: DOCUMENT_DEVELOPMENT_CREDITS,
			maxInputBytes: DOCUMENT_DEVELOPMENT_MAX_INPUT_BYTES,
			maxArtifactBytes: 16 * 1024,
		},
		input: { parse: parseDocumentDevelopmentInput },
		artifact: { parse: parseDocumentDevelopmentArtifact },
		async execute(execution) {
			// Keep a host-owned snapshot even when a deterministic test engine mutates its input.
			let input = parseDocumentDevelopmentInput(execution.input);
			let result = await (options.engine
				? options.engine({ ...execution, input: structuredClone(input) })
				: generateDocumentDevelopment(options.config, { ...execution, input }));
			try {
				let output = parseDocumentDevelopmentArtifact({
					...result,
					messageId: input.messageId,
					revision: input.revision,
					decisionHash: input.decisionHash,
				});
				parseDocumentDevelopmentOutput(
					{ changes: output.changes, removals: output.removals },
					input,
				);
				return output;
			} catch {
				throw new JobExecutionError("document-development-output-invalid");
			}
		},
	};
}
