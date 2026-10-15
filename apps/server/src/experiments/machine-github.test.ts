import { describe, expect, it } from "bun:test";
import { ExperimentError } from "@chopin/experiment";

import { GITHUB_TOKEN_FRESH_MS, machineGitHubToken } from "./machine-github";

import type { InstalledRepository } from "../github/client";
import type { StoredMachine } from "../storage/model";

const MACHINE = { id: "M_1", userId: "U_1" } as StoredMachine;
const NOW = new Date("2026-10-14T12:00:00Z");

/** A machine whose grant expires `left` ms from now and refreshes to a token good for 8 hours. */
function machines(left: number) {
	let grant = { token: "ghu_current", expiresAt: new Date(NOW.getTime() + left) };
	let refreshed = 0;
	return {
		refreshed: () => refreshed,
		use: <T>(_machine: StoredMachine, operation: (token: string) => Promise<T>) =>
			operation(grant.token),
		access: async (_machine: StoredMachine, rejected?: string) => {
			if (rejected === grant.token) {
				refreshed++;
				grant = { token: "ghu_refreshed", expiresAt: new Date(NOW.getTime() + 8 * 3_600_000) };
			}
			return grant;
		},
	};
}

function installed(
	push: boolean,
	writable?: { contents: boolean; pullRequests: boolean },
): InstalledRepository {
	return {
		repository: { fullName: "octo-org/score", permissions: { pull: true, push, admin: false } },
		installation: { id: "1", ...(writable ? { writable } : {}) },
	} as InstalledRepository;
}

async function refused(promise: Promise<unknown>) {
	let error = await promise.then(() => undefined, (caught: unknown) => caught);
	expect(error).toBeInstanceOf(ExperimentError);
	return error as ExperimentError;
}

describe("a machine's GitHub token", () => {
	it("goes out for a repository its owner can push to through an App that can write", async () => {
		let held = machines(2 * 3_600_000);
		let asked: string[] = [];
		let token = await machineGitHubToken(
			{
				machines: held,
				github: {
					installedRepository: async (token: string, owner: string, name: string) => {
						asked.push(`${token} ${owner}/${name}`);
						return installed(true, { contents: true, pullRequests: true });
					},
				},
				clock: () => NOW,
			},
			MACHINE,
			"octo-org/score",
		);
		expect(token).toEqual({ token: "ghu_current", expiresAt: NOW.getTime() + 2 * 3_600_000 });
		expect(asked).toEqual(["ghu_current octo-org/score"]);
		expect(held.refreshed()).toBe(0);
	});

	it("is refreshed first when it would expire within half an hour", async () => {
		let held = machines(GITHUB_TOKEN_FRESH_MS - 60_000);
		let token = await machineGitHubToken(
			{
				machines: held,
				github: {
					installedRepository: async () => installed(true, { contents: true, pullRequests: true }),
				},
				clock: () => NOW,
			},
			MACHINE,
			"octo-org/score",
		);
		expect(token.token).toBe("ghu_refreshed");
		expect(held.refreshed()).toBe(1);
	});

	it("is refused when the App can't write contents and pull requests, or nobody says", async () => {
		for (
			let writable of [
				{ contents: true, pullRequests: false },
				{ contents: false, pullRequests: true },
				undefined,
			]
		) {
			let error = await refused(machineGitHubToken(
				{
					machines: machines(3_600_000),
					github: { installedRepository: async () => installed(true, writable) },
					clock: () => NOW,
				},
				MACHINE,
				"octo-org/score",
			));
			expect(error.code).toBe("app-cannot-push");
			expect(error.message).toContain("octo-org/score");
		}
	});

	it("is refused when the owner can't push or the App isn't installed there", async () => {
		for (let answer of [installed(false, { contents: true, pullRequests: true }), undefined]) {
			let error = await refused(machineGitHubToken(
				{
					machines: machines(3_600_000),
					github: { installedRepository: async () => answer },
					clock: () => NOW,
				},
				MACHINE,
				"octo-org/score",
			));
			expect(error.code).toBe("repository-forbidden");
		}
	});

	it("goes nowhere when GitHub can't be asked", async () => {
		let failure = new Error("GitHub is down");
		let error = await machineGitHubToken(
			{
				machines: machines(3_600_000),
				github: {
					installedRepository: async () => {
						throw failure;
					},
				},
				clock: () => NOW,
			},
			MACHINE,
			"octo-org/score",
		).catch((caught: unknown) => caught);
		expect(error).toBe(failure);
	});
});
