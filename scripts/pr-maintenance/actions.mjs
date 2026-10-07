import { execFileSync } from "node:child_process";
import { openState, sealState } from "./state-store.mjs";

export function createRequest(token, fetcher = fetch) {
	if (typeof token !== "string" || !token) throw new Error("GitHub credential required");
	return async (method, path, body) => {
		if (
			!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method)
			|| typeof path !== "string" || !/^\/(repos|users)\//.test(path)
			|| ["\r", "\n", "\0", "#"].some((character) => path.includes(character))
		) throw new Error("Invalid GitHub request");
		let response;
		try {
			response = await fetcher(`https://api.github.com${path}`, {
				method,
				redirect: "error",
				headers: {
					authorization: `Bearer ${token}`,
					accept: "application/vnd.github+json",
					"content-type": "application/json",
					"x-github-api-version": "2022-11-28",
				},
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
			});
		} catch {
			throw new Error("GitHub request unavailable");
		}
		if (!response.ok) {
			let error = new Error(`GitHub request failed (HTTP ${response.status})`);
			error.status = response.status;
			throw error;
		}
		if (response.status === 204) return null;
		try {
			let text = await response.text();
			if (Buffer.byteLength(text) > 16 * 1024 * 1024) throw new Error();
			return JSON.parse(text);
		} catch {
			throw new Error("Invalid GitHub response");
		}
	};
}

function resultIdentity(result) {
	let fields = ["repository", "number", "attempt", "runId", "outcome"];
	if (
		!result || Object.keys(result).length !== fields.length
		|| fields.some((field) => !Object.hasOwn(result, field))
		|| !Number.isSafeInteger(result.number) || result.number < 1
		|| typeof result.attempt !== "string" || !result.attempt
		|| typeof result.runId !== "string" || !/^[1-9][0-9]*$/.test(result.runId)
		|| !result.outcome || typeof result.outcome !== "object" || Array.isArray(result.outcome)
	) throw new Error("Invalid worker result");
}

export function sealResult(result, key) {
	resultIdentity(result);
	return sealState({
		schemaVersion: 1,
		repository: result.repository,
		revision: 0,
		prs: { [result.number]: result },
	}, key);
}

export function openResult(packet, expected, key) {
	let payload = openState(packet, expected.repository, key);
	if (payload.revision !== 0 || Object.keys(payload.prs).length !== 1) {
		throw new Error("Invalid worker result envelope");
	}
	let result = payload.prs[expected.number];
	resultIdentity(result);
	for (let field of ["repository", "number", "attempt", "runId"]) {
		if (result[field] !== expected[field]) throw new Error("Worker result identity mismatch");
	}
	return result.outcome;
}

export function trustedGit(directory, args, token = "", binary = false) {
	let env = {
		...process.env,
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_TRACE: "0",
		GIT_TRACE_CURL: "0",
		GIT_CURL_VERBOSE: "0",
		GIT_CONFIG_COUNT: "0",
	};
	if (token) {
		env.GIT_CONFIG_COUNT = "1";
		env.GIT_CONFIG_KEY_0 = "http.https://github.com/.extraheader";
		env.GIT_CONFIG_VALUE_0 = `AUTHORIZATION: basic ${
			Buffer.from(`x-access-token:${token}`).toString("base64")
		}`;
	}
	try {
		return execFileSync("git", [
			"--no-replace-objects",
			"-c",
			"core.hooksPath=/dev/null",
			"-c",
			"core.fsmonitor=false",
			"-c",
			"credential.helper=",
			...args,
		], {
			cwd: directory,
			stdio: ["ignore", "pipe", "pipe"],
			env,
			encoding: binary ? undefined : "utf8",
			maxBuffer: 64 * 1024 * 1024,
		});
	} catch {
		throw new Error("Trusted Git operation failed");
	}
}

export function pushProposal(
	{ repository, directory, branch, expectedHead, proposalHead },
	token,
	run = trustedGit,
) {
	if (
		!/^[-\w.]+\/[-\w.]+$/.test(repository)
		|| repository.split("/").some((part) => part === "." || part === "..")
		|| !/^[0-9a-f]{40}$/.test(expectedHead) || !/^[0-9a-f]{40}$/.test(proposalHead)
		|| typeof branch !== "string" || branch === "main"
	) throw new Error("Invalid publication identity");
	run(directory, ["check-ref-format", `refs/heads/${branch}`]);
	return run(directory, [
		"push",
		"--porcelain",
		`--force-with-lease=refs/heads/${branch}:${expectedHead}`,
		`https://github.com/${repository}.git`,
		`${proposalHead}:refs/heads/${branch}`,
	], token);
}
