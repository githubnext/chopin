/**
 * Fake only GitHub's network boundary. OAuth state, PKCE, persistent sessions,
 * channel authorization and WebSocket admission still run in the real server.
 */
import { readFile } from "node:fs/promises";

let issuedCodes = new Map<string, string>();
let nextCode = 0;
let network = globalThis.fetch;

const repositories = [
	{
		node_id: "R_score",
		owner: { login: "octo-org", avatar_url: "https://example.invalid/octo-org.png" },
		name: "score",
		full_name: "octo-org/score",
		private: true,
		html_url: "https://github.com/octo-org/score",
		default_branch: "main",
		permissions: { pull: true, push: true, admin: false },
	},
	{
		node_id: "R_notes",
		owner: { login: "octocat", avatar_url: "https://example.invalid/octocat.png" },
		name: "notes",
		full_name: "octocat/notes",
		private: false,
		html_url: "https://github.com/octocat/notes",
		default_branch: "main",
		permissions: { pull: true, push: false, admin: false },
	},
	...Array.from({ length: 12 }, (_, index) => ({
		node_id: `R_archive_${index + 1}`,
		owner: { login: "octo-org", avatar_url: "https://example.invalid/octo-org.png" },
		name: `archive-${index + 1}`,
		full_name: `octo-org/archive-${index + 1}`,
		private: false,
		html_url: `https://github.com/octo-org/archive-${index + 1}`,
		default_branch: "main",
		permissions: { pull: true, push: false, admin: false },
	})),
];

const CREATOR_WRITABLE = new Set(["archive-1", "archive-8", "archive-9"]);

// People GitHub reports with less than the default access to the private
// octo-org/score: a reader may pull but not push, and an outsider cannot see it.
const SCORE_READER = "score-reader-";
const SCORE_OUTSIDER = "score-outsider-";

const installations = [
	{
		id: 101,
		account: {
			login: "octo-org",
			avatar_url: "https://example.invalid/octo-org.png",
			type: "Organization",
		},
		repository_selection: "selected",
		html_url: "https://github.com/settings/installations/101",
		suspended_at: null,
		permissions: {
			contents: "read",
			pull_requests: "read",
			checks: "read",
			statuses: "read",
			issues: "read",
		},
	},
	{
		id: 102,
		account: {
			login: "octocat",
			avatar_url: "https://example.invalid/octocat.png",
			type: "User",
		},
		repository_selection: "selected",
		html_url: "https://github.com/settings/installations/102",
		suspended_at: null,
		permissions: {
			contents: "read",
			pull_requests: "read",
			checks: "read",
			statuses: "read",
			issues: "read",
		},
	},
];

const referenceAuthor = {
	login: "octocat",
	avatar_url: "https://example.invalid/octocat.png",
};

function referenceFixture(number: number, title: string, closed: boolean) {
	return {
		number,
		title,
		user: referenceAuthor,
		labels: [{ name: "documents", color: "0e8a16" }],
		comments: number,
		created_at: "2026-09-01T12:00:00Z",
		updated_at: "2026-09-02T12:00:00Z",
		closed_at: closed ? "2026-09-02T12:00:00Z" : null,
	};
}

function pullFixture(
	number: number,
	title: string,
	state: "open" | "closed",
	options: { merged?: boolean; draft?: boolean } = {},
) {
	return {
		...referenceFixture(number, title, state === "closed"),
		state,
		draft: options.draft ?? false,
		merged_at: options.merged ? "2026-09-02T12:00:00Z" : null,
		head: { ref: `topic-${number}` },
		base: { ref: "main" },
	};
}

function issueFixture(
	number: number,
	title: string,
	state: "open" | "closed",
	reason: "completed" | "not_planned" | null,
) {
	return { ...referenceFixture(number, title, state === "closed"), state, state_reason: reason };
}

// Pull requests and issues in octo-org/score for GitHub reference pills.
const references = new Map<string, unknown>([
	["pulls/1", pullFixture(1, "Add document outline", "open")],
	["pulls/2", pullFixture(2, "Render decision cards", "closed", { merged: true })],
	["pulls/3", pullFixture(3, "Try a sidebar rewrite", "closed")],
	["pulls/4", pullFixture(4, "Draft link pills", "open", { draft: true })],
	["issues/5", issueFixture(5, "Links lose their context", "open", null)],
	["issues/6", issueFixture(6, "Outline jumps on load", "closed", "completed")],
	["issues/7", issueFixture(7, "Support GitLab links", "closed", "not_planned")],
]);

// One synthetic principal models an App permission being revoked after socket
// admission. The test invalidates the same access cache a real setup callback
// invalidates before asking the server to recheck this identity.
const revokedViewerRepositoryReads = new Map<string, number>();

function json(value: unknown, init: ResponseInit = {}): Response {
	return Response.json(value, init);
}

