import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	githubEnvironment,
	githubExpired,
	githubRefusal,
	GitHubRefused,
	githubToken,
	inheritsGitHub,
	withoutGitHub,
} from "./github-token";
import { BOT, STARTER } from "./testing/github-grant";

const MACHINE = `chopin_m_${"M".repeat(43)}`;

/**
 * A Chopin whose github-token route answers each request with the next of `answers` (the last
 * repeats) and records what it was asked.
 */
function chopin(answers: Array<() => Response>) {
	let asked: unknown[] = [];
	let server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			if (new URL(request.url).pathname !== "/api/connector/github-token") {
				return new Response(null, { status: 404 });
			}
			expect(request.headers.get("authorization")).toBe(`Bearer ${MACHINE}`);
			asked.push(await request.json());
			let answer = answers[Math.min(asked.length - 1, answers.length - 1)]!;
			return answer();
		},
	});
	return { url: `http://127.0.0.1:${server.port}`, asked, stop: () => server.stop(true) };
}

let issued = (token: string, expiresAt = Date.now() + 3_600_000) => () =>
	Response.json({
		token,
		expiresAt,
		kind: "installation",
		permissions: { contents: "write", pull_requests: "write", metadata: "read" },
		identity: BOT,
		starter: STARTER,
	});

/** git with only `global` as the person's configuration, under `env`. */
function git(cwd: string, global: string, env: Record<string, string>, ...args: string[]) {
	return spawnSync("git", args, {
		cwd,
		encoding: "utf8",
		input: args[0] === "credential" ? "protocol=https\nhost=github.com\n\n" : undefined,
		env: {
			PATH: process.env.PATH,
			HOME: global.replace(/\/[^/]+$/, ""),
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_CONFIG_GLOBAL: global,
			...env,
		},
	});
}

test("a launch's token is asked for with what it is for, and gh and git read it, renewed, from the launch's own files", async () => {
	let first = `ghs_${"A".repeat(36)}`;
	let second = `ghs_${"B".repeat(36)}`;
	let server = chopin([issued(first, Date.now() + 1000), issued(second)]);
	let folder = await mkdtemp(join(tmpdir(), "chopin-github-token-"));
	try {
		let github = await githubToken({
			url: server.url,
			machine: MACHINE,
			repository: "org/repo",
			purpose: "run",
			run: "run-1",
			document: "doc-1",
			folder,
			// Due at once: the first token is replaced as soon as it is written.
			renewBeforeMs: 60_000,
		});
		expect(server.asked[0]).toEqual({
			repository: "org/repo",
			purpose: "run",
			run: "run-1",
			document: "doc-1",
		});
		expect(github.identity).toEqual(BOT);
		expect(github.starter).toEqual(STARTER);
		for (let i = 0; i < 100 && server.asked.length < 2; i++) await Bun.sleep(10);
		for (let i = 0; i < 100 && !(await readFile(github.file, "utf8")).includes(second); i++) {
			await Bun.sleep(10);
		}
		expect(await readFile(github.file, "utf8")).toBe(`${second}\n`);
		expect((await Bun.file(github.file).stat()).mode & 0o777).toBe(0o600);
		let env = githubEnvironment(github, "org/repo");
		// gh itself, as an agent runs it, finds the renewed token in the launch's configuration.
		if (Bun.which("gh")) {
			let gh = spawnSync("gh", ["auth", "token", "--hostname", "github.com"], {
				encoding: "utf8",
				env: { PATH: process.env.PATH, HOME: folder, ...env },
			});
			expect(gh.stdout.trim()).toBe(second);
		}
		// git is shown it for github.com, whatever helper the person's configuration names.
		let global = join(folder, "gitconfig");
		await writeFile(global, `[credential]\n\thelper = "!echo password=theirs; :"\n`);
		let filled = git(folder, global, env, "credential", "fill");
		expect(filled.stdout).toContain(`password=${second}\n`);
		expect(filled.stdout).not.toContain("theirs");
		expect(github.secrets()).toEqual([first, second]);
		await github.stop();
		expect(existsSync(github.file)).toBe(false);
		expect(existsSync(github.config)).toBe(false);
	} finally {
		server.stop();
		await rm(folder, { recursive: true, force: true });
	}
});

test("every refusal stops the launch before anything starts, naming the repository and never the machine's own login", async () => {
	for (
		let code of [
			"repository-forbidden",
			"app-cannot-push",
			"starter-cannot-push",
			"run-unknown",
			"no-grant",
		]
	) {
		let server = chopin([
			() => Response.json({ error: code, message: `refused for org/repo` }, { status: 403 }),
		]);
		let folder = await mkdtemp(join(tmpdir(), "chopin-github-refused-"));
		try {
			let asking = githubToken({
				url: server.url,
				machine: MACHINE,
				repository: "org/repo",
				purpose: "planner",
				document: "doc-1",
				folder,
			});
			await expect(asking).rejects.toBeInstanceOf(GitHubRefused);
			await expect(asking).rejects.toThrow(githubRefusal(code, "org/repo"));
			expect(githubRefusal(code, "org/repo")).toContain("org/repo");
			expect(githubRefusal(code, "org/repo")).not.toContain("uses its own GitHub login");
			// Nothing was written for a launch to find.
			expect(existsSync(join(folder, "github"))).toBe(false);
			expect(existsSync(join(folder, "gh"))).toBe(false);
		} finally {
			server.stop();
			await rm(folder, { recursive: true, force: true });
		}
	}
});

