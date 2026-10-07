import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";

function read(path, limit) {
	if (!lstatSync(path).isFile()) throw new Error("Artifact must be a regular file");
	let fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		let stat = fstatSync(fd);
		if (!stat.isFile() || stat.size > limit) throw new Error("Artifact exceeds size limit");
		let bytes = readFileSync(fd);
		if (bytes.length > limit) throw new Error("Artifact exceeds size limit");
		return bytes;
	} finally {
		closeSync(fd);
	}
}

export function readProposal(artifactDirectory, expected) {
	if (!lstatSync(artifactDirectory).isDirectory()) throw new Error("Invalid artifact directory");
	let manifest = JSON.parse(read(join(artifactDirectory, "proposal.json"), 256 * 1024));
	let keys = [
		"schemaVersion",
		"attempt",
		"operation",
		"pr",
		"expectedHead",
		"expectedBase",
		"proposalHead",
		"bundleSha256",
		"oldReplayBoundary",
		"checks",
		"hashReviews",
	];
	if (
		!manifest || Array.isArray(manifest) || Object.keys(manifest).length !== keys.length
		|| keys.some((key) => !Object.hasOwn(manifest, key)) || manifest.schemaVersion !== 1
	) {
		throw new Error("Invalid proposal manifest schema");
	}
	for (
		let key of ["attempt", "operation", "pr", "expectedHead", "expectedBase", "oldReplayBoundary"]
	) {
		if (manifest[key] !== expected[key]) throw new Error("Proposal dispatch mismatch");
	}
	if (
		!/^[a-f0-9]{40}$/.test(manifest.proposalHead)
		|| !/^[a-f0-9]{64}$/.test(manifest.bundleSha256)
		|| !Array.isArray(manifest.hashReviews)
	) throw new Error("Invalid proposal identity");
	if (
		!Array.isArray(manifest.checks) || !manifest.checks.length || manifest.checks.length > 100
		|| manifest.checks.some((check) =>
			!check || Object.keys(check).length !== 2
			|| ["command", "result"].some((key) =>
				typeof check[key] !== "string"
				|| !check[key].trim() || Buffer.byteLength(check[key]) > 4096
			)
		)
	) {
		throw new Error("Invalid proposal checks");
	}
	let bundlePath = join(artifactDirectory, "proposal.bundle");
	let bytes = read(bundlePath, 50 * 1024 * 1024);
	if (createHash("sha256").update(bytes).digest("hex") !== manifest.bundleSha256) {
		throw new Error("Proposal bundle checksum mismatch");
	}
	let heads = execFileSync("git", ["bundle", "list-heads", bundlePath], {
		encoding: "utf8",
		maxBuffer: 256 * 1024,
	}).trim();
	if (heads !== `${manifest.proposalHead} refs/pr-maintenance/proposal`) {
		throw new Error("Proposal bundle must contain exactly the bound proposal ref");
	}
	return { manifest, bundlePath };
}
