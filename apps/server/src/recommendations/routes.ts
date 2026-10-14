import { AdmissionDenied } from "../auth/admission";
import { GitHubError } from "../github/client";

import type { RecommendationSnapshot } from "@chopin/protocol/recommendation";
import type { HostedAuth } from "../auth/routes";
import type { Router } from "../http/router";

/** Advice has no mutation endpoint: discussing it uses the ordinary authenticated Chat path. */
export function registerRecommendationRoutes(router: Router, auth: HostedAuth, options: {
	read: (id: string) => Promise<RecommendationSnapshot>;
	schedule: (id: string) => void;
}) {
	router.on("GET", "/api/channels/:id/recommendation", async (request, _url, { id }) => {
		let json = (value: unknown, status = 200) =>
			Response.json(value, {
				status,
				headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" },
			});
		try {
			let session = await auth.sessions.authenticate(request);
			if (!session) return json({ error: "authentication required" }, 401);
			let channel = await auth.storage.channels.get(id);
			if (!channel || channel.parentChannelId) return json({ error: "document not found" }, 404);
			let { value: repository } = await auth.sessions.use(
				session,
				token =>
					auth.github.repositoryAccess(token, channel.repositoryOwner, channel.repositoryName),
			);
			if (!repository?.permissions.pull || repository.id !== channel.repositoryId) {
				return json({ error: "document not found" }, 404);
			}
			if (channel.archivedAt) return json({ state: "unavailable" });
			// Viewing never lends a reader's credentials or starts a Planner turn.
			options.schedule(id);
			return json(await options.read(id));
		} catch (error) {
			if (error instanceof GitHubError) return json({ error: error.message }, error.status);
			if (error instanceof AdmissionDenied) return json({ error: error.message }, 403);
			console.error("chopin: recommendation read failed", error);
			return json({ error: "recommendation unavailable" }, 500);
		}
	});
}
