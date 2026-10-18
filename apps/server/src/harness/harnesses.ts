import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";

import { ATOMIC_AUTH_MODES, createAtomicAdapter } from "./atomic/adapter";
import { forgetWorkspaces, workflowJournal } from "./atomic/workspace";
import { createCopilotSdk } from "./copilot-sdk/adapter";
import { createRemoteAdapter } from "./remote/adapter";

import type { HarnessV1 } from "@ai-sdk/harness";
import type { AtomicAuthMode } from "./atomic/adapter";

const credentials = new Map<string, {
	currentToken: () => string | undefined;
	maxAiCredits?: number;
}>();

function createAtomicHarness(
	settings: { auth?: string; extensions?: readonly string[] },
): HarnessV1 & { shutdown(): Promise<void> } {
	// Atomic takes neither a GitHub credential nor a credit limit; only `auth` (validated by
	// `harnessFor` below), the extensions, and the workflow journal reach the real adapter.
	return createAtomicAdapter({
		auth: settings.auth as AtomicAuthMode,
		extensions: settings.extensions,
		journal: process.env.ATOMIC_WORKFLOW_JOURNAL_PATH || workflowJournal(),
	});
}

/** The model runs in a client attached over the agent connection, so the server holds no credential. */
function createRemoteHarness(): HarnessV1 & { shutdown(): Promise<void> } {
	return createRemoteAdapter();
}

export const harnesses = {
	"copilot-sdk": createCopilotSdk,
	atomic: createAtomicHarness,
	remote: createRemoteHarness,
} satisfies Record<
	string,
	(settings: {
		credentials: (id: string) => string | undefined;
		limits: (id: string) => { maxAiCredits: number } | undefined;
		auth?: string;
		extensions?: readonly string[];
	}) => HarnessV1
>;

export type HarnessName = keyof typeof harnesses;

let selected: (HarnessV1 & { shutdown(): Promise<void> }) | undefined;

function loopback(host: string): boolean {
	return host === "localhost" || host === "::1" || host === "[::1]"
		|| /^127(?:\.\d{1,3}){3}$/.test(host)
			&& host.split(".").slice(1).every(part => Number(part) <= 255);
}

/** Harnesses whose auth modes are validated explicitly; only `ai-gateway`
 * avoids a host login and may serve a non-loopback bind. */
const AUTH_MODES = new Map<string, ReadonlySet<string>>([
	["atomic", new Set(ATOMIC_AUTH_MODES)],
]);

/** Only the atomic Planner loads operator extensions, each an existing absolute path. */
function checkedExtensions(harness: string, extensions: readonly string[] = []): readonly string[] {
	if (extensions.length && harness !== "atomic") {
		throw new Error(`HARNESS_EXTENSIONS requires HARNESS=atomic, not ${harness}`);
	}
	for (let path of extensions) {
		if (!isAbsolute(path)) throw new Error(`HARNESS_EXTENSIONS path ${path} must be absolute`);
		if (!existsSync(path)) throw new Error(`HARNESS_EXTENSIONS path ${path} does not exist`);
	}
	return extensions;
}

export function harnessFor(config: {
	harness: string;
	harnessAuth?: string;
	harnessExtensions?: readonly string[];
	host?: string;
}): HarnessV1 {
	if (!Object.hasOwn(harnesses, config.harness)) {
		throw new Error(`Unknown harness: ${config.harness}`);
	}
	let extensions = checkedExtensions(config.harness, config.harnessExtensions);
	let auth = config.harnessAuth;
	if (config.harness === "remote" && auth) {
		throw new Error(
			"HARNESS_AUTH does not apply to HARNESS=remote: the model runs in the attached client",
		);
	}
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
		extensions,
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
	forgetWorkspaces();
}
