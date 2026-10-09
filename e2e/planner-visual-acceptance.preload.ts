/**
 * Keep the production Copilot SDK Planner and tools. The local `gh` token is
 * held only in this process and substituted into the fake OAuth response, so
 * the normal hosted-owner session supplies it to Copilot. GitHub API calls
 * still use the synthetic identity and cannot expand the frozen source.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { startFakeGithubMcpServer } from "./harness/fake-mcp-server";
import { loadAcceptance, MCP_PORT } from "./planner-visual-acceptance";
import { JevBudget } from "./planner-visual-jev-budget";

import { type JevQuestion, validateJevResponse } from "../apps/server/src/conversation-plan/jev";
import { instruction } from "../packages/protocol/address";

const MCP_URL = "https://api.githubcopilot.com/mcp/";
const JEV_URL = "https://api.typesafe.ai/v1/systemone";
const blockedRequests: string[] = [];
let acceptance = process.env.E2E_VISUAL_SUBSET === "jev-three-development-v1"
	? loadAcceptance()
	: undefined;
let budget = acceptance && new JevBudget(acceptance.cases.map(item => item.caseId));
let stopPath = acceptance && join(acceptance.outputRoot, "jev-stop.json");
let jevLog = acceptance && join(acceptance.outputRoot, "jev-dispatches.jsonl");
if (budget && stopPath && existsSync(stopPath)) budget.stop("previous-failure");
let recordJev = (entry: Record<string, unknown>) => {
	if (jevLog) appendFileSync(jevLog, JSON.stringify(entry) + "\n", { mode: 0o600 });
};
let stopJev = (reason: string, caseId?: string) => {
	budget?.stop(reason);
	if (stopPath && !existsSync(stopPath)) {
		writeFileSync(
			stopPath,
			JSON.stringify({ reason, caseId, at: new Date().toISOString() }) + "\n",
			{
				flag: "wx",
				mode: 0o600,
			},
		);
	}
	recordJev({ event: "stop", reason, caseId, at: new Date().toISOString() });
};
if (budget && jevLog && existsSync(jevLog)) {
	try {
		for (let line of readFileSync(jevLog, "utf8").trim().split("\n")) {
			if (!line) continue;
			let entry = JSON.parse(line) as { event?: string; caseId?: string };
			if (entry.event === "dispatch") budget.reserve(entry.caseId);
		}
	} catch {
		stopJev("invalid-dispatch-history");
		throw new Error("Jev acceptance dispatch history is invalid");
	}
}
let token: string;
try {
	token = execFileSync("gh", ["auth", "token"], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
	}).trim();
	if (!token || /\s/.test(token)) throw new Error();
} catch {
	throw new Error("A local GitHub Copilot credential is unavailable; no model call was sent");
}

let mcp = startFakeGithubMcpServer({
	port: MCP_PORT,
	rejectToolCalls: true,
	blockedRequests,
	acceptAnyBearer: true,
});
let network = globalThis.fetch;

let guarded = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
	let url = new URL(input instanceof Request ? input.url : input);
	if (url.href === JEV_URL && budget && acceptance) {
		let body: {
			model?: string;
			state?: { readerQuestion?: string };
			questions?: Record<string, JevQuestion>;
		};
		try {
			if (typeof init?.body !== "string") throw new Error("missing request body");
			body = JSON.parse(init.body);
		} catch {
			stopJev("invalid-request");
			throw new Error("Jev acceptance request has no readable body");
		}
		let readerQuestion = body.state?.readerQuestion;
		let item = typeof readerQuestion === "string"
			? acceptance.cases.find(candidate =>
				instruction(readerQuestion) === candidate.promptText.trim()
			)
			: undefined;
		let caseId = item?.caseId;
		let questionIds = Object.keys(body.questions ?? {});
		if (
			body.model !== acceptance.configuration.jevModel
			|| questionIds.length !== 1 || !["p0", "h0", "t0"].includes(questionIds[0]!)
		) {
			stopJev("unexpected-request", caseId);
			throw new Error("Jev acceptance request differs from the frozen route");
		}
		let reserved: { caseCount: number; total: number };
		try {
			reserved = budget.reserve(caseId);
		} catch (error) {
			stopJev(budget.stopped ?? "reservation-failed", caseId);
			throw error;
		}
		let requestHash = createHash("sha256").update(init!.body as string).digest("hex");
		recordJev({ event: "dispatch", caseId, questionIds, requestHash, ...reserved });
		try {
			let response = await network(input, init);
			if (!response.ok) throw new Error(`Jev HTTP ${response.status}`);
			let result = validateJevResponse(await response.clone().json(), body.questions!);
			if (result.model !== acceptance.configuration.jevModel) {
				throw new Error(`Jev model drift: ${result.model}`);
			}
			recordJev({
				event: "result",
				caseId,
				questionIds,
				model: result.model,
				answers: result.answers,
				usage: result.usage,
			});
			return response;
		} catch (error) {
			let reason = error instanceof Error ? error.message : "Jev response failed";
			stopJev(reason, caseId);
			throw error;
		}
	}
	if (url.href === MCP_URL) {
		let headers = new Headers(input instanceof Request ? input.headers : init?.headers);
		let body = input instanceof Request ? await input.clone().arrayBuffer() : init?.body;
		return network(mcp.url, { method: init?.method ?? "POST", headers, body });
	}
	if (url.href === "https://github.com/login/oauth/access_token") {
		let response = await network(input, init);
		let body = await response.json() as Record<string, unknown>;
		if (
			!response.ok || typeof body.access_token !== "string"
			|| !body.access_token.startsWith("ghu_e2e_")
		) {
			return Response.json(body, { status: response.status });
		}
		return Response.json({ ...body, access_token: token }, { status: response.status });
	}
	let oauth = url.href === "https://github.com/login/device/code";
	let admission = url.origin === "https://api.github.com" && (
		url.pathname === "/user"
		|| url.pathname === "/user/memberships/orgs/githubnext"
		|| url.pathname === "/user/installations"
		|| url.pathname === "/user/installations/101/repositories"
		|| url.pathname === "/user/installations/102/repositories"
		|| url.pathname === "/repos/octo-org/score"
	);
	let githubSource = url.hostname === "github.com"
		|| url.hostname === "api.github.com"
		|| url.hostname === "raw.githubusercontent.com"
		|| url.hostname === "objects.githubusercontent.com";
	if (githubSource && !oauth && !admission) {
		blockedRequests.push(`${init?.method ?? "GET"} ${url.origin}${url.pathname}`);
		throw new Error("Repository source expansion is disabled in this run");
	}
	if (url.origin === "https://api.github.com") {
		let headers = new Headers(input instanceof Request ? input.headers : init?.headers);
		if (headers.get("authorization") === `Bearer ${token}`) {
			headers.set("authorization", "Bearer ghu_e2e_ana_1");
			return network(input, { ...init, headers });
		}
	}
	return network(input, init);
};
globalThis.fetch = Object.assign(guarded, { preconnect: network.preconnect });
