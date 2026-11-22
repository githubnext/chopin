import type {
	AiCredentialSummary,
	AiProvider,
	AiSignInStart,
	ConnectAiCredential,
	SubscriptionProvider,
} from "@chopin/protocol/ai-credentials";

export const GET_COPILOT_URL = "https://github.com/features/copilot";

export type KeyProvider = Exclude<AiProvider, "github-copilot" | SubscriptionProvider>;

export const KEY_PROVIDERS: readonly KeyProvider[] = ["openai", "anthropic"];

export const PROVIDER_NAMES: Record<AiProvider, string> = {
	"github-copilot": "GitHub Copilot",
	openai: "OpenAI",
	anthropic: "Anthropic",
	chatgpt: "ChatGPT",
	claude: "Claude",
};

export const SIGN_IN_PROVIDERS: readonly SubscriptionProvider[] = ["chatgpt", "claude"];

const SIGN_IN_MISSING: Record<SubscriptionProvider, string> = {
	chatgpt: "Use OpenAI models with your ChatGPT plan.",
	claude: "Use Claude models with your Claude plan.",
};

const MISSING_LINES: Record<KeyProvider, string> = {
	openai: "Use OpenAI models with your own key.",
	anthropic: "Use Claude models with your own key.",
};

export type AccountBadge = {
	tone: "success" | "neutral" | "warning";
	label: "Connected" | "No Copilot access" | "Checking…" | "Not checked" | "Needs reconnecting";
};

export type AccountAction =
	| "add-key"
	| "replace"
	| "remove"
	| "use-token"
	| "use-sign-in"
	| "sign-in"
	| "disconnect";

export type AccountRow = {
	provider: AiProvider;
	name: string;
	badge?: AccountBadge;
	lines: string[];
	getCopilot: boolean;
	/** What the row's state asks for, on the row itself: connecting, or connecting again. */
	action?: AccountAction;
	/** Everything else the row offers, in its menu. */
	more: AccountAction[];
};

const CONNECTED: AccountBadge = { tone: "success", label: "Connected" };
const NO_ACCESS: AccountBadge = { tone: "neutral", label: "No Copilot access" };
const CHECKING: AccountBadge = { tone: "neutral", label: "Checking…" };
const NOT_CHECKED: AccountBadge = { tone: "neutral", label: "Not checked" };
const NEEDS_RECONNECTING: AccountBadge = { tone: "warning", label: "Needs reconnecting" };
const NOT_CHECKED_SIGN_IN =
	"Chopin couldn't check for Copilot access through your GitHub sign-in. It checks again when you open this page.";
const NOT_CHECKED_TOKEN =
	"Chopin couldn't check this token for Copilot access. It checks again when you open this page.";

function whyReconnect(
	summary: AiCredentialSummary,
	provider: string,
	secret: "key" | "token",
): string | undefined {
	if (summary.unusable) {
		return `Chopin can't read this ${secret} anymore. Replace it to keep using it.`;
	}
	if (summary.rejectedAt) {
		return `${provider} no longer accepts this ${secret}. Replace it to keep using it.`;
	}
	return undefined;
}

/**
 * The GitHub Copilot row. While the check the page runs as it opens is under way (`checking`), a
 * row with an answer keeps it, and one without says it is checking. Whatever GitHub answered, the
 * sign-in can always give way to a token, and a token can always be replaced or give way to the
 * sign-in.
 */
