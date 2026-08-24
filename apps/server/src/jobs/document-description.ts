import { parseDocumentDescriptionArtifact, parseDocumentSummaryInput } from "./document-summary";

import type { JobView } from "./service";
import type { ChannelRecord, Lease } from "../storage/model";
import type { StorageAdapter } from "../storage/port";

export type DocumentDescriptionProjectorOptions = {
	storage: StorageAdapter;
	lease: () => Lease;
	now?: () => Date;
	publish?: (channel: ChannelRecord) => void | Promise<void>;
};

/** Projects completed description artifacts into repository catalogue metadata. */
export class DocumentDescriptionProjector {
	#options: DocumentDescriptionProjectorOptions;

	constructor(options: DocumentDescriptionProjectorOptions) {
		this.#options = options;
	}

	async jobChanged(job: JobView): Promise<void> {
		if (job.type !== "document-summary" || job.version !== 1 || job.state !== "completed") return;
		let detail = await this.#options.storage.jobs.get(job.channelId, job.id);
		if (!detail || detail.job.state !== "completed" || !detail.artifact) return;
		if (detail.job.targetKey !== "document-summary:document") {
			throw new Error("Document description job has an unexpected target.");
		}
		let expected = parseDocumentSummaryInput(detail.job.input);
		let artifact = parseDocumentDescriptionArtifact(detail.artifact.value);
		if (!artifact) return;
		if (
			artifact.revision !== expected.revision
			|| artifact.sourceHash !== expected.sourceHash
			|| artifact.generatorVersion !== expected.generatorVersion
		) throw new Error("Document description artifact does not match its source request.");

		let result = await this.#options.storage.channels.publishDescription({
			channelId: job.channelId,
			description: artifact.description,
			planRevision: artifact.revision,
			sourceHash: artifact.sourceHash,
			generatorVersion: artifact.generatorVersion,
			jobId: job.id,
			now: this.#options.now?.() ?? new Date(),
			lease: this.#options.lease(),
		});
		if (result.changed) await this.#options.publish?.(result.channel);
	}
}
