import { createHash } from "node:crypto";
import { broadcast } from "../wire";
import { JobRegistry } from "../jobs/registry";
import { JobService } from "../jobs/service";
import { researchAnswerDefinition, researchEvidenceDefinition } from "../jobs/research-workspace";
import { ResearchWorkspaceService } from "../research/service";
import { REPORT } from "../research/test-support";
import * as Plan from "../plan/service";
import type { headingMemory } from "../chat/job-heading-memory.test-fixtures";

async function evidence() {
	return { findings: [], sources: [] };
}
async function privateEvidence() {
	return { findings: [] };
}
async function report() {
	return REPORT;
}
async function answer() {
	return { text: "Offline answer", sourceUrls: [] };
}

export function researchStorage(h: Awaited<ReturnType<typeof headingMemory>>) {
	let jobs = new JobService({
		storage: h.opened.storage,
		registry: new JobRegistry([
			researchEvidenceDefinition({ config: { agent: true, model: "offline" }, engine: evidence }),
			researchAnswerDefinition({
				config: { agent: true, model: "offline" },
				engines: { private: privateEvidence, synthesize: report, answer },
			}),
		]),
		lease: () => h.opened.lease,
	});
	let research = new ResearchWorkspaceService({
		storage: h.opened.storage,
		jobs,
		lease: () => h.opened.lease,
		current: async () => ({
			channelId: h.plan.id,
			revision: h.plan.revision,
			source: Plan.source(h.plan),
			sourceHash: `sha256:${createHash("sha256").update(Plan.source(h.plan)).digest("hex")}`,
		}),
		publish: (channelId, workspaceId, revision) =>
			broadcast(h.opened.server, channelId, {
				kind: "research:changed",
				ts: 0,
				workspaceId,
				revision,
			}),
	});
	return { research, jobs };
}
