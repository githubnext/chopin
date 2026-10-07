import { createHash } from "node:crypto";

function canonical(path) {
	return typeof path === "string" && path.length > 0 && !path.includes("\\") && !path.includes("\0")
		&& path.split("/").every((part) => part !== "" && part !== "." && part !== "..")
		&& !/^[A-Za-z]:/.test(path);
}

export function isRepairPath(path) {
	if (!canonical(path)) return false;
	let parts = path.split("/");
	let name = parts.at(-1).toLowerCase();
	if (
		parts.some((part) =>
			[".agents", ".codex", ".github", "design-contract"].includes(part.toLowerCase())
		)
	) return false;
	if (
		[
			"agents.md",
			"claude.md",
			"package.json",
			"bun.lock",
			"bun.lockb",
			"package-lock.json",
			"yarn.lock",
			"pnpm-lock.yaml",
			"cargo.toml",
			"cargo.lock",
			"go.mod",
			"go.sum",
			"pyproject.toml",
		].includes(name)
		|| /\.(instructions|prompt)\.md$/.test(name) || /^requirements.*\.txt$/.test(name)
	) return false;
	if (path === "README.md") return true;
	if (/^scripts\/check-design.*\.ts$/.test(path)) return false;
	return /^(apps|packages|e2e|docs|patches)\/.+/.test(path) || /^scripts\/[^/]+\.ts$/.test(path);
}

function record(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		&& [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

function validateJSON(value, seen = new Set()) {
	if (
		value === null || typeof value === "string" || typeof value === "boolean"
		|| (typeof value === "number" && Number.isFinite(value))
	) return;
	if ((!Array.isArray(value) && !record(value)) || seen.has(value)) {
		throw new Error("Exception data must be plain JSON records");
	}
	if (
		Array.isArray(value) && (Object.keys(value).length !== value.length
			|| Object.keys(value).some((key, index) => key !== String(index)))
	) throw new Error("Exception arrays must be dense JSON arrays");
	seen.add(value);
	for (let key of Reflect.ownKeys(value)) {
		if (Array.isArray(value) && key === "length") continue;
		let descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (typeof key !== "string" || !descriptor.enumerable || !("value" in descriptor)) {
			throw new Error("Exception data contains non-JSON fields");
		}
		validateJSON(descriptor.value, seen);
	}
	seen.delete(value);
}

export function validateHashRenewal(before, after, readSource, reviews) {
	validateJSON(before);
	validateJSON(after);
	validateJSON(reviews);
	if (!Array.isArray(before) || !Array.isArray(after) || !Array.isArray(reviews)) {
		throw new Error("Exceptions and reviews must be arrays");
	}
	let renewed = new Map();
	let sourceHashes = new Map();
	function compare(left, right, hashRecord = false) {
		if (Array.isArray(left)) {
			if (!Array.isArray(right) || left.length !== right.length) {
				throw new Error("Exception arrays must retain entries and order");
			}
			for (let i = 0; i < left.length; i++) compare(left[i], right[i]);
			return;
		}
		if (record(left)) {
			if (!record(right)) throw new Error("Exception record changed");
			let keys = Object.keys(left);
			if (
				keys.length !== Object.keys(right).length || keys.some((key) => !Object.hasOwn(right, key))
			) throw new Error("Exception field membership changed");
			for (let key of keys) {
				if (key === "sourceHash" && hashRecord) {
					if (
						typeof left[key] !== "string" || typeof right[key] !== "string"
						|| !/^[a-f0-9]{64}$/.test(left[key]) || !/^[a-f0-9]{64}$/.test(right[key])
					) throw new Error("Invalid sourceHash");
					let file = left.file;
					if (
						!isRepairPath(file) || !/^(apps|packages)\/.+/.test(file)
					) throw new Error("Hash source must be a canonical application or package source path");
					if (!sourceHashes.has(file)) {
						let bytes = readSource(file);
						if (!(bytes instanceof Uint8Array)) {
							throw new Error("Source reader must return regular source blob bytes");
						}
						sourceHashes.set(file, createHash("sha256").update(bytes).digest("hex"));
					}
					if (right[key] !== sourceHashes.get(file)) {
						throw new Error("sourceHash does not match proposal source bytes");
					}
					if (left[key] !== right[key]) renewed.set(file, right[key]);
				} else if (key === "producers" && hashRecord) {
					if (
						!Array.isArray(left[key]) || !Array.isArray(right[key])
						|| left[key].length !== right[key].length
					) throw new Error("Producer provenance changed");
					for (let i = 0; i < left[key].length; i++) compare(left[key][i], right[key][i], true);
				} else compare(left[key], right[key]);
			}
			return;
		}
		if (!Object.is(left, right)) throw new Error("Exception content changed beyond sourceHash");
	}
	if (before.length !== after.length) throw new Error("Exception entry count changed");
	for (let i = 0; i < before.length; i++) {
		if (!record(before[i]) || !record(after[i])) {
			throw new Error("Exception groups must be records");
		}
		compare(before[i], after[i], true);
	}
	for (let [file, sourceHash] of renewed) {
		if (
			!reviews.some((review) =>
				record(review) && review.file === file && review.sourceHash === sourceHash
				&& typeof review.rationale === "string" && review.rationale.trim().length > 0
				&& review.rationale.length <= 4096
			)
		) throw new Error("Changed source requires a matching bounded rationale review");
	}
	return Array.from(renewed, ([file, sourceHash]) => ({ file, sourceHash }));
}