function copilotRow(summary: AiCredentialSummary | undefined, checking: boolean): AccountRow {
	let name = PROVIDER_NAMES["github-copilot"];
	let token = summary?.kind === "api-key";
	let ending = summary?.kind === "api-key" && summary.suffix
		? [`Token ending ${summary.suffix}`]
		: [];
	let reconnect = summary?.kind === "api-key"
		? whyReconnect(summary, "GitHub", "token")
		: undefined;
	if (reconnect) {
		return {
			provider: "github-copilot",
			name,
			badge: NEEDS_RECONNECTING,
			lines: [...ending, reconnect],
			getCopilot: false,
			action: "replace",
			more: ["use-sign-in"],
		};
	}
	let switches: AccountAction[] = token ? ["replace", "use-sign-in"] : ["use-token"];
	if (summary?.copilotAccess === "access") {
		return {
			provider: "github-copilot",
			name,
			badge: CONNECTED,
			lines: token ? ending : ["Your GitHub sign-in"],
			getCopilot: false,
			more: switches,
		};
	}
	if (summary?.copilotAccess === "none") {
		return {
			provider: "github-copilot",
			name,
			badge: NO_ACCESS,
			lines: token
				? [...ending, "This token's GitHub account has no Copilot subscription."]
				: ["Your GitHub account has no Copilot subscription."],
			getCopilot: true,
			more: switches,
		};
	}
	if (checking) {
		return {
			provider: "github-copilot",
			name,
			badge: CHECKING,
			lines: token ? ending : ["Your GitHub sign-in"],
			getCopilot: false,
			more: switches,
		};
	}
	return {
		provider: "github-copilot",
		name,
		badge: NOT_CHECKED,
		lines: token ? [...ending, NOT_CHECKED_TOKEN] : ["Your GitHub sign-in", NOT_CHECKED_SIGN_IN],
		getCopilot: false,
		more: switches,
	};
}

function signInRow(
	provider: SubscriptionProvider,
	summary: AiCredentialSummary | undefined,
): AccountRow {
	let name = PROVIDER_NAMES[provider];
	if (!summary) {
		return {
			provider,
			name,
			lines: [SIGN_IN_MISSING[provider]],
			getCopilot: false,
			action: "sign-in",
			more: [],
		};
	}
	let yours = `Your ${name} sign-in`;
	if (summary.unusable || summary.rejectedAt) {
		return {
			provider,
			name,
			badge: NEEDS_RECONNECTING,
			lines: [
				summary.unusable
					? "Chopin can't read this sign-in anymore. Sign in again to keep using it."
					: `${name} ended this sign-in. Sign in again to keep using it.`,
			],
			getCopilot: false,
			action: "sign-in",
			more: ["disconnect"],
		};
	}
	if (summary.unchecked) {
		return {
			provider,
			name,
			badge: NOT_CHECKED,
			lines: [yours, "Chopin couldn't finish checking this sign-in."],
			getCopilot: false,
			more: ["disconnect"],
		};
	}
	return {
		provider,
		name,
		badge: CONNECTED,
		lines: [yours],
		getCopilot: false,
		more: ["disconnect"],
	};
}

function keyRow(provider: KeyProvider, summary: AiCredentialSummary | undefined): AccountRow {
	let name = PROVIDER_NAMES[provider];
	if (!summary) {
		return {
			provider,
			name,
			lines: [MISSING_LINES[provider]],
			getCopilot: false,
			action: "add-key",
			more: [],
		};
	}
	let ending = summary.suffix ? [`Key ending ${summary.suffix}`] : [];
	let reconnect = whyReconnect(summary, name, "key");
	if (reconnect) {
		return {
			provider,
			name,
			badge: NEEDS_RECONNECTING,
			lines: [...ending, reconnect],
			getCopilot: false,
			action: "replace",
			more: ["remove"],
		};
	}
	return {
		provider,
		name,
		badge: CONNECTED,
		lines: ending,
		getCopilot: false,
		more: ["replace", "remove"],
	};
}

export function accountRows(
	credentials: readonly AiCredentialSummary[],
	checking = false,
): { signIns: AccountRow[]; keys: AccountRow[] } {
	let find = (provider: AiProvider) =>
		credentials.find(credential => credential.provider === provider);
	return {
		signIns: [
			copilotRow(find("github-copilot"), checking),
			...SIGN_IN_PROVIDERS.map(provider => signInRow(provider, find(provider))),
		],
		keys: KEY_PROVIDERS.map(provider => keyRow(provider, find(provider))),
	};
}

export function withCredential(
	credentials: readonly AiCredentialSummary[],
	changed: AiCredentialSummary,
): AiCredentialSummary[] {
	let others = credentials.filter(credential => credential.provider !== changed.provider);
	return [...others, changed];
}

