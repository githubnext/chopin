import { createHash } from "node:crypto";
export type AuthConfig = {
	origin: string;
	appSlug: string;
	clientId: string;
	clientSecret?: string;
	encryptionKey: Uint8Array;
	allowedUsers?: ReadonlySet<string>;
	allowedOrganizations?: ReadonlySet<string>;
	local?: { installation: string; credentialsDir: string; port: number };
};

const GITHUB_USER_LOGIN = /^[a-z0-9](?:[a-z0-9_-]{0,37}[a-z0-9_])?$/i;
const GITHUB_ORGANIZATION_LOGIN = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,38}$/i;

function origin(raw: string | undefined): string {
	if (!raw) throw new Error("APP_ORIGIN is required");
	let parsed: URL;
	try {
		parsed = new URL(raw);
	} catch {
		throw new Error("APP_ORIGIN must be an HTTP or HTTPS origin");
	}
	if (
		parsed.origin !== raw
		|| (parsed.protocol !== "http:" && parsed.protocol !== "https:")
		|| parsed.username
		|| parsed.password
		|| parsed.pathname !== "/"
		|| parsed.search
		|| parsed.hash
	) throw new Error("APP_ORIGIN must contain only an HTTP or HTTPS origin");

	let loopback = parsed.hostname === "localhost"
		|| parsed.hostname === "127.0.0.1"
		|| parsed.hostname === "[::1]";
	if (parsed.protocol !== "https:" && !loopback) {
		throw new Error("APP_ORIGIN must use HTTPS unless it is loopback development");
	}
	return parsed.origin;
}

function encryptionKey(raw: string | undefined): Uint8Array {
	if (!raw || !/^[0-9a-f]{64}$/i.test(raw)) {
		throw new Error("SESSION_ENCRYPTION_KEY must be exactly 32 bytes encoded as 64 hex characters");
	}
	return new Uint8Array(Buffer.from(raw, "hex"));
}

function allowed(
	name: string,
	raw: string | undefined,
	login: RegExp,
): ReadonlySet<string> | undefined {
	if (!raw?.trim()) return undefined;
	let values = raw.split(",").map(value => value.trim().toLowerCase());
	if (values.some(value => !login.test(value))) {
		throw new Error(`${name} must be a comma-separated list of GitHub logins`);
	}
	return new Set(values);
}

export function loadAuth(port = 8787, host = process.env.SERVER_HOST || "127.0.0.1"): AuthConfig {
	let appSlug = process.env.GITHUB_APP_SLUG;
	let clientId = process.env.GITHUB_APP_CLIENT_ID;
	let clientSecret = process.env.GITHUB_APP_CLIENT_SECRET;
	let mode = process.env.AUTH_MODE || "hosted";
	if (mode !== "hosted" && mode !== "local") throw new Error("AUTH_MODE must be hosted or local");
	if (!appSlug || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(appSlug)) {
		throw new Error("GITHUB_APP_SLUG must be a lowercase GitHub App slug");
	}
	if (!clientId) throw new Error("GITHUB_APP_CLIENT_ID is required");
	if (!clientSecret && mode === "hosted") {
		throw new Error("GITHUB_APP_CLIENT_SECRET is required");
	}
	let appOrigin = origin(process.env.APP_ORIGIN);
	if (
		mode === "local" && (
			!["127.0.0.1", "::1", "localhost"].includes(host)
			|| !["localhost", "127.0.0.1", "[::1]"].includes(new URL(appOrigin).hostname)
			|| Number(new URL(appOrigin).port || (new URL(appOrigin).protocol === "https:" ? 443 : 80))
				!== port
		)
	) throw new Error("AUTH_MODE=local requires a loopback SERVER_HOST and APP_ORIGIN on PORT");
	return {
		origin: appOrigin,
		appSlug,
		clientId,
		...(clientSecret ? { clientSecret } : {}),
		encryptionKey: encryptionKey(process.env.SESSION_ENCRYPTION_KEY),
		...(mode === "local"
			? {
				local: {
					installation: createHash("sha256")
						.update(JSON.stringify([process.env.DATABASE_URL, appOrigin, clientId]))
						.digest("hex"),
					credentialsDir: process.env.CHOPIN_LOCAL_CREDENTIALS_DIR || (
						process.platform === "win32"
							? `${process.env.APPDATA || process.env.USERPROFILE}/Chopin`
							: process.platform === "darwin"
							? `${process.env.HOME}/Library/Application Support/Chopin`
							: `${process.env.XDG_CONFIG_HOME || `${process.env.HOME}/.config`}/chopin`
					),
					port,
				},
			}
			: {}),
		allowedUsers: allowed(
			"GITHUB_ALLOWED_USERS",
			process.env.GITHUB_ALLOWED_USERS,
			GITHUB_USER_LOGIN,
		),
		allowedOrganizations: allowed(
			"GITHUB_ALLOWED_ORGANIZATIONS",
			process.env.GITHUB_ALLOWED_ORGANIZATIONS,
			GITHUB_ORGANIZATION_LOGIN,
		),
	};
}
