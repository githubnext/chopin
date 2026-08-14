const REFLECTION_URL = "https://reflection.int.exe.xyz/";
const REFLECTION_TIMEOUT_MS = 5_000;
const VM_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export type DevTarget = "local" | "exe";

export type ExeDev = {
	name: string;
	host: string;
	origin: string;
};

export function parseDevTarget(args: string[]): DevTarget {
	if (args.length === 0) return "local";
	if (args.length === 1 && args[0] === "--exe") return "exe";
	throw new Error("usage: bun scripts/dev.ts [--exe]");
}

export function exeDev(name: string): ExeDev {
	if (!VM_NAME.test(name)) {
		throw new Error(`exe.dev returned an invalid VM name: ${JSON.stringify(name)}`);
	}
	let host = `${name}.exe.xyz`;
	return { name, host, origin: `https://${host}` };
}

/** Discover the canonical VM name without relying on undocumented metadata. */
export async function discoverExeDev(
	request: (url: string) => Promise<Response> = url =>
		fetch(url, { signal: AbortSignal.timeout(REFLECTION_TIMEOUT_MS) }),
): Promise<ExeDev> {
	let response: Response;
	try {
		response = await request(REFLECTION_URL);
	} catch (cause) {
		throw new Error("cannot reach the exe.dev Reflection integration", { cause });
	}
	if (!response.ok) {
		throw new Error(`exe.dev Reflection returned HTTP ${response.status}`);
	}

	let value: unknown;
	try {
		value = await response.json();
	} catch (cause) {
		throw new Error("exe.dev Reflection returned unreadable JSON", { cause });
	}
	let name = value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>).name
		: undefined;
	if (typeof name !== "string") {
		throw new Error("exe.dev Reflection did not return a VM name");
	}
	return exeDev(name);
}
