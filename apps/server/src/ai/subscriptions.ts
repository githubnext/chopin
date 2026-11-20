import { createHash, randomBytes } from "node:crypto";

import type { SubscriptionProvider } from "@chopin/protocol/ai-credentials";

/**
 * Sign in with ChatGPT, as Atomic's `openai-chatgpt` OAuth does: a dynamic client whose issued
 * client id comes back on the callback, OpenAI's API as the resource, PKCE and state. A hosted
 * server can't receive the callback on 127.0.0.1, so the person pastes the address their browser was
 * sent to, as Atomic's manual path takes it.
 */
const CHATGPT = {
	clientId: "dynamic_agent_client",
	agentName: "Chopin",
	authorize: "https://auth.openai.com/api/accounts/authorize",
	token: "https://auth.openai.com/api/accounts/oauth/token",
	resource: "https://api.openai.com/v1",
	redirect: "http://127.0.0.1:1455/auth/callback",
	directScope: "chatgpt.tokens.use.direct",
	scope: "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
	marginMs: 3 * 60 * 1000,
};

/**
 * Claude's sign-in, as Atomic's Anthropic OAuth with the copy-the-code redirect does: PKCE with the
 * verifier as state, and the code Anthropic shows pasted back.
 */
const CLAUDE = {
	clientId: atob("OWQxYzI1MGEtZTYxYi00NGQ5LTg4ZWQtNTk0NGQxOTYyZjVl"),
	authorize: "https://claude.ai/oauth/authorize",
	token: "https://platform.claude.com/v1/oauth/token",
	redirect: "https://platform.claude.com/oauth/code/callback",
	scope:
		"org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload",
	skewMs: 5 * 60 * 1000,
	exchangeTimeoutMs: 30_000,
};

/** How long a refresh may take before Chopin gives up on it and tries again later. */
const REFRESH_TIMEOUT_MS = 60_000;
/** Lifetime assumed for an access token whose answer states none and that carries no `exp`. */
const DEFAULT_LIFETIME_MS = 60 * 60 * 1000;
/** Token endpoint codes that mean a refresh token can never be used again. */
const PERMANENT_REFRESH_CODES = new Set([
	"invalid_grant",
	"refresh_token_expired",
	"refresh_token_reused",
	"refresh_token_invalidated",
]);
const ERROR_CODE = /^[A-Za-z0-9_.:-]{1,64}$/;

export const SUBSCRIPTION_NAMES: Record<SubscriptionProvider, string> = {
	chatgpt: "ChatGPT",
	claude: "Claude",
};

/**
 * A subscription's tokens as Chopin keeps them, encrypted: the access token sent to the provider,
 * the refresh token that renews it, and when the access token is to be renewed (milliseconds since
 * the epoch, already short of when the provider says it expires). ChatGPT's issued client id and
 * granted scopes are kept for its refresh.
 */
export type SubscriptionTokens = {
	access: string;
	refresh: string;
	expires: number;
	clientId?: string;
	scopes?: string[];
};

/** A sign-in begun and not yet finished: what the provider's answer is checked against. */
export type PendingSignIn = {
	provider: SubscriptionProvider;
	verifier: string;
	state: string;
	url: string;
};

/** The token and authorize endpoints, each provider's own unless a test points them at fakes. */
export type SignInEndpoints = Partial<
	Record<SubscriptionProvider, { authorize?: string; token?: string }>
>;

/** Why a sign-in could not finish, in words for the person; `status` 502 when it may pass. */
export class SignInFailed extends Error {
	override name = "SignInFailed";
	constructor(message: string, readonly status = 422) {
		super(message);
	}
}

/** The provider refused a refresh for good: only signing in again helps. */
export class RefreshRefused extends Error {
	override name = "RefreshRefused";
}

function base64url(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString("base64url");
}

function pkce(): { verifier: string; challenge: string } {
	let verifier = base64url(randomBytes(32));
	return { verifier, challenge: base64url(createHash("sha256").update(verifier).digest()) };
}

function endpoint(
	endpoints: SignInEndpoints | undefined,
	provider: SubscriptionProvider,
	which: "authorize" | "token",
): string {
	return endpoints?.[provider]?.[which] ?? (provider === "chatgpt" ? CHATGPT : CLAUDE)[which];
}

