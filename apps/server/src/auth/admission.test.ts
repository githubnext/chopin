import { describe, expect, it } from "bun:test";

import { GitHubError } from "../github/client";
import { Admission, AdmissionDenied } from "./admission";

import type { AuthConfig } from "./config";
import type { GitHub, GitHubOrganizationMembership, GitHubUser } from "../github/client";

const BASE: AuthConfig = {
	origin: "https://chopin.test",
	appSlug: "chopin-test",
	clientId: "client-id",
	clientSecret: "client-secret",
	encryptionKey: new Uint8Array(32),
};

class GitHubBoundary {
	userCalls: string[] = [];
	membershipCalls: Array<{ token: string; organization: string }> = [];
	invalidated: string[] = [];
	userValue: GitHubUser = { id: "U_octocat", login: "OctoCat", avatarUrl: "avatar" };
	userFailure: GitHubError | undefined;
	memberships = new Map<string, GitHubOrganizationMembership | GitHubError | undefined>();

	async user(token: string): Promise<GitHubUser> {
		this.userCalls.push(token);
		if (this.userFailure) throw this.userFailure;
		return this.userValue;
	}

	async organizationMembership(
		token: string,
		organization: string,
	): Promise<GitHubOrganizationMembership | undefined> {
		this.membershipCalls.push({ token, organization });
		let value = this.memberships.get(organization);
		if (value instanceof GitHubError) throw value;
		return value;
	}

	invalidate(token: string): void {
		this.invalidated.push(token);
	}
}

function github(boundary: GitHubBoundary): GitHub {
	return boundary as unknown as GitHub;
}

describe("instance admission", () => {
	it("allows an explicit username without querying configured organizations", async () => {
		let boundary = new GitHubBoundary();
		let admission = new Admission({
			...BASE,
			allowedUsers: new Set(["octocat"]),
			allowedOrganizations: new Set(["githubnext"]),
		}, github(boundary));

		expect(await admission.user("token")).toEqual(boundary.userValue);
		expect(boundary.membershipCalls).toEqual([]);
	});

	it("allows active membership in any organization and denies pending or absent membership", async () => {
		let boundary = new GitHubBoundary();
		boundary.memberships.set("first-org", undefined);
		boundary.memberships.set("githubnext", { state: "active", role: "member" });
		let admission = new Admission({
			...BASE,
			allowedOrganizations: new Set(["first-org", "githubnext"]),
		}, github(boundary));

		expect(await admission.user("member")).toEqual(boundary.userValue);
		expect(boundary.membershipCalls.map(value => value.organization)).toEqual([
			"first-org",
			"githubnext",
		]);

		let deniedBoundary = new GitHubBoundary();
		deniedBoundary.memberships.set("githubnext", { state: "pending", role: "member" });
		let denied = new Admission({
			...BASE,
			allowedOrganizations: new Set(["githubnext"]),
		}, github(deniedBoundary));
		await expect(denied.user("pending")).rejects.toBeInstanceOf(AdmissionDenied);

		let billingBoundary = new GitHubBoundary();
		billingBoundary.memberships.set("githubnext", {
			state: "active",
			role: "billing_manager",
		});
		let billing = new Admission({
			...BASE,
			allowedOrganizations: new Set(["githubnext"]),
		}, github(billingBoundary));
		await expect(billing.user("billing")).rejects.toBeInstanceOf(AdmissionDenied);
	});

	it("accepts a later positive result but fails closed when membership cannot be verified", async () => {
		let boundary = new GitHubBoundary();
		boundary.memberships.set("unavailable", new GitHubError("blocked", 403));
		boundary.memberships.set("githubnext", { state: "active", role: "admin" });
		let admitted = new Admission({
			...BASE,
			allowedOrganizations: new Set(["unavailable", "githubnext"]),
		}, github(boundary));
		expect(await admitted.user("token")).toEqual(boundary.userValue);

		let unavailable = new Admission({
			...BASE,
			allowedOrganizations: new Set(["unavailable"]),
		}, github(boundary));
		await expect(unavailable.user("other-token")).rejects.toMatchObject({ status: 503 });
	});

	it("coalesces and caches decisions without retaining provider failures", async () => {
		let now = 0;
		let boundary = new GitHubBoundary();
		boundary.memberships.set("githubnext", { state: "active", role: "member" });
		let admission = new Admission(
			{
				...BASE,
				allowedOrganizations: new Set(["githubnext"]),
			},
			github(boundary),
			() => now,
		);

		await Promise.all([admission.user("token"), admission.user("token")]);
		expect(boundary.userCalls).toEqual(["token"]);
		expect(boundary.membershipCalls).toHaveLength(1);
		now = 29_999;
		await admission.user("token");
		expect(boundary.userCalls).toHaveLength(1);
		now = 30_000;
		await admission.user("token");
		expect(boundary.userCalls).toHaveLength(2);

		admission.invalidate("token");
		await admission.user("token");
		expect(boundary.invalidated).toEqual(["token"]);
		expect(boundary.userCalls).toHaveLength(3);

		boundary.userFailure = new GitHubError("temporary", 502);
		await expect(admission.user("failing")).rejects.toMatchObject({ status: 503 });
		await expect(admission.user("failing")).rejects.toMatchObject({ status: 503 });
		expect(boundary.userCalls.filter(value => value === "failing")).toHaveLength(2);
	});

	it("preserves invalid-credential failures and skips checks when unrestricted", async () => {
		let boundary = new GitHubBoundary();
		let unrestricted = new Admission(BASE, github(boundary));
		expect(await unrestricted.allowed("unused", "U_octocat")).toBe(true);
		expect(boundary.userCalls).toEqual([]);

		boundary.userFailure = new GitHubError("bad credentials", 401);
		await expect(unrestricted.user("bad")).rejects.toMatchObject({ status: 401 });
	});
});
