import { describe, expect, it } from "bun:test";
import { ExperimentError } from "@chopin/experiment";

import {
	credentialDigest,
	liveMcpLaunch,
	McpTokens,
	mintMcpToken,
	RUN_MCP_TOKEN_MS,
} from "./mcp-token";

import type { McpTokenSources } from "./mcp-token";

const NOW = Date.parse("2026-11-12T12:00:00Z");
const MACHINE = { id: "M_1", userId: "U_owner" };

/** One Planner credential issued to M_1 for D_1, and one build B_1 of D_1 started by U_alice. */
function sources(overrides: Partial<McpTokenSources> = {}) {
	let planner = { digest: credentialDigest("chopin_p_live"), expiresAt: new Date(NOW + 900_000) };
	let state = {
		planner: true as boolean,
		run: { starter: "U_alice", documentId: "D_1", machineId: "M_1" } as
			| { starter: string; documentId?: string; machineId?: string }
			| undefined,
		now: NOW,
	};
	let value: McpTokenSources = {
		tokens: new McpTokens(new Uint8Array(32).fill(7)),
		now: () => state.now,
		plannerCredential: async digest =>
			state.planner && Buffer.from(digest).equals(Buffer.from(planner.digest))
				? { machineId: "M_1", channelId: "D_1", expiresAt: planner.expiresAt }
				: undefined,
		runCredential: token =>
			token === "run-credential"
				? { runId: "B_1", documentId: "D_1", machineId: "M_1" }
				: undefined,
		run: async id => (id === "B_1" ? state.run : undefined),
		...overrides,
	};
	return { value, state };
}

async function refused(promise: Promise<unknown>) {
	let error = await promise.then(() => undefined, (caught: unknown) => caught);
	expect(error).toBeInstanceOf(ExperimentError);
	return error as ExperimentError;
}

describe("a launch's MCP token", () => {
	it("is minted from a Planner credential, acts as the machine's owner and lasts as long", async () => {
		let { value } = sources();
		let minted = await mintMcpToken(value, MACHINE, { planner: "chopin_p_live" });
		expect(minted.token).toStartWith("chopin_mcp_");
		expect(minted.expiresAt).toBe(NOW + 900_000);
		expect(await liveMcpLaunch(value, minted.token)).toMatchObject({
			kind: "planner",
			machineId: "M_1",
			documentId: "D_1",
			userId: "U_owner",
		});
		// The credential itself never appears in it.
		expect(Buffer.from(minted.token.slice(54), "base64url").toString()).not.toContain("live");
	});

	it("is minted from a run credential and acts as who started the run, for an hour", async () => {
		let { value } = sources();
		let minted = await mintMcpToken(value, MACHINE, { run: "run-credential" });
		expect(minted.expiresAt).toBe(NOW + RUN_MCP_TOKEN_MS);
		expect(await liveMcpLaunch(value, minted.token)).toMatchObject({
			kind: "run",
			runId: "B_1",
			documentId: "D_1",
			userId: "U_alice",
		});
	});

	it("is refused for another machine's credential or a run Chopin no longer has", async () => {
		let { value, state } = sources();
		let other = { id: "M_2", userId: "U_owner" };
		expect((await refused(mintMcpToken(value, other, { planner: "chopin_p_live" }))).code)
			.toBe("credential-invalid");
		expect((await refused(mintMcpToken(value, other, { run: "run-credential" }))).code)
			.toBe("credential-invalid");
		expect((await refused(mintMcpToken(value, MACHINE, { planner: "chopin_p_other" }))).code)
			.toBe("credential-invalid");
		state.run = undefined;
		expect((await refused(mintMcpToken(value, MACHINE, { run: "run-credential" }))).code)
			.toBe("run-unknown");
	});

	it("stops once the Planner stops on the machine or the run ends", async () => {
		let { value, state } = sources();
		let planner = (await mintMcpToken(value, MACHINE, { planner: "chopin_p_live" })).token;
		let run = (await mintMcpToken(value, MACHINE, { run: "run-credential" })).token;
		state.planner = false;
		state.run = undefined;
		expect(await liveMcpLaunch(value, planner)).toBeUndefined();
		expect(await liveMcpLaunch(value, run)).toBeUndefined();
	});

	it("stops once it expires, and when it was changed or signed by another deployment", async () => {
		let { value, state } = sources();
		let token = (await mintMcpToken(value, MACHINE, { run: "run-credential" })).token;
		let elsewhere = sources({ tokens: new McpTokens(new Uint8Array(32).fill(8)) }).value;
		expect(await liveMcpLaunch(elsewhere, token)).toBeUndefined();
		let body = token.slice("chopin_mcp_".length + 43);
		let changed = Buffer.from(body, "base64url").toString().replace("U_alice", "U_owner");
		expect(
			await liveMcpLaunch(
				value,
				token.slice(0, "chopin_mcp_".length + 43) + Buffer.from(changed).toString("base64url"),
			),
		).toBeUndefined();
		state.now = NOW + RUN_MCP_TOKEN_MS;
		expect(await liveMcpLaunch(value, token)).toBeUndefined();
	});
});
