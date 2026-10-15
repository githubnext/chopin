import { AGENTS } from "@chopin/protocol/agents";

import type { SetupAgent } from "@chopin/protocol/agents";

const SYSTEMS = ["linux", "macos", "windows"] as const;
const FIELDS = new Set(["id", "name", "install", "command", "keyless", "default"]);

/**
 * CHOPIN_SETUP_AGENTS: the setups this deployment offers on the Machines page, as a JSON array
 * (see `SetupAgent`). Anything malformed stops the server with the entry and field that are wrong;
 * the value holds no secret, as the key is minted in the browser's page later.
 */
export function setupAgents(raw: string | undefined): SetupAgent[] {
	if (raw === undefined || raw.trim() === "") return [];
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		value = undefined;
	}
	if (!Array.isArray(value)) {
		throw new Error("CHOPIN_SETUP_AGENTS must be a JSON array of setup agents");
	}
	if (value.length > 10) throw new Error("CHOPIN_SETUP_AGENTS may name at most 10 setup agents");
	let seen = new Set<string>();
	let agents = value.map((entry: unknown, index): SetupAgent => {
		let at = `CHOPIN_SETUP_AGENTS[${index}]`;
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
			throw new Error(`${at} must be an object`);
		}
		let item = entry as Record<string, unknown>;
		let unknown = Object.keys(item).find(key => !FIELDS.has(key));
		if (unknown) throw new Error(`${at} has an unknown field, ${JSON.stringify(unknown)}`);
		let { id, name } = item;
		if (typeof id !== "string" || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(id)) {
			throw new Error(`${at}.id must be up to 40 lowercase letters, digits and dashes`);
		}
		if (AGENTS.some(agent => agent.id === id)) {
			throw new Error(`${at}.id ${JSON.stringify(id)} is a built-in coding agent's`);
		}
		if (seen.has(id)) throw new Error(`${at}.id ${JSON.stringify(id)} is used more than once`);
		seen.add(id);
		if (typeof name !== "string" || !name.trim() || name.length > 60) {
			throw new Error(`${at}.name must be 1 to 60 characters`);
		}
		let lines = (list: unknown) =>
			Array.isArray(list) && list.length <= 20
			&& list.every(line => typeof line === "string" && line.length <= 2000);
		let template = (text: unknown) =>
			typeof text === "string" && !!text.trim() && text.length <= 4000;
		let perSystem = <T>(field: string, valid: (value: unknown) => boolean): T => {
			let given = item[field];
			let each = given && typeof given === "object" && !Array.isArray(given)
				? given as Record<string, unknown>
				: undefined;
			let ok = each
				? Object.keys(each).length === 3 && SYSTEMS.every(system => valid(each[system]))
				: valid(given);
			if (!ok) {
				throw new Error(
					`${at}.${field} must be ${
						field === "install" ? "a list of at most 20 lines" : "a non-empty command"
					}, or an object of one for each of linux, macos and windows`,
				);
			}
			return given as T;
		};
		let all = <T>(value: T | Record<string, T>): T[] =>
			value && typeof value === "object" && !Array.isArray(value)
				? SYSTEMS.map(system => (value as Record<string, T>)[system]!)
				: [value as T];
		let install = perSystem<SetupAgent["install"]>("install", lines);
		let command = perSystem<SetupAgent["command"]>("command", template);
		if (!all(command).every(text => text.includes("{key}"))) {
			throw new Error(`${at}.command must contain {key}, where the pairing key goes`);
		}
		let keyless = item.keyless === undefined
			? undefined
			: perSystem<NonNullable<SetupAgent["keyless"]>>("keyless", template);
		if (keyless && all(keyless).some(text => text.includes("{key}"))) {
			throw new Error(`${at}.keyless sets up a computer without a key, so it can't use {key}`);
		}
		if (item.default !== undefined && typeof item.default !== "boolean") {
			throw new Error(`${at}.default must be true or false`);
		}
		return {
			id,
			name,
			install,
			command,
			...(keyless ? { keyless } : {}),
			...(item.default === undefined ? {} : { default: item.default }),
		};
	});
	if (agents.filter(agent => agent.default).length > 1) {
		throw new Error("CHOPIN_SETUP_AGENTS may make only one setup agent the default");
	}
	return agents;
}
