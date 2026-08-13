export type AuthConfig =
	| { driver: "off" }
	| {
		driver: "github";
		origin: string;
		clientId: string;
		clientSecret: string;
		encryptionKey: Uint8Array;
	};

function origin(raw: string | undefined): string {
	if (!raw) throw new Error("APP_ORIGIN is required when AUTH_DRIVER=github");
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

export function loadAuth(): AuthConfig {
	let driver = process.env.AUTH_DRIVER || "off";
	if (driver === "off") return { driver };
	if (driver !== "github") {
		throw new Error(`AUTH_DRIVER must be "off" or "github", got ${JSON.stringify(driver)}`);
	}

	let clientId = process.env.GITHUB_OAUTH_CLIENT_ID;
	let clientSecret = process.env.GITHUB_OAUTH_CLIENT_SECRET;
	if (!clientId) throw new Error("GITHUB_OAUTH_CLIENT_ID is required when AUTH_DRIVER=github");
	if (!clientSecret) {
		throw new Error("GITHUB_OAUTH_CLIENT_SECRET is required when AUTH_DRIVER=github");
	}
	return {
		driver,
		origin: origin(process.env.APP_ORIGIN),
		clientId,
		clientSecret,
		encryptionKey: encryptionKey(process.env.SESSION_ENCRYPTION_KEY),
	};
}