/**
 * `credentials` with `checked`, the answer of the Copilot check the page ran as it opened, unless the
 * GitHub Copilot listed is no longer the credential it checked: one connected or switched since keeps
 * its own answer.
 */
export function withCheck(
	credentials: AiCredentialSummary[],
	checked: AiCredentialSummary,
): AiCredentialSummary[] {
	let listed = credentials.find(credential => credential.provider === "github-copilot");
	let same = listed?.kind === checked.kind && listed.updatedAt === checked.updatedAt
		&& listed.suffix === checked.suffix;
	return same ? withCredential(credentials, checked) : credentials;
}

export function withoutCredential(
	credentials: readonly AiCredentialSummary[],
	provider: AiProvider,
): AiCredentialSummary[] {
	return credentials.filter(credential => credential.provider !== provider);
}

export class AiAccountsError extends Error {
	override name = "AiAccountsError";
	constructor(message: string, readonly status: number, readonly restart = false) {
		super(message);
	}
}

const UNREACHABLE = "Couldn't reach Chopin. Check your connection, then try again.";
const SIGNED_OUT = "Your Chopin session has ended. Sign in again to change your AI accounts.";
const FAILED = "Something went wrong. Try again in a moment.";
const SAID_TO_PEOPLE = new Set([422, 502]);

async function answered<T>(response: Promise<Response>): Promise<T | undefined> {
	let reply: Response;
	try {
		reply = await response;
	} catch {
		throw new AiAccountsError(UNREACHABLE, 0);
	}
	if (reply.status === 204) return undefined;
	let body = await reply.json().catch(() => undefined) as
		| { error?: unknown; restart?: unknown }
		| undefined;
	if (!reply.ok) {
		let said = typeof body?.error === "string" ? body.error : undefined;
		let message = said && SAID_TO_PEOPLE.has(reply.status)
			? said
			: reply.status === 401
			? SIGNED_OUT
			: FAILED;
		throw new AiAccountsError(message, reply.status, body?.restart === true);
	}
	return body as T;
}

const JSON_HEADERS = { "content-type": "application/json" };

export async function listCredentials(signal?: AbortSignal): Promise<AiCredentialSummary[]> {
	let list = await answered<{ credentials: AiCredentialSummary[] }>(
		fetch("/api/ai/credentials", { signal }),
	);
	return list?.credentials ?? [];
}

export async function connectCredential(
	provider: AiProvider,
	input: ConnectAiCredential,
): Promise<AiCredentialSummary> {
	return (await answered<AiCredentialSummary>(
		fetch(`/api/ai/credentials/${provider}`, {
			method: "PUT",
			headers: JSON_HEADERS,
			body: JSON.stringify(input),
		}),
	))!;
}

export async function removeCredential(provider: AiProvider): Promise<void> {
	try {
		await answered(fetch(`/api/ai/credentials/${provider}`, { method: "DELETE" }));
	} catch (error) {
		if (error instanceof AiAccountsError && error.status === 404) return;
		throw error;
	}
}

/** Asks GitHub again, through Chopin, whether the person's GitHub Copilot has Copilot access. */
export async function checkCopilot(signal?: AbortSignal): Promise<AiCredentialSummary> {
	return (await answered<AiCredentialSummary>(
		fetch("/api/ai/credentials/github-copilot/check", { method: "POST", signal }),
	))!;
}

export async function startSignIn(provider: SubscriptionProvider): Promise<string> {
	return (await answered<AiSignInStart>(
		fetch(`/api/ai/sign-ins/${provider}`, { method: "POST" }),
	))!.url;
}

export async function finishSignIn(
	provider: SubscriptionProvider,
	input: string,
): Promise<AiCredentialSummary> {
	return (await answered<AiCredentialSummary>(
		fetch(`/api/ai/sign-ins/${provider}/finish`, {
			method: "POST",
			headers: JSON_HEADERS,
			body: JSON.stringify({ input }),
		}),
	))!;
}
