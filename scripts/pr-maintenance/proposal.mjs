import { execFileSync } from "node:child_process";
import { isRepairPath, validateHashRenewal } from "./proposal-policy.mjs";

let renewals = new Set([
	"scripts/design-contract/exceptions/dynamic-editor.json",
	"scripts/design-contract/exceptions/dynamic-web.json",
	"scripts/design-contract/exceptions/dynamic-packages.json",
	"scripts/design-contract/exceptions/preserved-values.json",
]);
let regular = (entry) =>
	entry && entry.type === "blob"
	&& ["100644", "100755"].includes(entry.mode);
let same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

export function validateProposal({
	directory,
	operation,
	expectedHead,
	expectedBase,
	proposalHead,
	oldReplayBoundary = null,
	hashReviews = [],
}) {
	for (let sha of [expectedHead, expectedBase, proposalHead, oldReplayBoundary]) {
		if (sha !== null && (typeof sha !== "string" || !/^[a-f0-9]{40}$/.test(sha))) {
			throw new Error("Invalid commit SHA");
		}
	}
	if (!["fix", "rebase"].includes(operation)) throw new Error("Unsupported operation");
	let git = (...args) =>
		execFileSync("git", [
			"--no-replace-objects",
			"-c",
			"core.hooksPath=/dev/null",
			"-c",
			"diff.external=",
			...args,
		], { cwd: directory, maxBuffer: 32 * 1024 * 1024 });
	let string = (...args) => git(...args).toString("utf8").trim();
	let ancestor = (older, newer) => {
		try {
			git("merge-base", "--is-ancestor", older, newer);
			return true;
		} catch (error) {
			if (error.status === 1) return false;
			throw error;
		}
	};
	for (let sha of [expectedHead, expectedBase, proposalHead]) {
		if (string("cat-file", "-t", sha) !== "commit") throw new Error("Expected commit object");
	}
	let range = (from, to) => {
		let lines = string("rev-list", "--reverse", "--parents", `${from}..${to}`);
		if (!lines) throw new Error("Empty proposal replay range");
		let previous = from;
		let commits = [];
		for (let line of lines.split("\n")) {
			let [commit, ...parents] = line.split(" ");
			if (parents.length !== 1 || parents[0] !== previous) {
				throw new Error("Proposal must be linear without merges");
			}
			commits.push(commit);
			previous = commit;
		}
		return commits;
	};
	let boundary = expectedHead;
	if (operation === "fix") {
		if (!ancestor(expectedHead, proposalHead)) throw new Error("Fix diverges from expected head");
		if (!ancestor(expectedBase, expectedHead)) throw new Error("Must rebase before fixing");
		if (range(expectedHead, proposalHead).length !== 1) {
			throw new Error("Fix requires exactly one commit");
		}
	} else {
		if (!ancestor(expectedBase, proposalHead)) throw new Error("Rebase must include expected base");
		if (oldReplayBoundary === null) {
			let bases = string("merge-base", "--all", expectedHead, expectedBase).split("\n");
			if (bases.length !== 1 || !/^[a-f0-9]{40}$/.test(bases[0])) {
				throw new Error("Ambiguous replay boundary");
			}
			boundary = bases[0];
		} else boundary = oldReplayBoundary;
		if (!ancestor(boundary, expectedHead)) throw new Error("Replay boundary must precede head");
		let old = range(boundary, expectedHead);
		let proposed = range(expectedBase, proposalHead);
		if (old.length !== proposed.length) throw new Error("Rebase commit count changed");
		let identity = (sha) => {
			let commit = git("cat-file", "commit", sha);
			let split = commit.indexOf(Buffer.from("\n\n"));
			let author = commit.subarray(0, split).toString("utf8").split("\n")
				.find((line) => line.startsWith("author "));
			return Buffer.concat([Buffer.from(`${author}\n`), commit.subarray(split + 2)]);
		};
		for (let i = 0; i < old.length; i++) {
			if (!identity(old[i]).equals(identity(proposed[i]))) {
				throw new Error("Replayed commit author identity/date or message changed");
			}
		}
	}
	let tree = (sha) => {
		let result = new Map();
		let listing;
		try {
			listing = new TextDecoder("utf-8", { fatal: true }).decode(
				git("ls-tree", "-rz", "--full-tree", sha),
			);
		} catch (error) {
			if (error instanceof TypeError) {
				throw new Error("Git paths must be valid UTF-8", { cause: error });
			}
			throw error;
		}
		for (let item of listing.split("\0")) {
			if (!item) continue;
			let tab = item.indexOf("\t");
			let [mode, type, blob] = item.slice(0, tab).split(" ");
			result.set(item.slice(tab + 1), { mode, type, blob });
		}
		return result;
	};
	let [f, h, b, p] = [boundary, expectedHead, expectedBase, proposalHead].map(tree);
	let paths = [];
	for (let path of [...new Set([...f.keys(), ...h.keys(), ...b.keys(), ...p.keys()])].sort()) {
		let before = h.get(path);
		let ambiguous = false;
		if (operation === "rebase") {
			if (same(h.get(path), f.get(path))) before = b.get(path);
			else if (same(b.get(path), f.get(path))) before = h.get(path);
			else if (same(h.get(path), b.get(path))) before = b.get(path);
			else ambiguous = true;
		}
		let after = p.get(path);
		let repair = isRepairPath(path);
		if (ambiguous && !repair) throw new Error(`Protected conflict requires human: ${path}`);
		if (!ambiguous && same(before, after)) continue;
		if (after && !regular(after) && !same(after, before)) {
			throw new Error(`Proposal may only introduce regular files: ${path}`);
		}
		if (!repair) {
			if (!renewals.has(path)) throw new Error(`Protected path changed: ${path}`);
			if (!regular(before) || !regular(after) || before.mode !== after.mode) {
				throw new Error(`Hash renewal requires unchanged regular file mode: ${path}`);
			}
			validateHashRenewal(
				JSON.parse(git("cat-file", "blob", before.blob).toString("utf8")),
				JSON.parse(git("cat-file", "blob", after.blob).toString("utf8")),
				(source) => {
					let entry = p.get(source);
					if (!isRepairPath(source) || !regular(entry)) {
						throw new Error(`Hash source must be a regular repair path: ${source}`);
					}
					return git("cat-file", "blob", entry.blob);
				},
				hashReviews,
			);
		}
		paths.push(path);
	}
	if (operation === "fix" && paths.length === 0) throw new Error("Empty proposal change");
	return { head: proposalHead, operation, paths };
}
