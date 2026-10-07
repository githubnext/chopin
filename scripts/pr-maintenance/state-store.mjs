import { createHmac, timingSafeEqual } from "node:crypto";

let branch = "automation/pr-maintenance-state";
let domain = "chopin:pr-maintenance-state:v1\n";
let limit = 1024 * 1024;

function object(value) {
	return value !== null && typeof value === "object"
		&& (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function fields(value, names) {
	return object(value) && Object.keys(value).length === names.length
		&& names.every((name) => Object.hasOwn(value, name));
}

function validRepository(repository) {
	return typeof repository === "string" && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)
		&& repository.split("/").every((part) => part !== "." && part !== "..");
}

function keyBytes(key) {
	if (typeof key !== "string" && !Buffer.isBuffer(key)) {
		throw new Error("State authentication key must be a string or Buffer");
	}
	let bytes = Buffer.from(key);
	if (bytes.length < 32) throw new Error("State authentication key must contain at least 32 bytes");
	return bytes;
}

function json(value, ancestors = new Set()) {
	if (value === null || typeof value === "string" || typeof value === "boolean") return;
	if (typeof value === "number" && Number.isFinite(value)) return;
	if ((!object(value) && !Array.isArray(value)) || ancestors.has(value)) {
		throw new Error("State must contain JSON values only");
	}
	ancestors.add(value);
	if (Reflect.ownKeys(value).some((key) => typeof key === "symbol")) {
		throw new Error("State must contain JSON values only");
	}
	if (Array.isArray(value)) {
		let descriptors = Object.getOwnPropertyDescriptors(value);
		let length = descriptors.length.value;
		if (
			Object.getPrototypeOf(value) !== Array.prototype
			|| Object.keys(descriptors).length !== length + 1
		) {
			throw new Error("State must contain JSON values only");
		}
		for (let [key, descriptor] of Object.entries(descriptors)) {
			if (key === "length") continue;
			if (
				!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= length
				|| !Object.hasOwn(descriptor, "value") || !descriptor.enumerable
			) {
				throw new Error("State must contain JSON values only");
			}
		}
		for (let [key, descriptor] of Object.entries(descriptors)) {
			if (key !== "length") json(descriptor.value, ancestors);
		}
	} else {
		for (let descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
			if (!Object.hasOwn(descriptor, "value") || !descriptor.enumerable) {
				throw new Error("State must contain JSON values only");
			}
			json(descriptor.value, ancestors);
		}
	}
	ancestors.delete(value);
}

function validate(payload) {
	json(payload);
	if (
		!fields(payload, ["schemaVersion", "repository", "revision", "prs"])
		|| payload.schemaVersion !== 1 || !validRepository(payload.repository)
		|| !Number.isSafeInteger(payload.revision) || payload.revision < 0 || !object(payload.prs)
	) {
		throw new Error("Invalid maintenance state schema");
	}
	for (let [number, state] of Object.entries(payload.prs)) {
		if (!/^[1-9][0-9]*$/.test(number) || !Number.isSafeInteger(Number(number)) || !object(state)) {
			throw new Error("Invalid maintenance PR state");
		}
	}
}

function bounded(value) {
	let serialized = JSON.stringify(value);
	if (Buffer.byteLength(serialized) > limit) {
		throw new Error("Maintenance state exceeds size limit");
	}
	return serialized;
}

function signature(payload, key) {
	return createHmac("sha256", key).update(domain).update(bounded(payload)).digest("hex");
}

export function sealState(payload, key) {
	let bytes = keyBytes(key);
	validate(payload);
	let copy = JSON.parse(bounded(payload));
	let envelope = { payload: copy, signature: signature(copy, bytes) };
	bounded(envelope);
	return envelope;
}

export function openState(envelope, repository, key) {
	let bytes = keyBytes(key);
	if (!validRepository(repository)) throw new Error("Invalid state repository");
	json(envelope);
	if (
		!fields(envelope, ["payload", "signature"]) || typeof envelope.signature !== "string"
		|| !/^[0-9a-f]{64}$/.test(envelope.signature)
	) {
		throw new Error("Invalid maintenance state envelope");
	}
	bounded(envelope);
	validate(envelope.payload);
	let expected = Buffer.from(signature(envelope.payload, bytes), "hex");
	if (!timingSafeEqual(expected, Buffer.from(envelope.signature, "hex"))) {
		throw new Error("Maintenance state authentication failed");
	}
	if (envelope.payload.repository !== repository) {
		throw new Error("Maintenance state repository mismatch");
	}
	return JSON.parse(bounded(envelope.payload));
}

function metadata(file) {
	if (
		!object(file) || file.type !== "file" || file.path !== "state.json"
		|| file.name !== "state.json" || typeof file.sha !== "string"
		|| !/^[0-9a-f]{40}$/.test(file.sha)
	) throw new Error("Invalid maintenance state file metadata");
}

export function createStateStore(repository, key, request) {
	if (!validRepository(repository)) throw new Error("Invalid state repository");
	let bytes = keyBytes(key);
	if (typeof request !== "function") throw new Error("State request function required");
	let path = `/repos/${
		repository.split("/").map(encodeURIComponent).join("/")
	}/contents/state.json`;
	async function call(method, url, body) {
		try {
			return await request(method, url, body);
		} catch (error) {
			let status = Number.isInteger(error?.status) ? ` (HTTP ${error.status})` : "";
			throw new Error(`Maintenance state ${method} failed${status}`);
		}
	}
	return {
		async load() {
			let file = await call("GET", `${path}?ref=${encodeURIComponent(branch)}`);
			metadata(file);
			if (
				file.encoding !== "base64" || typeof file.content !== "string"
				|| !Number.isSafeInteger(file.size) || file.size <= 0 || file.size > limit
				|| file.content.length > Math.ceil(limit / 3) * 4 + Math.ceil(limit / 45)
			) {
				throw new Error("Invalid maintenance state file content");
			}
			let content = file.content.replace(/\n/g, "");
			let decoded = Buffer.from(content, "base64");
			if (decoded.toString("base64") !== content || decoded.length !== file.size) {
				throw new Error("Invalid maintenance state file encoding");
			}
			let envelope;
			try {
				envelope = JSON.parse(decoded.toString("utf8"));
			} catch {
				throw new Error("Invalid maintenance state JSON");
			}
			return { sha: file.sha, payload: openState(envelope, repository, bytes) };
		},
		async save(previous, payload) {
			if (
				!fields(previous, ["sha", "payload"]) || typeof previous.sha !== "string"
				|| !/^[0-9a-f]{40}$/.test(previous.sha)
			) throw new Error("Previous state SHA required");
			validate(previous.payload);
			let envelope = sealState(payload, bytes);
			if (
				previous.payload.repository !== repository || payload.repository !== repository
				|| payload.revision !== previous.payload.revision + 1
			) {
				throw new Error("State save requires matching repository and next revision");
			}
			let result = await call("PUT", path, {
				branch,
				sha: previous.sha,
				message: "Update PR maintenance state",
				content: Buffer.from(bounded(envelope)).toString("base64"),
			});
			metadata(result?.content);
			return { sha: result.content.sha, payload: envelope.payload };
		},
	};
}
