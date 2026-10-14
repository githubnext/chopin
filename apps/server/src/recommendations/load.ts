import { exclusive, implementationActive } from "../plan/service";
import { recommendationContext } from "./context";

import type { Investigation } from "@chopin/experiment/records";
import type { DocumentTarget, Plan } from "../plan/service";
import type { StorageAdapter } from "../storage/port";

export function createRecommendationLoader(options: {
	storage: StorageAdapter;
	withPlan<T>(id: string, action: (plan: Plan) => Promise<T>): Promise<T>;
	document: (id: string) => Promise<DocumentTarget | undefined>;
	investigations: (id: string) => Promise<Investigation[]>;
	unavailable: (id: string) => boolean;
}) {
	return async (id: string) => {
		if (options.unavailable(id)) return;
		let channel = await options.storage.channels.get(id);
		if (!channel || channel.archivedAt || channel.parentChannelId) return;
		let document = await options.withPlan(id, plan =>
			exclusive(plan, async () => {
				if (implementationActive(plan) || plan.builds.length || plan.live) return;
				return {
					source: plan.persistence.committedSource,
					sidecar: structuredClone(plan.persistence.committedSidecar),
				};
			}));
		if (!document) return;
		let [investigations, requests] = await Promise.all([
			options.investigations(id),
			options.storage.research.list(id, 100, true),
		]);
		let research = [];
		for (let request of requests.filter(item => item.publishedChannelId)) {
			let child = await options.storage.channels.get(request.publishedChannelId!);
			if (
				!child || child.archivedAt || child.parentChannelId !== id
				|| child.repositoryId !== channel.repositoryId
			) continue;
			let target = await options.document(child.id);
			if (target) {
				research.push({
					id: child.id,
					title: child.title,
					source: target.source,
					revision: target.revision,
				});
				if (research.length === 4) break;
			}
		}
		if (options.unavailable(id)) return;
		return recommendationContext(document, investigations, research);
	};
}