let fake = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
	let url = new URL(input instanceof Request ? input.url : input);
	if (url.href === "https://github.com/login/device/code" && process.env.AUTH_MODE === "local") {
		let code = `E2E-${String(++nextCode).padStart(4, "0")}`;
		let privateCode = crypto.randomUUID();
		issuedCodes.set(privateCode, code);
		return json({
			device_code: privateCode,
			user_code: code,
			verification_uri: "https://github.com/login/device",
			expires_in: 900,
			interval: 1,
		});
	}
	if (url.href === "https://github.com/login/oauth/access_token") {
		let body = new URLSearchParams(String(init?.body ?? ""));
		let refreshing = body.get("grant_type") === "refresh_token";
		if (body.get("grant_type") === "urn:ietf:params:oauth:grant-type:device_code") {
			let code = issuedCodes.get(body.get("device_code") ?? "");
			let approved = await readFile(process.env.E2E_DEVICE_APPROVAL_FILE!, "utf8").catch(() => "");
			if (!code || approved.trim() !== code) return json({ error: "authorization_pending" });
			issuedCodes.delete(body.get("device_code")!);
			return json({
				access_token: "ghu_e2e_octocat_1",
				expires_in: 28_800,
				refresh_token: "ghr_e2e_octocat_1",
				refresh_token_expires_in: 15_897_600,
				token_type: "bearer",
			});
		}
		let refreshed = /^ghr_e2e_(.+)_(\d+)$/.exec(body.get("refresh_token") ?? "");
		if (refreshing && !refreshed) return json({ error: "bad_refresh_token" });
		let handle = refreshing
			? refreshed![1]!
			: (body.get("code") ?? "e2e-person").replace(/^e2e-/, "");
		if (refreshing && handle === "expired") return json({ error: "bad_refresh_token" });
		let revision = refreshing ? Number(refreshed![2]) + 1 : 1;
		return json({
			access_token: `ghu_e2e_${handle}_${revision}`,
			expires_in: 28_800,
			refresh_token: `ghr_e2e_${handle}_${revision}`,
			refresh_token_expires_in: 15_897_600,
			token_type: "bearer",
		});
	}
	if (url.origin === "https://api.github.com") {
		let requestHeaders = new Headers(init?.headers);
		let authorization = requestHeaders.get("authorization") ?? "";
		let authorized = /^Bearer ghu_e2e_(.+)_\d+$/.exec(authorization);
		if (!authorized) return json({ message: "Bad credentials" }, { status: 401 });
		let handle = authorized[1]!;
		let accessibleRepositories = repositories.flatMap(repository => {
			if (handle.startsWith(SCORE_OUTSIDER) && repository.name === "score") return [];
			if (handle.startsWith(SCORE_READER) && repository.name === "score") {
				return [{ ...repository, permissions: { ...repository.permissions, push: false } }];
			}
			return handle.startsWith("document-creator-") && CREATOR_WRITABLE.has(repository.name)
				? [{ ...repository, permissions: { ...repository.permissions, push: true } }]
				: [repository];
		});
		let tagged = (value: unknown, etag: string, responseInit: ResponseInit = {}) => {
			let headers = new Headers(responseInit.headers);
			headers.set("etag", etag);
			if (requestHeaders.get("if-none-match") === etag) {
				return new Response(null, { status: 304, headers });
			}
			return json(value, { ...responseInit, headers });
		};
		if (url.pathname === "/user") {
			return json({
				node_id: `U_${handle}`,
				login: handle,
				avatar_url: `https://example.invalid/${handle}.png`,
			});
		}
		if (url.pathname === "/user/memberships/orgs/githubnext") {
			if (handle === "outsider") return json({ message: "Not Found" }, { status: 404 });
			return json({
				state: handle === "pending" ? "pending" : "active",
				role: "member",
			});
		}
		if (handle === "expired") return json({ message: "Bad credentials" }, { status: 401 });
		if (url.pathname === "/user/installations") {
			return tagged({ installations }, `"installations-${handle}"`);
		}
		if (url.pathname === "/user/installations/101/repositories") {
			let available = accessibleRepositories.filter(value => value.owner.login === "octo-org");
			if (handle === "readonly") {
				available = available.map(value => ({
					...value,
					permissions: { ...value.permissions, push: false },
				}));
			}
			if (handle.startsWith("revoked-after-admission-")) {
				let reads = revokedViewerRepositoryReads.get(handle) ?? 0;
				revokedViewerRepositoryReads.set(handle, reads + 1);
				available = available.map(value => ({
					...value,
					permissions: {
						...value.permissions,
						pull: value.name === "score" ? reads === 0 : value.permissions.pull,
						push: false,
					},
				}));
			}
			if (handle === "paged" && url.searchParams.get("page") !== "2") {
				return tagged(
					{ repositories: available.slice(0, 1) },
					`"repositories-${handle}-101-1"`,
					{
						headers: {
							link:
								'<https://api.github.com/user/installations/101/repositories?per_page=100&page=2>; rel="next"',
						},
					},
				);
			}
			return tagged(
				{ repositories: handle === "paged" ? available.slice(1) : available },
				`"repositories-${handle}-101-${url.searchParams.get("page") ?? "1"}"`,
			);
		}
		if (url.pathname === "/user/installations/102/repositories") {
			return tagged(
				{ repositories: accessibleRepositories.filter(value => value.owner.login === "octocat") },
				`"repositories-${handle}-102-${url.searchParams.get("page") ?? "1"}"`,
			);
		}
		let reference = /^\/repos\/octo-org\/score\/((?:pulls|issues)\/\d+)$/.exec(url.pathname);
		let summary = reference && references.get(reference[1]!);
		if (summary) return tagged(summary, `"reference-${reference![1]}"`);
		let repository = accessibleRepositories.find(value =>
			url.pathname === `/repos/${value.full_name}`
		);
		if (repository) return json(repository);
		return json({ message: "Not Found" }, { status: 404 });
	}
	return network(input, init);
};
globalThis.fetch = Object.assign(fake, { preconnect: network.preconnect });