/**
 * Begins a sign-in: the provider's authorize address for the person to open, with what its answer
 * is checked against. `hostId` is this deployment's own UUID, which ChatGPT takes as the agent host.
 */
export function beginSignIn(
	provider: SubscriptionProvider,
	hostId: string,
	endpoints?: SignInEndpoints,
): PendingSignIn {
	let { verifier, challenge } = pkce();
	let url = new URL(endpoint(endpoints, provider, "authorize"));
	if (provider === "chatgpt") {
		let state = base64url(randomBytes(32));
		url.search = new URLSearchParams({
			client_id: CHATGPT.clientId,
			agent_name_hint: CHATGPT.agentName,
			ext_agent_host_id: `urn:uuid:${hostId.toLowerCase()}`,
			response_type: "code",
			redirect_uri: CHATGPT.redirect,
			resource: CHATGPT.resource,
			scope: CHATGPT.scope,
			state,
			code_challenge: challenge,
			code_challenge_method: "S256",
			nonce: base64url(randomBytes(32)),
		}).toString();
		return { provider, verifier, state, url: url.toString() };
	}
	url.search = new URLSearchParams({
		code: "true",
		client_id: CLAUDE.clientId,
		response_type: "code",
		redirect_uri: CLAUDE.redirect,
		scope: CLAUDE.scope,
		code_challenge: challenge,
		code_challenge_method: "S256",
		state: verifier,
	}).toString();
	return { provider, verifier, state: verifier, url: url.toString() };
}

/**
 * What the person pasted, read as the provider's answer to `pending` before anything is sent: for
 * ChatGPT the callback address, whose origin and path must be the redirect's, with the same state
 * and an issued client id; for Claude the code, `code#state` or an address carrying them, whose
 * state, if any, must be the sign-in's.
 */
export function pastedAnswer(
	pending: PendingSignIn,
	input: string,
): { code: string; state: string; clientId?: string } {
	let value = input.trim();
	if (pending.provider === "chatgpt") {
		let url: URL;
		try {
			url = new URL(value);
		} catch {
			throw new SignInFailed("Paste the full address your browser opened after you signed in.");
		}
		let expected = new URL(CHATGPT.redirect);
		if (url.origin !== expected.origin || url.pathname !== expected.pathname) {
			throw new SignInFailed(`The address you paste starts with ${CHATGPT.redirect}.`);
		}
		let error = url.searchParams.get("error");
		if (error) {
			throw new SignInFailed(
				ERROR_CODE.test(error)
					? `ChatGPT didn't finish signing you in (${error}). Start again.`
					: "ChatGPT didn't finish signing you in. Start again.",
			);
		}
		let code = url.searchParams.get("code");
		if (!code) throw new SignInFailed("This address has no sign-in code. Paste the whole address.");
		let state = url.searchParams.get("state");
		if (!state || state !== pending.state) {
			throw new SignInFailed(
				"This address is from another sign-in. Paste the one from the sign-in you just opened.",
			);
		}
		let clientId = url.searchParams.get("client_id")?.trim();
		if (!clientId) {
			throw new SignInFailed("This address has no client ID from ChatGPT. Start again.");
		}
		return { code, state, clientId };
	}
	let parsed = claudeInput(value);
	if (parsed.state && parsed.state !== pending.state) {
		throw new SignInFailed(
			"This code is from another sign-in. Paste the one from the sign-in you just opened.",
		);
	}
	if (!parsed.code) throw new SignInFailed("Paste the code Claude shows after you sign in.");
	return { code: parsed.code, state: parsed.state ?? pending.state };
}

function claudeInput(value: string): { code?: string; state?: string } {
	if (!value) return {};
	try {
		let url = new URL(value);
		return {
			code: url.searchParams.get("code") ?? undefined,
			state: url.searchParams.get("state") ?? undefined,
		};
	} catch {
		// Not an address.
	}
	if (value.includes("#")) {
		let [code, state] = value.split("#", 2);
		return { code: code || undefined, state: state || undefined };
	}
	if (value.includes("code=")) {
		let params = new URLSearchParams(value);
		return {
			code: params.get("code") ?? undefined,
			state: params.get("state") ?? undefined,
		};
	}
	return { code: value };
}

