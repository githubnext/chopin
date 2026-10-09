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
	if (!["fix", "merge", "rebase"].includes(operation)) throw new Error("Unsupported operation");
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
		if (range(expectedHead, proposalHead).length !== 1) {
			throw new Error("Fix requires exactly one commit");
		}
	} else if (operation === "merge") {
		if (oldReplayBoundary !== null) throw new Error("Merge cannot set a replay boundary");
		let parents = string("rev-list", "--parents", "-n", "1", proposalHead).split(" ");
		if (
			parents.length !== 3 || parents[0] !== proposalHead
			|| parents[1] !== expectedHead || parents[2] !== expectedBase
		) throw new Error("Merge must have captured head and base as its only ordered parents");
		let bases = string("merge-base", "--all", expectedHead, expectedBase).split("\n");
		if (bases.length !== 1 || !/^[a-f0-9]{40}$/.test(bases[0])) {
			throw new Error("Ambiguous merge boundary");
		}
		boundary = bases[0];
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
	let merged = null;
	let reviewBase = expectedHead;
	let conflicts = new Set();
	if (operation === "merge" || operation === "rebase") {
		let output;
		try {
			output = git(
				"-c",
				"merge.conflictStyle=merge",
				"merge-tree",
				"--write-tree",
				"-z",
				"--name-only",
				"--no-messages",
				...(operation === "rebase" ? [`--merge-base=${boundary}`] : []),
				expectedHead,
				expectedBase,
			);
		} catch (error) {
			if (error.status !== 1 || !Buffer.isBuffer(error.stdout)) throw error;
			output = error.stdout;
		}
		let parts = new TextDecoder("utf-8", { fatal: true }).decode(output).split("\0");
		let sha = parts.shift();
		if (
			!sha || !/^[a-f0-9]{40}$/.test(sha) || parts.pop() !== ""
			|| (operation === "merge" && parts.length === 0)
			|| new Set(parts).size !== parts.length
		) throw new Error("Captured heads have no unambiguous text conflict");
		conflicts = new Set(parts);
		merged = tree(sha);
		reviewBase = sha;
	}
	let conflictText = (path, after) => {
		let entries = [f, h, b, merged, p].map((items) => items.get(path));
		if (entries.some((entry) => !regular(entry) || entry.mode !== after.mode)) {
			throw new Error(`Nontext or mode conflict requires human: ${path}`);
		}
		let texts = entries.map((entry) =>
			new TextDecoder("utf-8", { fatal: true }).decode(
				git("cat-file", "blob", entry.blob),
			)
		);
		let marker = (line) => /^(?:<<<<<<< |=======|>>>>>>> )/.test(line);
		if (
			texts.some((value) => value.includes("\0"))
			|| texts.slice(0, 3).some((value) => value.split("\n").some(marker))
			|| texts[4].split("\n").some(marker)
		) throw new Error(`Ambiguous conflict marker requires human: ${path}`);
		let fixed = [""];
		let phase = 0;
		let count = 0;
		for (let line of texts[3].match(/[^\n]*(?:\n|$)/g)?.filter(Boolean) ?? []) {
			let plain = line.replace(/\r?\n$/, "");
			if (phase === 0 && plain.startsWith("<<<<<<< ")) {
				phase = 1;
				count++;
			} else if (phase === 1 && plain === "=======") {
				phase = 2;
			} else if (phase === 2 && plain.startsWith(">>>>>>> ")) {
				phase = 0;
				fixed.push("");
			} else if (phase !== 0) {
				if (marker(plain)) throw new Error(`Invalid conflict marker sequence: ${path}`);
			} else if (marker(plain)) {
				throw new Error(`Invalid conflict marker sequence: ${path}`);
			} else fixed[fixed.length - 1] += line;
		}
		if (phase !== 0 || count === 0) throw new Error(`Nontext conflict requires human: ${path}`);
		let result = Buffer.from(texts[4]);
		let spans = fixed.map((value) => Buffer.from(value));
		if (
			!result.subarray(0, spans[0].length).equals(spans[0])
			|| !result.subarray(result.length - spans.at(-1).length).equals(spans.at(-1))
		) throw new Error(`Merge changed content outside conflict markers: ${path}`);
		let cursor = spans[0].length;
		let suffix = result.length - spans.at(-1).length;
		for (let span of spans.slice(1, -1)) {
			if (span.length === 0) throw new Error(`Ambiguous adjacent conflict markers: ${path}`);
			let at = result.indexOf(span, cursor);
			if (at < cursor || at + span.length > suffix || result.indexOf(span, at + 1) !== -1) {
				throw new Error(`Merge changed content outside conflict markers: ${path}`);
			}
			cursor = at + span.length;
		}
		if (cursor > suffix) throw new Error(`Merge changed content outside conflict markers: ${path}`);
	};
	let paths = [];
	for (
		let path of [
			...new Set([
				...f.keys(),
				...h.keys(),
				...b.keys(),
				...p.keys(),
				...(merged?.keys() ?? []),
			]),
		].sort()
	) {
		let before = h.get(path);
		let ambiguous = false;
		if (operation === "rebase") {
			if (same(h.get(path), f.get(path))) before = b.get(path);
			else if (same(b.get(path), f.get(path))) before = h.get(path);
			else if (same(h.get(path), b.get(path))) before = b.get(path);
			else ambiguous = true;
		}
		if (operation === "merge") before = merged.get(path);
		let after = p.get(path);
		let repair = isRepairPath(path);
		if (operation === "merge" && conflicts.has(path)) {
			if (!repair) {
				if (!renewals.has(path)) throw new Error(`Protected conflict requires human: ${path}`);
				let entries = [f, h, b, merged, p].map((items) => items.get(path));
				if (
					!regular(after)
					|| entries.some((entry) => !regular(entry) || entry.mode !== after.mode)
				) throw new Error(`Protected mode conflict requires human: ${path}`);
				if (same(after, h.get(path))) {
					throw new Error(`Merge cannot silently retain head side of conflict: ${path}`);
				}
				let json = (entry) =>
					JSON.parse(
						new TextDecoder("utf-8", { fatal: true }).decode(git("cat-file", "blob", entry.blob)),
					);
				let proposed = json(after);
				let source = (file) => {
					let entry = p.get(file);
					if (!isRepairPath(file) || !regular(entry)) {
						throw new Error(`Hash source must be a regular repair path: ${file}`);
					}
					return git("cat-file", "blob", entry.blob);
				};
				let headJSON = json(h.get(path));
				let baseJSON = json(b.get(path));
				let ancestorJSON = json(f.get(path));
				let fromHead = validateHashRenewal(headJSON, proposed, source, hashReviews);
				let fromBase = validateHashRenewal(baseJSON, proposed, source, hashReviews);
				let fromAncestor = validateHashRenewal(ancestorJSON, proposed, source, hashReviews);
				let retainsHeadHash = (ancestorValue, headValue, baseValue, proposalValue) => {
					if (Array.isArray(headValue)) {
						return headValue.some((value, index) =>
							retainsHeadHash(
								ancestorValue[index],
								value,
								baseValue[index],
								proposalValue[index],
							)
						);
					}
					if (headValue !== null && typeof headValue === "object") {
						return Object.keys(headValue).some((key) => {
							if (
								key === "sourceHash" && baseValue[key] !== ancestorValue[key]
								&& headValue[key] !== baseValue[key]
								&& proposalValue[key] === headValue[key]
							) return true;
							return retainsHeadHash(
								ancestorValue[key],
								headValue[key],
								baseValue[key],
								proposalValue[key],
							);
						});
					}
					return false;
				};
				if (retainsHeadHash(ancestorJSON, headJSON, baseJSON, proposed)) {
					throw new Error(`Merge cannot silently retain head hash in conflict: ${path}`);
				}
				if (
					fromHead.length === 0 && fromBase.length === 0 && fromAncestor.length === 0
				) {
					throw new Error(`Protected conflict has no reviewed hash renewal: ${path}`);
				}
				paths.push(path);
				continue;
			}
			if (!regular(after)) throw new Error(`Nontext or mode conflict requires human: ${path}`);
			if (same(after, h.get(path))) {
				throw new Error(`Merge cannot silently retain head side of conflict: ${path}`);
			}
			conflictText(path, after);
			paths.push(path);
			continue;
		}
		if (ambiguous && !repair) throw new Error(`Protected conflict requires human: ${path}`);
		if (!ambiguous && same(before, after)) continue;
		if (operation === "merge" && !renewals.has(path)) {
			throw new Error(`Merge changed a nonconflicting path: ${path}`);
		}
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
	return { head: proposalHead, operation, paths, reviewBase };
}
