import { ATOMIC_AUTH_MODES, createAtomicAdapter } from "./atomic/adapter";
import { createCopilotSdk } from "./copilot-sdk/adapter";
import { createPiAdapter } from "./pi/adapter";

import type { HarnessV1 } from "@ai-sdk/harness";
import type { AtomicAuthMode } from "./atomic/adapter";

const credentials = new Map<string, {
	currentToken: () => string | undefined;
	maxAiCredits?: number;
}>();

function createPiHarness(settings: { auth?: string }): HarnessV1 & { shutdown(): Promise<void> } {
	// Pi has no notion of a GitHub credential or a per-turn credit limit; only
	// `auth` (validated by `harnessFor` below) reaches the real adapter.
	return createPiAdapter({ auth: settings.auth as never });
}

function createAtomicHarness(
	settings: { auth?: string },
): HarnessV1 & { shutdown(): Promise<void> } {
	// Like Pi, Atomic takes neither a GitHub credential nor a credit limit.
	return createAtomicAdapter({ auth: settings.auth as AtomicAuthMode });
}

export const harnesses = {
	"copilot-sdk": createCopilotSdk,
	pi: createPiHarness,
	atomic: createAtomicHarness,
} satisfies Record<
	string,
	(settings: {
		credentials: (id: string) => string | undefined;
		limits: (id: string) => { maxAiCredits: number } | undefined;
		auth?: string;
	}) => HarnessV1
>;

export type HarnessName = keyof typeof harnesses;

let selected: (HarnessV1 & { shutdown(): Promise<void> }) | undefined;

function loopback(host: string): boolean {
	return host === "localhost" || host === "::1" || host === "[::1]"
		|| /^127(?:\.\d{1,3}){3}$/.test(host)
			&& host.split(".").slice(1).every(part => Number(part) <= 255);
}

/** Pi's documented string auth modes. `direct` is not one of them, and an
 * unrecognized value would silently fall back to a native host subscription
 * Pi was never told to isolate. */
const PI_AUTH_MODES = new Set(["auto", "openai", "anthropic", "custom", "ai-gateway"]);

/** Harnesses whose auth modes are validated explicitly; only `ai-gateway`
 * avoids a host login and may serve a non-loopback bind. */
const AUTH_MODES = new Map<string, ReadonlySet<string>>([
	["pi", PI_AUTH_MODES],
	["atomic", new Set(ATOMIC_AUTH_MODES)],
]);

export function harnessFor(config: {
	harness: string;
	harnessAuth?: string;
	host?: string;
}): HarnessV1 {
	if (!Object.hasOwn(harnesses, config.harness)) {
		throw new Error(`Unknown harness: ${config.harness}`);
	}
	let auth = config.harnessAuth;
	let isLoopback = loopback(config.host ?? "127.0.0.1");
	let modes = AUTH_MODES.get(config.harness);
	if (modes) {
		if (!auth) {
			throw new Error(`HARNESS_AUTH is required for harness ${config.harness}`);
		}
		if (!modes.has(auth)) {
			throw new Error(
				`HARNESS_AUTH ${auth} is not a supported ${config.harness} authentication mode`,
			);
		}
		if (!isLoopback && auth !== "ai-gateway") {
			throw new Error(
				`HARNESS_AUTH for ${config.harness} on a non-loopback SERVER_HOST must be ai-gateway`,
			);
		}
	} else if (auth && auth !== "direct" && auth !== "ai-gateway" && !isLoopback) {
		throw new Error("HARNESS_AUTH requires a loopback SERVER_HOST");
	}
	return selected ??= harnesses[config.harness as HarnessName]({
		credentials: id => credentials.get(id)?.currentToken(),
		limits: id => {
			let maxAiCredits = credentials.get(id)?.maxAiCredits;
			return maxAiCredits === undefined ? undefined : { maxAiCredits };
		},
		auth,
	});
}

export function registerCredential(
	id: string,
	currentToken: () => string | undefined,
	maxAiCredits?: number,
): () => void {
	if (credentials.has(id)) throw new Error("Planner session ID is already registered");
	credentials.set(id, { currentToken, maxAiCredits });
	return () => {
		if (credentials.get(id)?.currentToken === currentToken) credentials.delete(id);
	};
}

export async function shutdownHarnesses(): Promise<void> {
	credentials.clear();
	await selected?.shutdown();
	selected = undefined;
}
