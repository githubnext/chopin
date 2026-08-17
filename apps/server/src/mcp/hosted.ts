import { GitHubError } from "../github/client";
import * as Plan from "../plan/service";
import * as Rooms from "../rooms";

import type { HostedAuth } from "../auth/routes";
import type { GitHubUser } from "../github/client";
import type { McpOptions } from "../mcp";

export type HostedCaller = {
	oauthToken: string;
	user: GitHubUser;
};

const BEARER = new RegExp("^Bearer ([A-Za-z0-9._~+/-]+=*)$", "i");

/** Bind the backend-neutral MCP surface to hosted GitHub authentication. */
export function hosted(auth: HostedAuth): McpOptions<HostedCaller> {
	return {
		async caller(request) {
			let match = request.headers.get("authorization")?.match(BEARER);
			if (!match) return undefined;
			let oauthToken = match[1]!;
			try {
				return { oauthToken, user: await auth.github.user(oauthToken) };
			} catch (err) {
				if (err instanceof GitHubError && err.status === 401) return undefined;
				throw err;
			}
		},
		documents: {
			async list(caller, repository) {
				let parts = repository.split("/");
				if (parts.length !== 2 || !parts[0] || !parts[1]) return [];
				let resolved = await auth.github.repositoryAccess(
					caller.oauthToken,
					parts[0],
					parts[1],
				);
				if (!resolved?.permissions.pull) return [];

				let documents = [];
				let cursor;
				do {
					let page = await auth.storage.channels.scan(resolved.id, 100, cursor);
					documents.push(...page.channels.map(channel => ({
						id: channel.id,
						title: channel.title,
					})));
					cursor = page.next;
				} while (cursor);
				return documents;
			},
			async read(caller, id) {
				let channel = await auth.storage.channels.get(id);
				if (!channel) return undefined;
				let repository = await auth.github.repositoryAccess(
					caller.oauthToken,
					channel.repositoryOwner,
					channel.repositoryName,
				);
				if (
					!repository?.permissions.pull
					|| repository.id !== channel.repositoryId
				) return undefined;

				let live = Rooms.get(channel.id)?.plan;
				if (live) {
					try {
						return {
							id: channel.id,
							title: channel.title,
							source: Plan.source(live),
							revision: live.revision,
						};
					} catch {
						return undefined;
					}
				}

				let stored = await auth.storage.collaboration.load(channel.id, auth.clock());
				if (
					!stored
					|| stored.channel.id !== channel.id
					|| stored.channel.repositoryId !== channel.repositoryId
					|| stored.channel.repositoryOwner !== channel.repositoryOwner
					|| stored.channel.repositoryName !== channel.repositoryName
				) return undefined;
				try {
					let projected = await Plan.readStored(stored);
					return { id: channel.id, title: channel.title, ...projected };
				} catch {
					return undefined;
				}
			},
		},
	};
}
