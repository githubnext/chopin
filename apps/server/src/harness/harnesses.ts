import { createCopilotSdk } from "./copilot-sdk/adapter";

import type { HarnessV1 } from "@ai-sdk/harness";

const credentials = new Map<string, {
	currentToken: () => string | undefined;
	maxAiCredits?: number;
}>();

export const harnesses = {
	"copilot-sdk": createCopilotSdk,
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

export function harnessFor(config: {
	harness: string;
	harnessAuth?: string;
	host?: string;
}): HarnessV1 {
	if (!Object.hasOwn(harnesses, config.harness)) {
		throw new Error(`Unknown harness: ${config.harness}`);
	}
	let auth = config.harnessAuth;
	if (auth && auth !== "direct" && auth !== "ai-gateway" && !loopback(config.host ?? "127.0.0.1")) {
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