function text(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value : undefined;
}

/** When a JWT access token says it expires, in milliseconds, or undefined. */
function jwtExpiry(access: string): number | undefined {
	let part = (access.split(".")[1] ?? "").replace(/-/g, "+").replace(/_/g, "/");
	try {
		let claims = JSON.parse(atob(part.padEnd(Math.ceil(part.length / 4) * 4, "="))) as {
			exp?: unknown;
		};
		return typeof claims.exp === "number" && Number.isFinite(claims.exp)
			? claims.exp * 1000
			: undefined;
	} catch {
		return undefined;
	}
}

/** As Atomic's `oauthTokenExpiry`: `expires_in`, else the JWT's `exp`, else an hour, less `skew`. */
function expiry(access: string, expiresIn: unknown, skew: number, now: number): number {
	if (typeof expiresIn === "number" && expiresIn > 0 && Number.isFinite(expiresIn)) {
		return now + expiresIn * 1000 - skew;
	}
	return (jwtExpiry(access) ?? now + DEFAULT_LIFETIME_MS) - skew;
}

type TokenAnswer = { status: number; body: Record<string, unknown> | undefined };

async function tokenRequest(
	send: typeof fetch,
	url: string,
	body: URLSearchParams | Record<string, string>,
	timeoutMs: number,
): Promise<TokenAnswer> {
	let form = body instanceof URLSearchParams;
	let response = await send(url, {
		method: "POST",
		headers: form
			? { accept: "application/json", "content-type": "application/x-www-form-urlencoded" }
			: { accept: "application/json", "content-type": "application/json" },
		body: body instanceof URLSearchParams ? body : JSON.stringify(body),
		redirect: "manual",
		signal: AbortSignal.timeout(timeoutMs),
	});
	let parsed: unknown;
	try {
		parsed = await response.json();
	} catch {
		parsed = undefined;
	}
	return {
		status: response.status,
		body: parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? parsed as Record<string, unknown>
			: undefined,
	};
}

/** The OAuth error code a token endpoint answered with, from `error`, `error.code` or `code`. */
function errorCode(body: Record<string, unknown> | undefined): string | undefined {
	let error = body?.error;
	let code = typeof error === "string"
		? error
		: error && typeof error === "object"
		? (error as { code?: unknown }).code
		: body?.code;
	return typeof code === "string" ? code : undefined;
}

/** Whether a refusal of a refresh is for good, as Atomic's `isPermanentRefreshRejection` says. */
function permanent(answer: TokenAnswer): boolean {
	let code = errorCode(answer.body)?.toLowerCase();
	return answer.status === 401 || (code !== undefined && PERMANENT_REFRESH_CODES.has(code));
}

/**
 * Exchanges the pasted answer for the subscription's tokens, as Atomic's login does at its end.
 * Throws `SignInFailed`, and stores nothing, when the provider refuses it or can't be reached.
 */
export async function finishSignIn(
	pending: PendingSignIn,
	answer: { code: string; state: string; clientId?: string },
	options: { fetch: typeof fetch; now: number; endpoints?: SignInEndpoints },
): Promise<SubscriptionTokens> {
	let name = SUBSCRIPTION_NAMES[pending.provider];
	let url = endpoint(options.endpoints, pending.provider, "token");
	let reply: TokenAnswer;
	try {
		reply = pending.provider === "chatgpt"
			? await tokenRequest(
				options.fetch,
				url,
				new URLSearchParams({
					grant_type: "authorization_code",
					client_id: answer.clientId!,
					code: answer.code,
					code_verifier: pending.verifier,
					redirect_uri: CHATGPT.redirect,
					resource: CHATGPT.resource,
				}),
				CLAUDE.exchangeTimeoutMs,
			)
			: await tokenRequest(
				options.fetch,
				url,
				{
					grant_type: "authorization_code",
					client_id: CLAUDE.clientId,
					code: answer.code,
					state: answer.state,
					redirect_uri: CLAUDE.redirect,
					code_verifier: pending.verifier,
				},
				CLAUDE.exchangeTimeoutMs,
			);
	} catch {
		throw new SignInFailed(
			`Chopin couldn't reach ${name} to finish signing you in. Start again in a moment.`,
			502,
		);
	}
	if (reply.status >= 500 || reply.status === 429) {
		throw new SignInFailed(
			`${name} couldn't finish signing you in just now. Start again in a moment.`,
			502,
		);
	}
	if (reply.status < 200 || reply.status >= 300 || !reply.body) {
		throw new SignInFailed(`${name} didn't accept this sign-in. Start again.`);
	}
	let tokens = pending.provider === "chatgpt"
		? chatgptTokens(reply.body, answer.clientId!, options.now)
		: claudeTokens(reply.body, options.now);
	if (!tokens) {
		throw new SignInFailed(`${name} answered without everything Chopin needs. Start again.`);
	}
	return tokens;
}

