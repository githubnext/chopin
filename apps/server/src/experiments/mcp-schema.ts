import { z } from "zod";
import { resultSchema } from "@chopin/experiment";
import { spikeSubmissionSchema } from "./spikes";

export function connectorSchemas(
	runScoped: boolean,
	spike = false,
): Record<string, z.ZodType<Record<string, unknown>>> {
	let claim = { id: z.string().uuid(), generation: z.number().int().positive() };
	if (runScoped) {
		return {
			read_experiment: z.object({}).strict(),
			read_investigation: z.object({}).strict(),
			submit_experiment_result: z.object({ result: resultSchema }).strict(),
			submit_investigation_result: z.object({ result: resultSchema }).strict(),
			upload_investigation_image: z.object({
				data: z.string().min(1),
				mimeType: z.string().max(40),
			}).strict(),
			...(spike ? { submit_spike_result: spikeSubmissionSchema } : {}),
		};
	}
	return {
		disconnect_workspace: z.object({}).strict(),
		wait_for_experiment: z.object({}).strict(),
		claim_experiment: z.object({ id: z.string().uuid() }).strict(),
		renew_experiment: z.object({ ...claim, progress: z.string().max(2000).optional() }).strict(),
		read_experiment: z.object(claim).strict(),
		submit_experiment_result: z.object({ ...claim, result: resultSchema }).strict(),
		complete_experiment: z.object(claim).strict(),
		fail_experiment: z.object({ ...claim, error: z.string().max(2000) }).strict(),
	};
}
