/**
 * Fake only GitHub's network boundary. OAuth state, PKCE, persistent sessions,
 * channel authorization and WebSocket admission still run in the real server.
 */
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

// A reader of octo-org/score whose access is whatever the file named for it says whenever GitHub is
// asked: "revoked" takes the repository away, "unavailable" answers as GitHub does when it cannot be
// reached, and anything else, or no file, leaves the access as it was. The test that owns the
// handle writes the file; the same path is made in e2e/reaction-access.e2e.ts.
const ACCESS_GATED = "gated-access-";

function accessGate(handle: string): string {
	return join(tmpdir(), "chopin-e2e-access", handle);
}

// People GitHub reports with less than the default access to the private
// octo-org/score: a reader may pull but not push, and an outsider cannot see it.
const SCORE_READER = "score-reader-";
const SCORE_OUTSIDER = "score-outsider-";
// Someone who shares a machine in a test sees one repository, a private one of their own, so the
// machine is listed to nobody else on the server: a shared machine serves every repository its
// owner can push to, and a teammate sees it wherever they can push to one too.
const MACHINE_SHARER = "machine-sharer-";

function sharerRepository(handle: string) {
	let name = `relay-${handle.slice(MACHINE_SHARER.length)}`;
	return {
		node_id: `R_${name}`,
		owner: { login: "octo-org", avatar_url: "https://example.invalid/octo-org.png" },
		name,
		full_name: `octo-org/${name}`,
		private: true,
		html_url: `https://github.com/octo-org/${name}`,
		default_branch: "main",
		permissions: { pull: true, push: true, admin: false },
	};
}

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
		// The App as Chopin defines it: machines push and open draft pull requests as their owner.
		permissions: {
			contents: "write",
			pull_requests: "write",
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
		let app = await asTheApp(url, authorization, init);
		if (app) return app;
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
		if (handle.startsWith(MACHINE_SHARER)) accessibleRepositories = [sharerRepository(handle)];
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
			if (handle.startsWith(ACCESS_GATED)) {
				let gate = (await readFile(accessGate(handle), "utf8").catch(() => "")).trim();
				if (gate === "unavailable") {
					return json({ message: "Service Unavailable" }, { status: 503 });
				}
				available = available.map(value => ({
					...value,
					permissions: {
						...value.permissions,
						pull: gate === "revoked" ? false : value.permissions.pull,
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
		// The head a machine with no checkout of octo-org/score clones.
		if (url.pathname === "/repos/octo-org/score/commits/main") return json({ sha: "b".repeat(40) });
		// A commit a Planner pushed for its plan's files: GitHub has every one but the zero SHA.
		let commit = /^\/repos\/octo-org\/score\/commits\/([0-9a-f]{40})$/.exec(url.pathname)?.[1];
		if (commit) {
			return commit === "0".repeat(40)
				? json({ message: `No commit found for SHA: ${commit}` }, { status: 422 })
				: json({ sha: commit });
		}
		// The files of octo-org/score, which a message can mention.
		if (url.pathname === "/repos/octo-org/score/git/trees/main") {
			return json({
				truncated: false,
				tree: [
					{ path: "README.md", type: "blob" },
					{ path: "docs", type: "tree" },
					{ path: "docs/design.md", type: "blob" },
					{ path: "src", type: "tree" },
					{ path: "src/index.ts", type: "blob" },
					{ path: "src/chat/composer.tsx", type: "blob" },
				],
			});
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

/** The e2e App's id, with the key playwright.config.ts gives the servers. */
const APP_ID = 4242;
const BOT = { login: "chopin-e2e[bot]", id: 4_242_000, node_id: "BOT_chopin_e2e" };
let mintedTokens = 0;

/**
 * GitHub as Chopin's GitHub App sees it: the App (by its JWT) finds its installation on an
 * octo-org repository and mints a token for it, and that token reads who may push there and who
 * a login is. Every octo-org repository has the App installed with Contents and Pull requests
 * write, and a person may push wherever the list above says they may.
 */
async function asTheApp(url: URL, authorization: string, init?: RequestInit) {
	let jwt = /^Bearer (ey[\w-]+\.[\w-]+\.[\w-]+)$/.exec(authorization)?.[1];
	if (jwt) {
		let claims = JSON.parse(Buffer.from(jwt.split(".")[1]!, "base64url").toString()) as {
			iss?: unknown;
		};
		if (String(claims.iss) !== String(APP_ID)) {
			return json({ message: "Bad credentials" }, { status: 401 });
		}
		let installed = /^\/repos\/octo-org\/[\w.-]+\/installation$/.test(url.pathname);
		if (installed) {
			return json({
				id: 101,
				suspended_at: null,
				permissions: { contents: "write", pull_requests: "write", metadata: "read" },
			});
		}
		if (url.pathname === "/app/installations/101/access_tokens" && init?.method === "POST") {
			let asked = JSON.parse(String(init.body ?? "{}")) as { permissions?: unknown };
			return json({
				token: `ghs_e2e_app_${++mintedTokens}`,
				expires_at: new Date(Date.now() + 3_600_000).toISOString(),
				permissions: asked.permissions ?? {},
			}, { status: 201 });
		}
		return json({ message: "Not Found" }, { status: 404 });
	}
	if (!/^Bearer ghs_e2e_app_\d+$/.test(authorization)) return undefined;
	if (url.pathname === "/installation/token") return new Response(null, { status: 204 });
	let user = /^\/users\/([^/]+)$/.exec(url.pathname)?.[1];
	if (user) {
		let login = decodeURIComponent(user);
		if (login === BOT.login) return json({ ...BOT, name: null });
		return json({
			login,
			id: [...login].reduce((sum, character) => sum * 31 + character.charCodeAt(0) | 0, 7) >>> 0,
			node_id: `U_${login}`,
			name: null,
		});
	}
	let permission = /^\/repos\/octo-org\/([\w.-]+)\/collaborators\/([^/]+)\/permission$/.exec(
		url.pathname,
	);
	if (permission) {
		let login = decodeURIComponent(permission[2]!);
		let push = !login.startsWith(SCORE_READER) && !login.startsWith(SCORE_OUTSIDER)
			&& login !== "readonly";
		return json({ permission: push ? "write" : "read", user: { login, permissions: { push } } });
	}
	return json({ message: "Not Found" }, { status: 404 });
}
