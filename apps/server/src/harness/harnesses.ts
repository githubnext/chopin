import { createCopilotSdk } from "./copilot-sdk/adapter";

import type { HarnessV1 } from "@ai-sdk/harness";

const credentials = new Map<string, () => string | undefined>();

export const harnesses = {
	"copilot-sdk": createCopilotSdk,
} satisfies Record<
	string,
	(settings: { credentials: (id: string) => string | undefined }) => HarnessV1
>;

export type HarnessName = keyof typeof harnesses;

const defaultHarness = createCopilotSdk({ credentials: id => credentials.get(id)?.() });

export function harnessFor(config: { harness: string }): HarnessV1 {
	if (config.harness !== "copilot-sdk") throw new Error(`Unknown harness: ${config.harness}`);
	return defaultHarness;
}

export function registerCredential(id: string, currentToken: () => string | undefined): () => void {
	if (credentials.has(id)) throw new Error("Planner session ID is already registered");
	credentials.set(id, currentToken);
	return () => {
		if (credentials.get(id) === currentToken) credentials.delete(id);
	};
}

export async function shutdownHarnesses(): Promise<void> {
	credentials.clear();
	await defaultHarness.shutdown();
}
