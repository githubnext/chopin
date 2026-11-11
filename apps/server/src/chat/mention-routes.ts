import {
	DEFAULT_MENTION_SOURCES,
	MAX_MENTION_SOURCE_QUERY,
	MAX_MENTION_SOURCES,
} from "@chopin/protocol/mention-sources";

import { isChannelId } from "../channels/id";
import { GitHubError } from "../github/client";
import { documentPointers, matchPointers } from "./pointers";
import { matchFiles } from "./repository-files";

import type { MentionSources } from "@chopin/protocol/mention-sources";
import type { HostedAuth } from "../auth/routes";
import type { Router } from "../http/router";
import type { DocumentTarget } from "../plan/service";
import type { RepositoryFiles } from "./repository-files";

/** A reference's label, `@` and the path, holds at most this many characters less one. */
const MAX_FILE_TOKEN = 121;

export type MentionRouteOptions = {
	/** The document as it stands now. */
	current: (channelId: string) => Promise<DocumentTarget | undefined>;
	/** The titles of the document's research workspaces, by workspace id. */
	research: (channelId: string) => Promise<Array<{ id: string; title: string }>>;
	/** The files of the document's repository; absent where nothing lists them. */
	files?: RepositoryFiles;
};

function json(value: unknown, status = 200): Response {
	return Response.json(value, {
		status,
		headers: {
			"cache-control": "no-store",
			"referrer-policy": "no-referrer",
			"x-content-type-options": "nosniff",
		},
	});
}

/**
 * What a person can point at with `@` in a document they can read: its headings, Decisions and
 * research cards, and its repository's files. The list is the one a message's mentions are later
 * resolved against, and a person who cannot read the document is told it does not exist.
 */
export function registerMentionRoutes(
	router: Router,
	auth: HostedAuth,
	options: MentionRouteOptions,
): void {
	router.on("GET", "/api/channels/:channelId/mentions", async (request, url, params) => {
		try {
			let session = await auth.sessions.authenticate(request);
			if (!session) return json({ error: "authentication required" }, 401);
			let id = params.channelId!;
			if (!isChannelId(id)) return json({ error: "channel not found" }, 404);
			let channel = await auth.storage.channels.get(id);
			if (!channel) return json({ error: "channel not found" }, 404);
			let access = await auth.sessions.use(
				session,
				token =>
					auth.github.repositoryAccess(token, channel.repositoryOwner, channel.repositoryName),
			);
			let repository = access.value;
			if (
				!repository || repository.id !== channel.repositoryId || !repository.permissions.pull
			) return json({ error: "channel not found" }, 404);

			let query = url.searchParams.get("query") ?? "";
			let asked = Number(url.searchParams.get("limit") ?? DEFAULT_MENTION_SOURCES);
			if (
				query.length > MAX_MENTION_SOURCE_QUERY || !Number.isInteger(asked) || asked < 1
				|| asked > MAX_MENTION_SOURCES
			) return json({ error: "invalid mention query" }, 400);

			let document = await options.current(channel.id);
			let found = documentPointers(document?.source ?? "");
			let headings = matchPointers(found.headings.map(item => item.text), query, asked).map(index =>
				found.headings[index]!
			);
			let decisions = matchPointers(
				found.decisions.map(item => item.title || "Decision"),
				query,
				asked,
			).map(index => found.decisions[index]!);
			let placed = new Set(found.research);
			let workspaces = (await options.research(channel.id)).filter(item => placed.has(item.id));
			let research = matchPointers(workspaces.map(item => item.title), query, asked).map(index => ({
				workspaceId: workspaces[index]!.id,
				title: workspaces[index]!.title,
			}));
			let listing = await options.files?.list(channel.id, {
				id: repository.id,
				owner: repository.owner,
				name: repository.name,
				defaultBranch: repository.defaultBranch,
			}, access.authenticated.session.id);
			let body: MentionSources = {
				headings: headings.map(({ anchor, text, level }) => ({ anchor, text, level })),
				decisions: decisions.map(({ id, title }) => ({ id, title })),
				research,
				// A path a token cannot hold is not offered, since it could not be sent.
				...(listing
					? {
						files: matchFiles(
							listing.paths.filter(path => [...path].length < MAX_FILE_TOKEN),
							query,
							asked,
						),
					}
					: {}),
			};
			return json(body);
		} catch (error) {
			if (error instanceof GitHubError && error.status === 401) {
				return Response.json({ error: "GitHub authorization expired" }, {
					status: 401,
					headers: { "cache-control": "no-store", "set-cookie": auth.sessions.clearCookie() },
				});
			}
			console.error("[chat] could not list what can be mentioned:", error);
			return json({ error: "mentions are temporarily unavailable" }, 503);
		}
	});
}