function chatgptTokens(
	body: Record<string, unknown>,
	clientId: string,
	now: number,
	presented?: string,
): SubscriptionTokens | undefined {
	let access = text(body.access_token);
	let scope = text(body.scope);
	if (!access || !scope) return undefined;
	let scopes = scope.trim().split(/\s+/).filter(Boolean);
	if (!scopes.includes(CHATGPT.directScope)) return undefined;
	if (presented !== undefined) {
		return {
			access,
			refresh: text(body.refresh_token) ?? presented,
			expires: expiry(access, body.expires_in, CHATGPT.marginMs, now),
			clientId,
			scopes,
		};
	}
	let refresh = text(body.refresh_token);
	let expiresIn = body.expires_in;
	if (
		!refresh || !text(body.id_token) || typeof expiresIn !== "number"
		|| !Number.isFinite(expiresIn) || expiresIn <= 0
	) return undefined;
	return { access, refresh, expires: now + expiresIn * 1000 - CHATGPT.marginMs, clientId, scopes };
}

function claudeTokens(
	body: Record<string, unknown>,
	now: number,
	presented?: string,
): SubscriptionTokens | undefined {
	let access = text(body.access_token);
	let refresh = text(body.refresh_token) ?? presented;
	if (!access || !refresh) return undefined;
	return { access, refresh, expires: expiry(access, body.expires_in, CLAUDE.skewMs, now) };
}

/**
 * Renews a subscription's access token with its refresh token, as Atomic's refresh does, keeping
 * the refresh token presented when the provider issues none. Throws `RefreshRefused` when the
 * provider refuses it for good (a 401, or `invalid_grant` and its kin), and any other error when the
 * refresh couldn't be made or its answer can't be used, which a later refresh may not meet.
 */
export async function refreshSignIn(
	provider: SubscriptionProvider,
	tokens: SubscriptionTokens,
	options: { fetch: typeof fetch; now: () => number; endpoints?: SignInEndpoints },
): Promise<SubscriptionTokens> {
	let url = endpoint(options.endpoints, provider, "token");
	if (provider === "chatgpt" && !tokens.clientId) throw new RefreshRefused("no issued client id");
	let reply = provider === "chatgpt"
		? await tokenRequest(
			options.fetch,
			url,
			new URLSearchParams({
				grant_type: "refresh_token",
				client_id: tokens.clientId!,
				refresh_token: tokens.refresh,
				resource: CHATGPT.resource,
			}),
			REFRESH_TIMEOUT_MS,
		)
		: await tokenRequest(
			options.fetch,
			url,
			{ grant_type: "refresh_token", client_id: CLAUDE.clientId, refresh_token: tokens.refresh },
			REFRESH_TIMEOUT_MS,
		);
	if (reply.status < 200 || reply.status >= 300) {
		if (permanent(reply)) throw new RefreshRefused(`refused with ${reply.status}`);
		throw new Error(`the token endpoint answered ${reply.status}`);
	}
	let renewed = reply.body && (provider === "chatgpt"
		? chatgptTokens(reply.body, tokens.clientId!, options.now(), tokens.refresh)
		: claudeTokens(reply.body, options.now(), tokens.refresh));
	if (!renewed) throw new Error("the token endpoint answered without a usable token");
	return renewed;
}
