import type { GitHubTokenGrant } from "../github/client";

export type DeviceCode = {
	deviceCode: string;
	userCode: string;
	verificationUri: string;
	expiresIn: number;
	interval: number;
};

export type DevicePoll =
	| { status: "pending" }
	| { status: "slow_down"; interval?: number }
	| { status: "denied" | "expired" }
	| { status: "granted"; grant: GitHubTokenGrant }
	| { status: "failed"; message: string }
	| { status: "transient" };

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export class DeviceAuthorization {
	readonly #fetch: Fetch;
	readonly #codeUrl: string;
	readonly #tokenUrl: string;

	constructor(options: {
		fetch?: Fetch;
		codeUrl?: string;
		tokenUrl?: string;
	} = {}) {
		this.#fetch = options.fetch ?? fetch;
		this.#codeUrl = options.codeUrl ?? "https://github.com/login/device/code";
		this.#tokenUrl = options.tokenUrl ?? "https://github.com/login/oauth/access_token";
	}

	async #post(url: string, parameters: Record<string, string>, signal?: AbortSignal) {
		let response = await this.#fetch(url, {
			method: "POST",
			headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams(parameters),
			redirect: "error",
			signal,
		});
		let body: unknown;
		try {
			body = await response.json();
		} catch {
			throw new Error("GitHub returned an unreadable device response");
		}
		if (!body || typeof body !== "object" || Array.isArray(body)) {
			throw new Error("GitHub returned an invalid device response");
		}
		return { response, body: body as Record<string, unknown> };
	}

	async request(clientId: string, signal?: AbortSignal): Promise<DeviceCode> {
		let { response, body } = await this.#post(this.#codeUrl, { client_id: clientId }, signal);
		if (
			!response.ok || typeof body.device_code !== "string" || !body.device_code
			|| typeof body.user_code !== "string" || !body.user_code
			|| typeof body.verification_uri !== "string"
			|| !Number.isSafeInteger(body.expires_in) || (body.expires_in as number) <= 0
			|| (body.interval !== undefined && (!Number.isSafeInteger(body.interval)
				|| (body.interval as number) <= 0))
		) {
			throw new Error("GitHub returned an invalid device code");
		}
		let uri = new URL(body.verification_uri);
		if (uri.protocol !== "https:" || uri.hostname !== "github.com") {
			throw new Error("GitHub returned an invalid verification URL");
		}
		return {
			deviceCode: body.device_code,
			userCode: body.user_code,
			verificationUri: body.verification_uri,
			expiresIn: body.expires_in as number,
			interval: body.interval as number | undefined ?? 5,
		};
	}

	async poll(clientId: string, deviceCode: string, signal?: AbortSignal): Promise<DevicePoll> {
		let response: Response;
		let body: Record<string, unknown>;
		try {
			({ response, body } = await this.#post(this.#tokenUrl, {
				client_id: clientId,
				device_code: deviceCode,
				grant_type: "urn:ietf:params:oauth:grant-type:device_code",
			}, signal));
		} catch (err) {
			if (signal?.aborted) throw err;
			return {
				status: err instanceof Error && err.message.startsWith("GitHub returned")
					? "failed"
					: "transient",
				...(err instanceof Error && err.message.startsWith("GitHub returned")
					? { message: err.message }
					: {}),
			} as DevicePoll;
		}
		switch (body.error) {
			case "authorization_pending":
				return { status: "pending" };
			case "slow_down":
				return {
					status: "slow_down",
					...(Number.isSafeInteger(body.interval) && (body.interval as number) > 0
						? { interval: body.interval as number }
						: {}),
				};
			case "access_denied":
				return { status: "denied" };
			case "expired_token":
			case "token_expired":
				return { status: "expired" };
		}
		if (response.status >= 500 || response.status === 429) return { status: "transient" };
		if (body.error || !response.ok) {
			return { status: "failed", message: "GitHub rejected device authorization" };
		}
		if (
			typeof body.access_token !== "string" || !body.access_token
			|| typeof body.refresh_token !== "string" || !body.refresh_token
			|| body.token_type !== "bearer"
			|| !Number.isSafeInteger(body.expires_in) || (body.expires_in as number) <= 0
			|| !Number.isSafeInteger(body.refresh_token_expires_in)
			|| (body.refresh_token_expires_in as number) <= 0
		) {
			return { status: "failed", message: "GitHub returned an invalid expiring user token" };
		}
		return {
			status: "granted",
			grant: {
				accessToken: body.access_token,
				accessExpiresIn: body.expires_in as number,
				refreshToken: body.refresh_token,
				refreshExpiresIn: body.refresh_token_expires_in as number,
			},
		};
	}
}
