import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { GitHubToken } from "../github-token";
import type { GitHubAccount } from "../machine";

/** The App bot a test's GitHub token commits as. */
export const BOT: GitHubAccount = {
	login: "chopin-test[bot]",
	id: 1001,
	name: "chopin-test[bot]",
	email: "1001+chopin-test[bot]@users.noreply.github.com",
};

/** The person a test's run is for. */
export const STARTER: GitHubAccount = {
	login: "mona",
	id: 7,
	name: "Mona Lisa",
	email: "7+mona@users.noreply.github.com",
};

/**
 * A GitHub token as Chopin gives one, without asking a server: written to `folder` as `githubToken`
 * writes it, the token file and gh's configuration, and gone again on `stop`.
 */
export async function testGitHubToken(
	folder: string,
	token = `ghs_${"T".repeat(36)}`,
): Promise<GitHubToken> {
	let file = join(folder, "github");
	let config = join(folder, "gh");
	await mkdir(config, { recursive: true, mode: 0o700 });
	await writeFile(file, `${token}\n`, { mode: 0o600 });
	await writeFile(
		join(config, "hosts.yml"),
		`github.com:\n    oauth_token: "${token}"\n    user: "${BOT.login}"\n    git_protocol: https\n`,
		{ mode: 0o600 },
	);
	return {
		token,
		expiresAt: Date.now() + 3_600_000,
		file,
		config,
		identity: BOT,
		starter: STARTER,
		expired: new AbortController().signal,
		secrets: () => [token],
		async stop() {
			await rm(file, { force: true });
			await rm(config, { recursive: true, force: true });
		},
	};
}

/**
 * What a Chopin with its GitHub App answers to a connector's asking for a launch's GitHub token or
 * its token for Chopin's tools; undefined for any other request.
 */
export async function answerTokens(
	request: Request,
	/** The refusal each named repository gets instead. */
	refusing: Record<string, string> = {},
): Promise<Response | undefined> {
	let { pathname } = new URL(request.url);
	if (pathname === "/api/connector/github-token") {
		let { repository } = await request.json() as { repository: string };
		let refused = refusing[repository];
		if (refused) return Response.json({ error: refused }, { status: 403 });
		return Response.json({
			token: `ghs_${"G".repeat(36)}`,
			expiresAt: Date.now() + 3_600_000,
			kind: "installation",
			identity: BOT,
			starter: STARTER,
		});
	}
	if (pathname === "/api/connector/mcp-token") {
		return Response.json({
			token: `chopin_mcp_${"T".repeat(43)}`,
			expiresAt: Date.now() + 900_000,
		});
	}
	return undefined;
}
