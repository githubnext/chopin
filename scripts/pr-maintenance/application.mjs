import { execFileSync } from "node:child_process";
import { readProposal } from "./artifact.mjs";
import { validateProposal } from "./proposal.mjs";
import { registerProposal, validateState, validateVerification } from "./state.mjs";

export async function applyProposal({
	repository,
	number,
	attempt,
	store,
	request,
	directory,
	artifactDirectory,
	review,
	push,
	now = Date.now(),
}) {
	if (
		typeof repository !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)
		|| repository.split("/").some((part) => part === "." || part === "..")
		|| !Number.isSafeInteger(number) || number < 1 || typeof attempt !== "string"
		|| !attempt || typeof push !== "function" || typeof request !== "function"
	) {
		throw new Error("Invalid trusted application context");
	}
	let prefix = `/repos/${repository.split("/").map(encodeURIComponent).join("/")}`;
	let call = async (path) => {
		try {
			return await request("GET", path);
		} catch {
			throw new Error("Proposal GitHub observation failed");
		}
	};
	let load = async () => {
		let loaded;
		try {
			loaded = await store.load();
		} catch {
			throw new Error("Proposal state load failed");
		}
		if (loaded.payload.repository !== repository) throw new Error("State repository mismatch");
		let state = loaded.payload.prs[String(number)];
		validateState(state);
		if (state.number !== number) throw new Error("State PR identity mismatch");
		return { loaded, state };
	};
	let { loaded, state } = await load();
	let active = state.active;
	let matches = (current) =>
		current.active?.id === attempt
		&& current.active.episode === current.episode
		&& current.episode === active?.episode
		&& current.active.head === active?.head && current.active.baseHead === active?.baseHead
		&& current.active.action === active?.action;
	if (!matches(state)) return { kind: "superseded" };
	let operation = active.operation === "repair" ? "fix" : active.operation;
	let observe = async () => {
		let pr = await call(`${prefix}/pulls/${number}`);
		if (
			pr.state !== "open" || pr.head?.repo?.full_name !== repository
			|| pr.base?.repo?.full_name !== repository
			|| !Array.isArray(pr.labels)
			|| pr.labels.some((label) =>
				(typeof label === "string" ? label : label.name) === "no-babysit"
			)
			|| typeof pr.head.ref !== "string" || !pr.head.ref
			|| typeof pr.base.ref !== "string" || !pr.base.ref
		) return null;
		let base = await call(`${prefix}/branches/${encodeURIComponent(pr.base.ref)}`);
		if (base.commit?.sha !== active.baseHead) return null;
		return pr;
	};
	let pr = await observe();
	if (!pr || (pr.head.sha !== active.head && pr.head.sha !== active.proposalHead)) {
		return { kind: "superseded" };
	}
	if (pr.base.ref !== "main") {
		return { kind: "blocked", reason: "Stacked PR needs a recorded trusted replay boundary" };
	}
	let artifact;
	let verification;
	let git = (...args) =>
		execFileSync("git", ["--no-replace-objects", "-c", "core.hooksPath=/dev/null", ...args], {
			cwd: directory,
			maxBuffer: args[0] === "diff" ? 200 * 1024 + 1024 : 50 * 1024 * 1024,
			stdio: ["pipe", "pipe", "pipe"],
		});
	let stage = "repository";
	try {
		for (let sha of [active.head, active.baseHead]) {
			if (git("cat-file", "-t", sha).toString("utf8").trim() !== "commit") {
				throw new Error("Captured repository object is not a commit");
			}
		}
		stage = "artifact";
		artifact = readProposal(artifactDirectory, {
			attempt,
			operation,
			pr: number,
			expectedHead: active.head,
			expectedBase: active.baseHead,
			oldReplayBoundary: null,
		});
		if (active.proposalHead !== null && active.proposalHead !== artifact.manifest.proposalHead) {
			return { kind: "blocked", reason: "Attempt already registered a different proposal" };
		}
		git("bundle", "verify", artifact.bundlePath);
		stage = "import";
		git(
			"fetch",
			"--no-tags",
			"--no-write-fetch-head",
			artifact.bundlePath,
			"+refs/pr-maintenance/proposal:refs/pr-maintenance/proposal",
		);
		stage = "guard";
		let guarded = validateProposal({ directory, ...artifact.manifest });
		verification = {
			...guarded,
			checks: artifact.manifest.checks,
			hashReviews: artifact.manifest.hashReviews,
		};
		validateVerification(verification);
		stage = "diff";
		let bytes = git(
			"diff",
			"--no-ext-diff",
			"--no-textconv",
			"--binary",
			active.head,
			artifact.manifest.proposalHead,
		);
		if (
			bytes.length > 200 * 1024 || typeof review !== "string"
			|| !bytes.equals(Buffer.from(review, "utf8"))
		) {
			return {
				kind: "blocked",
				reason: "Detector review must exactly match the bounded proposal diff",
			};
		}
	} catch (error) {
		if (stage === "diff" && error?.code === "ENOBUFS") {
			return {
				kind: "blocked",
				reason: "Detector review must exactly match the bounded proposal diff",
			};
		}
		if (
			["repository", "import", "diff"].includes(stage)
			|| (stage === "guard" && Number.isInteger(error?.status))
			|| ["EACCES", "EPERM", "ENOSPC", "ENOMEM", "ENOBUFS", "EMFILE", "ENFILE", "EIO"].includes(
				error?.code,
			)
			|| (error?.code === "ENOENT" && error?.syscall?.startsWith("spawn"))
		) {
			// Raw subprocess errors can contain proposal bytes and credential-bearing arguments.
			// oxlint-disable-next-line preserve-caught-error
			throw new Error("Proposal validation infrastructure failed");
		}
		return { kind: "blocked", reason: "Proposal artifact or Git policy validation failed" };
	}
	let proposalHead = artifact.manifest.proposalHead;
	if (active.proposalHead === null) {
		let next = { ...registerProposal(state, attempt, proposalHead), updatedAt: now };
		validateState(next);
		try {
			await store.save(loaded, {
				...loaded.payload,
				revision: loaded.payload.revision + 1,
				prs: { ...loaded.payload.prs, [String(number)]: next },
			});
		} catch {
			throw new Error("Proposal registration failed");
		}
	}
	let latest = (await load()).state;
	if (!matches(latest) || latest.active.proposalHead !== proposalHead) {
		return { kind: "superseded" };
	}
	let fresh = await observe();
	if (!fresh || fresh.head.ref !== pr.head.ref || fresh.base.ref !== pr.base.ref) {
		return { kind: "superseded" };
	}
	if (fresh.head.sha === proposalHead) return { kind: "applied", head: proposalHead, verification };
	if (fresh.head.sha !== active.head) return { kind: "superseded" };
	try {
		await push({
			repository,
			directory,
			branch: pr.head.ref,
			expectedHead: active.head,
			proposalHead,
			operation,
		});
	} catch {
		throw new Error("Proposal push failed; reconcile the registered head before retrying");
	}
	let published = await call(`${prefix}/pulls/${number}`);
	return published.head?.sha === proposalHead
		? { kind: "applied", head: proposalHead, verification }
		: { kind: "superseded" };
}
