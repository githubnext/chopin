import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

let failed = new Set(["failure", "timed_out", "action_required", "startup_failure"]);
let ansi = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, "g");

export function failureFingerprint(log) {
	if (typeof log !== "string" || Buffer.byteLength(log) > 2 * 1024 * 1024) return null;
	let lines = log.replace(ansi, "").split(/\r?\n/).map(line =>
		line
			.replace(/^[^\t]*\t[^\t]*\t/, "")
			.replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\s*/g, "")
			.replace(/\b[0-9a-f]{40}\b/gi, "<head>")
			.replace(/\b\d+(?:\.\d+)?\s*(?:milliseconds|seconds|minutes|ms|s)\b/gi, "<elapsed>")
			.replace(/::(error|warning)(?: [^:]+)?::/g, "$1: ")
			.trimEnd()
	);
	let first = lines.findIndex(line =>
		/\b(?:error|failed|failure|fatal|assertionerror)\b/i.test(line)
		&& !/\b(?:process completed with exit code|script .+ exited with code|the process .+ failed with exit code)\b/i
			.test(line)
	);
	if (first < 0) return null;
	let context = lines.slice(Math.max(0, first - 2), first + 9).join("\n");
	let bytes = Buffer.from(context).subarray(0, 32 * 1024);
	return createHash("sha256").update("chopin:ci-failure:v1\n").update(bytes).digest("hex");
}

export function isFailedCI(repository, run, head = run?.head_sha, branch = run?.head_branch) {
	return /^[-\w.]+\/[-\w.]+$/.test(repository ?? "")
		&& repository.split("/").every(part => part !== "." && part !== "..")
		&& /^[1-9][0-9]*$/.test(String(run?.id)) && Number.isSafeInteger(Number(run?.id))
		&& /^[0-9a-f]{40}$/.test(run?.head_sha ?? "") && run.head_sha === head
		&& typeof branch === "string" && branch.length > 0 && run.head_branch === branch
		&& run.head_repository?.full_name === repository && run.path === ".github/workflows/ci.yml"
		&& ["pull_request", "workflow_dispatch"].includes(run.event)
		&& run.status === "completed" && failed.has(run.conclusion);
}

export function getFailureFingerprint(repository, run, read = execFileSync) {
	if (!isFailedCI(repository, run)) return null;
	try {
		return failureFingerprint(
			read("gh", ["run", "view", String(run.id), "--repo", repository, "--log-failed"], {
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
				maxBuffer: 2 * 1024 * 1024,
				timeout: 30_000,
			}),
		);
	} catch {
		return null;
	}
}
