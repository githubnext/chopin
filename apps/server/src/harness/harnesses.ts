import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";

import { ATOMIC_AUTH_MODES, createAtomicAdapter } from "./atomic/adapter";
import { forgetWorkspaces, workflowJournal } from "./atomic/workspace";
import { createCopilotSdk } from "./copilot-sdk/adapter";
import { withModelOutput } from "./model-output";
import { createRemoteAdapter } from "./remote/adapter";
import { readingOutput } from "../agent/reading-output";
import { remoteCatalog } from "./catalog";
import { attachedLink } from "./remote/registry";

import type { HarnessV1 } from "@ai-sdk/harness";
import type { Chat as Wire } from "@chopin/protocol";
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
		journal: workflowJournal(),
	});
}

/** The model runs in a client attached over the agent connection, so the server holds no credential. */
function createRemoteHarness(): HarnessV1 & { shutdown(): Promise<void> } {
	return createRemoteAdapter();
}

/** Each real harness shows the model `read_plan` and `read_child` as text; see `withModelOutput`. */
function reading<Settings>(
	create: (settings: Settings) => HarnessV1 & { shutdown(): Promise<void> },
) {
	return (settings: Settings) => withModelOutput(create(settings), readingOutput);
}

export const harnesses = {
	"copilot-sdk": reading(createCopilotSdk),
	atomic: reading(createAtomicHarness),
	remote: reading(createRemoteHarness),
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

/**
 * The models a document's Planner can be set to run, or none where its harness cannot honor a
 * choice: Atomic's runtime offers its models, a remote Planner offers what its attached client
 * reported (an older client reported nothing), and every other harness offers nothing.
 */
export async function plannerCatalog(
	harness: string,
	channelId: string,
	operatorModel: string | undefined,
): Promise<Wire.ModelCatalog | undefined> {
	if (harness === "remote") return remoteCatalog(attachedLink(channelId)?.catalog, operatorModel);
	let atomic = selected as { catalog?: (model: string | undefined) => Promise<Wire.ModelCatalog> };
	if (harness === "atomic" && atomic?.catalog) return atomic.catalog(operatorModel);
	return undefined;
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
