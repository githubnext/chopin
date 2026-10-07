import { lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { applyProposal } from "./application.mjs";
import { createRequest, pushProposal, sealResult, trustedGit } from "./actions.mjs";
import { createStateStore } from "./state-store.mjs";
import { validateState } from "./state.mjs";

function output(path) {
	let stat = lstatSync(path);
	if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error("Invalid safe output file");
	let value = JSON.parse(readFileSync(path, "utf8"));
	let items = Array.isArray(value) ? value : value.items;
	if (!Array.isArray(items) || items.length !== 1) throw new Error("One safe output required");
	let item = items[0];
	let fields = new Set(["type", "attempt", "kind", "review", "reason"]);
	if (
		!item || Object.keys(item).some(field => !fields.has(field))
		|| ["type", "attempt", "kind"].some(field => !Object.hasOwn(item, field))
		|| item.type !== "finish_attempt"
		|| !["proposal", "human", "infrastructure"].includes(item.kind)
		|| ["review", "reason"].some(field =>
			Object.hasOwn(item, field) && typeof item[field] !== "string"
		)
	) {
		throw new Error("Invalid safe output");
	}
	return { ...item, review: item.review ?? "", reason: item.reason ?? "" };
}

export async function runWorker(mode, config) {
	let { repository, number, attempt, runId, key, store, request, directory } = config;
	let resultPath = config.resultPath ?? "/tmp/gh-aw/result/result.json";
	let outcome;
	try {
		if (!["prepare", "finish"].includes(mode)) throw new Error("Invalid worker mode");
		let loaded = await store.load();
		if (loaded.payload.repository !== repository) throw new Error("State repository mismatch");
		let state = loaded.payload.prs[String(number)];
		validateState(state);
		let active = state.active;
		if (state.number !== number) throw new Error("State PR mismatch");
		if (
			active?.id !== attempt || active.episode !== state.episode
			|| (mode === "prepare" && (active.head !== state.head
				|| active.baseHead !== state.baseHead || active.action !== state.action))
			|| (active.runId !== null && active.runId !== runId)
		) {
			outcome = { kind: "superseded" };
		} else if (mode === "prepare") {
			let prefix = `/repos/${repository}`;
			let pr = await request("GET", `${prefix}/pulls/${number}`);
			let base = await request("GET", `${prefix}/branches/${encodeURIComponent(pr.base.ref)}`);
			if (
				pr.state !== "open" || pr.head.repo?.full_name !== repository
				|| pr.base.repo?.full_name !== repository || pr.head.sha !== active.head
				|| typeof pr.head.ref !== "string" || !pr.head.ref
				|| base.commit?.sha !== active.baseHead || !Array.isArray(pr.labels)
				|| pr.labels.some((label) =>
					(typeof label === "string" ? label : label.name) === "no-babysit"
				)
			) {
				throw new Error("PR no longer eligible");
			}
			for (let sha of [active.head, active.baseHead]) {
				if (trustedGit(directory, ["cat-file", "-t", sha]).trim() !== "commit") {
					throw new Error("Missing captured commit");
				}
			}
			let dataDirectory = config.dataDirectory ?? "/tmp/gh-aw/data";
			mkdirSync(dataDirectory, { recursive: true });
			let description = {
				repository,
				number,
				attempt,
				head: active.head,
				baseHead: active.baseHead,
				branch: pr.head.ref,
				operation: active.action === "repair" ? "fix" : "rebase",
				oldReplayBoundary: null,
			};
			writeFileSync(join(dataDirectory, "pr-attempt.json"), JSON.stringify(description));
			writeFileSync(
				join(dataDirectory, "trusted-AGENTS.md"),
				trustedGit(directory, ["show", "origin/main:AGENTS.md"]),
			);
			return description;
		} else {
			let item = output(config.outputPath ?? process.env.GH_AW_AGENT_OUTPUT);
			if (item.attempt !== attempt) throw new Error("Safe output attempt mismatch");
			if (item.kind === "proposal") {
				if (Buffer.byteLength(item.review) > 200 * 1024) {
					throw new Error("Invalid application output");
				}
				outcome = await applyProposal({
					repository,
					number,
					attempt,
					store,
					request,
					directory,
					artifactDirectory: config.artifactDirectory ?? "/tmp/gh-aw/proposal",
					review: item.review,
					push: config.push ?? ((args) => {
						if (!config.writeToken) throw new Error("Publication credential required");
						return pushProposal(args, config.writeToken);
					}),
				});
			} else {
				if (
					active.head !== state.head || active.baseHead !== state.baseHead
					|| active.action !== state.action
				) {
					outcome = { kind: "superseded" };
				} else {
					if (
						typeof item.reason !== "string" || !item.reason.trim()
						|| Buffer.byteLength(item.reason) > 4096
					) throw new Error("Invalid report reason");
					outcome = {
						kind: item.kind === "human" ? "blocked" : "transient",
						reason: item.reason,
					};
				}
			}
		}
	} catch {
		outcome = { kind: "transient", reason: "Worker infrastructure failure; inspect Actions logs" };
	}
	mkdirSync(dirname(resultPath), { recursive: true });
	writeFileSync(
		resultPath,
		JSON.stringify(sealResult({ repository, number, attempt, runId, outcome }, key)),
	);
	return outcome;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
	let mode = process.argv[2];
	let repository = process.env.GITHUB_REPOSITORY;
	let key = process.env.PR_MAINTENANCE_STATE_KEY;
	let request = createRequest(process.env.GH_TOKEN);
	let result = await runWorker(mode, {
		repository,
		number: Number(process.env.PR_NUMBER),
		attempt: process.env.ATTEMPT,
		runId: process.env.GITHUB_RUN_ID,
		key,
		request,
		store: createStateStore(repository, key, request),
		directory: process.cwd(),
		...(mode === "finish" ? { writeToken: process.env.PR_WRITE_TOKEN } : {}),
	});
	if (mode === "prepare" && result.kind) process.exitCode = 1;
}