test("a token that expires without a renewal is removed, and what used it hears why", async () => {
	let server = chopin([
		issued(`ghs_${"C".repeat(36)}`, Date.now() + 150),
		() => new Response("unavailable", { status: 503 }),
	]);
	let folder = await mkdtemp(join(tmpdir(), "chopin-github-lapse-"));
	try {
		let github = await githubToken({
			url: server.url,
			machine: MACHINE,
			repository: "org/repo",
			purpose: "run",
			run: "run-1",
			folder,
			renewBeforeMs: 100,
		});
		for (let i = 0; i < 300 && !github.expired.aborted; i++) await Bun.sleep(10);
		expect(github.expired.aborted).toBe(true);
		expect((github.expired.reason as Error).message).toBe(githubExpired("org/repo"));
		expect(existsSync(github.file)).toBe(false);
		expect(existsSync(join(github.config, "hosts.yml"))).toBe(false);
		await github.stop();
	} finally {
		server.stop();
		await rm(folder, { recursive: true, force: true });
	}
});

test("a launch inherits none of the machine's GitHub setup, and keeps everything else", () => {
	let inherited = {
		PATH: "/usr/bin",
		HOME: "/home/person",
		GH_TOKEN: "decoy",
		GH_HOST: "github.example",
		GH_ENTERPRISE_TOKEN: "decoy",
		GH_CONFIG_DIR: "/home/person/.config/gh",
		GITHUB_TOKEN: "decoy",
		GITHUB_ENTERPRISE_TOKEN: "decoy",
		GIT_ASKPASS: "/usr/bin/askpass",
		SSH_ASKPASS: "/usr/bin/askpass",
		SSH_AUTH_SOCK: "/tmp/agent.sock",
		GIT_SSH: "ssh",
		GIT_SSH_COMMAND: "ssh -i key",
		GIT_CONFIG_COUNT: "1",
		GIT_CONFIG_KEY_0: "credential.helper",
		GIT_CONFIG_VALUE_0: "store",
		GIT_CONFIG_GLOBAL: "/home/person/.gitconfig",
		GIT_AUTHOR_EMAIL: "person@example.test",
		COPILOT_GITHUB_TOKEN: "model-login",
		CHOPIN_URL: "https://chopin.example",
	};
	expect(withoutGitHub(inherited)).toEqual({
		PATH: "/usr/bin",
		HOME: "/home/person",
		// A model provider's own login is the agent's, not a way to the repository.
		COPILOT_GITHUB_TOKEN: "model-login",
		CHOPIN_URL: "https://chopin.example",
	});
	expect(inheritsGitHub("gh_token")).toBe(true);
});

test.skipIf(process.platform === "win32")(
	"under a launch's environment, a commit is made as Chopin's App, unsigned, and the repository's SSH address goes over https, whatever the person's configuration says",
	async () => {
		let folder = await mkdtemp(join(tmpdir(), "chopin-github-identity-"));
		try {
			let helper = join(folder, "helper-ran");
			let global = join(folder, "gitconfig");
			await writeFile(
				global,
				[
					"[user]",
					"\tname = Decoy Person",
					"\temail = decoy@example.test",
					"[commit]",
					"\tgpgsign = true",
					"[tag]",
					"\tgpgsign = true",
					"[gpg]",
					"\tprogram = /bin/false",
					"[credential]",
					`\thelper = "!touch '${helper}'; echo password=theirs; :"`,
					'[url "git@github.com:"]',
					"\tinsteadOf = https://github.com/",
					"\tpushInsteadOf = https://github.com/",
					"",
				].join("\n"),
			);
			let tokens = join(folder, "tokens");
			await mkdir(join(tokens, "gh"), { recursive: true });
			await writeFile(join(tokens, "github"), `ghs_${"D".repeat(36)}\n`);
			let env = githubEnvironment({
				token: `ghs_${"D".repeat(36)}`,
				expiresAt: Date.now() + 3_600_000,
				file: join(tokens, "github"),
				config: join(tokens, "gh"),
				identity: BOT,
				starter: STARTER,
				expired: new AbortController().signal,
				secrets: () => [],
				stop: async () => {},
			}, "org/repo");
			expect(env).toMatchObject({
				GH_CONFIG_DIR: join(tokens, "gh"),
				GIT_SSH_COMMAND: "false",
				CHOPIN_GITHUB_TOKEN_FILE: join(tokens, "github"),
				CHOPIN_STARTER_LOGIN: STARTER.login,
				CHOPIN_STARTER_NAME: STARTER.name,
				CHOPIN_STARTER_EMAIL: STARTER.email,
			});
			expect(Object.keys(env).filter(name => /^(GH|GITHUB)_TOKEN$/.test(name))).toEqual([]);
			let repo = join(folder, "repo");
			await mkdir(repo);
			git(repo, global, {}, "init", "-q");
			git(repo, global, {}, "remote", "add", "origin", "git@github.com:org/repo.git");
			let committed = git(repo, global, env, "commit", "-q", "--allow-empty", "-m", "change");
			expect(committed.stderr).toBe("");
			let made = git(repo, global, env, "log", "-1", "--format=%an <%ae>|%cn <%ce>|%G?");
			let bot = `${BOT.name} <${BOT.email}>`;
			expect(made.stdout.trim()).toBe(`${bot}|${bot}|N`);
			expect(git(repo, global, env, "remote", "get-url", "--push", "origin").stdout.trim())
				.toBe("https://github.com/org/repo.git");
			expect(git(repo, global, env, "credential", "fill").stdout).toContain(
				`password=ghs_${"D".repeat(36)}`,
			);
			expect(existsSync(helper)).toBe(false);
		} finally {
			await rm(folder, { recursive: true, force: true });
		}
	},
);
