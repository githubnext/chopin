import { Machines } from "../auth/machines";
import { describe, expect, it } from "bun:test";

import { Sessions } from "../auth/session";
import { Admission } from "../auth/admission";
import { GitHubError } from "../github/client";
import { MemoryStorage } from "../storage/memory/adapter";
import { admit } from "./admission";

import type { HostedAuth } from "../auth/routes";
import type {
	GitHub,
	GitHubTokenGrant,
	GitHubUser,
	InstallationPage,
	Repository,
	RepositoryPage,
} from "../github/client";

class FakeGitHub implements GitHub {
	repositoryId = "R_score";
	push = false;
	failure: number | undefined;

	authorize(): string {
		return "";
	}

	async exchange(): Promise<GitHubTokenGrant> {
		return grant("ghu_user");
	}

	async refresh(): Promise<GitHubTokenGrant> {
		return grant("ghu_refreshed");
	}

	async user(): Promise<GitHubUser> {
		return { id: "U_octocat", login: "octocat", avatarUrl: "avatar" };
	}

	async organizationMembership() {
		return undefined;
	}

	async installations(): Promise<InstallationPage> {
		return { installations: [], nextPage: undefined };
	}

	async installationRepositories(): Promise<RepositoryPage> {
		return { repositories: [], nextPage: undefined };
	}

	async repository(_token: string, owner: string, name: string): Promise<Repository> {
		return {
			id: this.repositoryId,
			owner,
			name,
			fullName: `${owner}/${name}`,
			private: true,
			url: "",
			defaultBranch: "main",
			permissions: { pull: true, push: this.push, admin: false },
		};
	}

	async repositoryAccess(token: string, owner: string, name: string): Promise<Repository> {
		if (this.failure) throw new GitHubError("unavailable", this.failure);
		return this.repository(token, owner, name);
	}

	invalidate(): void {}
}

function grant(accessToken: string): GitHubTokenGrant {
	return {
		accessToken,
		accessExpiresIn: 28_800,
		refreshToken: "ghr_user",
		refreshExpiresIn: 15_897_600,
	};
}

function pair(cookie: string): string {
	return cookie.split(";", 1)[0]!;
}

async function setup(demoPersonas: boolean) {
	let now = new Date("2026-08-13T12:00:00.000Z");
	let storage = new MemoryStorage();
	await storage.users.put({ id: "U_octocat", login: "octocat", avatarUrl: "avatar", now });
	let sessions = new Sessions(storage, true, () => now);
	let issued = await sessions.issue("U_octocat", grant("ghu_user"));
	let channel = await storage.channels.create({
		id: crypto.randomUUID(),
		repositoryId: "R_score",
		repositoryOwner: "octo-org",
		repositoryName: "score",
		title: "Plan",
		createdBy: "U_octocat",
		now,
	});
	let github = new FakeGitHub();
	let config = {
		origin: "https://chopin.test",
		appSlug: "chopin-test",
		clientId: "client",
		clientSecret: "secret",
		encryptionKey: new Uint8Array(32).fill(2),
		...(demoPersonas ? { demoPersonas: true as const } : {}),
	};
	let auth: HostedAuth = {
		config,
		storage,
		github,
		admission: new Admission(config, github, () => now.getTime()),
		sessions,
		clock: () => now,
		machines: new Machines(storage, () => new Date(), {
			origin: "https://chopin.test",
			clientId: "test",
		}),
		pairings: {},
	};
	let connect = (actor?: string[]) => {
		let url = new URL(`https://chopin.test/ws?channel=${channel.id}`);
		for (let value of actor ?? []) url.searchParams.append("actor", value);
		let request = new Request(url, {
			headers: { cookie: pair(issued.cookie), origin: "https://chopin.test" },
		});
		return admit(request, url, auth);
	};
	return { github, connect };
}

describe("socket admission of demo actors", () => {
	it("binds a rostered actor while the operator keeps principal and access", async () => {
		let { github, connect } = await setup(true);
		let plain = await connect();
		expect("data" in plain && plain.data.actor).toBeUndefined();
		let first = await connect(["demo:lily"]);
		expect("data" in first && first.data).toMatchObject({
			handle: "demo:lily",
			actor: { id: "demo:lily", name: "Lily" },
			principalId: "U_octocat",
			canEdit: false,
		});
		github.push = true;
		let reconnect = await connect(["demo:lily"]);
		expect("data" in reconnect && reconnect.data).toMatchObject({
			handle: "demo:lily",
			principalId: "U_octocat",
			canEdit: true,
			canManage: true,
		});
		github.repositoryId = "R_other";
		expect(await connect(["demo:lily"])).toEqual({ status: 404, reason: "channel not found" });
	});

	it("rejects unknown and repeated actors on first connection and reconnect", async () => {
		let { connect } = await setup(true);
		let refusal = { status: 403, reason: "actor is not allowed" };
		expect(await connect(["demo:nobody"])).toEqual(refusal);
		expect(await connect(["octocat"])).toEqual(refusal);
		expect(await connect([""])).toEqual(refusal);
		expect(await connect(["demo:lily", "demo:felix"])).toEqual(refusal);
		expect("data" in await connect(["demo:felix"])).toBe(true);
		expect(await connect(["demo:nobody"])).toEqual(refusal);
	});

	it("rejects any actor while the flag is off", async () => {
		let { connect } = await setup(false);
		expect(await connect(["demo:lily"])).toEqual({ status: 403, reason: "actor is not allowed" });
		let plain = await connect();
		expect("data" in plain && plain.data.handle).toBe("octocat");
	});
});
