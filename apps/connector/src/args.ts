import { resolve } from "node:path";

export type ParsedArgs = {
	/** Arguments that are not options, in order. */
	positional: string[];
	/** Boolean flags that were given, without their leading dashes. */
	flags: Set<string>;
	/** Options that take a value, without their leading dashes. */
	options: Map<string, string>;
	/** Options that may be given more than once, every value in order. */
	lists: Map<string, string[]>;
	/** Everything after a bare `--`, such as an agent's ACP command; undefined without one. */
	rest?: string[];
};

/**
 * Parse one command's arguments. `--name value` and `--name=value` both set an option; an
 * unknown `--option` is refused. Every command accepts `--base-dir <dir>`, which sets
 * `CHOPIN_HOME` for this process and the processes it starts, so stateDirectory() and
 * everything stored there (the machine token, config and logs) move with it.
 */
export function parseArgs(
	args: string[],
	spec: { flags?: string[]; options?: string[]; lists?: string[] } = {},
): ParsedArgs {
	let flags = new Set(spec.flags ?? []);
	let lists = new Set(spec.lists ?? []);
	let options = new Set([...(spec.options ?? []), ...lists, "base-dir"]);
	let parsed: ParsedArgs = {
		positional: [],
		flags: new Set(),
		options: new Map(),
		lists: new Map(),
	};
	for (let index = 0; index < args.length; index++) {
		let arg = args[index]!;
		if (arg === "--") {
			parsed.rest = args.slice(index + 1);
			break;
		}
		if (!arg.startsWith("--") || arg === "-") {
			parsed.positional.push(arg);
			continue;
		}
		let split = arg.indexOf("=");
		let name = arg.slice(2, split < 0 ? undefined : split);
		if (flags.has(name) && split < 0) {
			parsed.flags.add(name);
		} else if (options.has(name)) {
			let value = split < 0 ? args[++index] : arg.slice(split + 1);
			if (value === undefined || value === "" || split < 0 && value.startsWith("--")) {
				throw new Error(`--${name} needs a value.`);
			}
			parsed.options.set(name, value);
			if (lists.has(name)) parsed.lists.set(name, [...parsed.lists.get(name) ?? [], value]);
		} else {
			throw new Error(`Unknown option: --${name}`);
		}
	}
	let base = parsed.options.get("base-dir");
	if (base !== undefined) process.env.CHOPIN_HOME = resolve(base);
	return parsed;
}
