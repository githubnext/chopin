/**
 * What a client needs of the server's HTTP side: a signed-in session through the fake GitHub of
 * `e2e/github.ts`, and a tally of every answer, so a run can say which were not 2xx.
 */

export type Answer = { what: string; status: number | undefined; at: number; body?: string };

/** Counts calls and keeps each one that was not answered 2xx. */
export class Calls {
	calls = 0;
	failures: Answer[] = [];

	record(what: string, status: number | undefined, body?: string, expected: number[] = []): void {
		this.calls++;
		if (status === undefined || (status < 200 || status >= 300) && !expected.includes(status)) {
			this.failures.push({ what, status, at: performance.now(), body: body?.slice(0, 200) });
		}
	}

	/** One request, counted: the status is the answer's, or undefined when there was none. */
	async fetch(
		what: string,
		input: string,
		init: RequestInit = {},
		expected: number[] = [],
	): Promise<Response | undefined> {
		try {
			let response = await fetch(input, { signal: AbortSignal.timeout(30_000), ...init });
			this.record(what, response.status, undefined, expected);
			return response;
		} catch (error) {
			this.record(what, undefined, String(error));
			return undefined;
		}
	}
}

const cookies = (headers: Headers) =>
	(headers as Headers & { getSetCookie(): string[] }).getSetCookie().map(value =>
		value.split(";", 1)[0]!
	);

/** Signs `handle` in the way a person's browser does, against the fake GitHub: the session cookie. */
export async function signIn(origin: string, handle: string): Promise<string> {
	let started = await fetch(new URL("/auth/github", origin), { redirect: "manual" });
	let state = new URL(started.headers.get("location")!).searchParams.get("state");
	if (started.status !== 302 || !state) throw new Error(`sign-in did not start: ${started.status}`);
	let callback = await fetch(
		`${origin}/auth/github/callback?code=e2e-${encodeURIComponent(handle)}&state=${
			encodeURIComponent(state)
		}`,
		{ headers: { cookie: cookies(started.headers)[0]! }, redirect: "manual" },
	);
	let session = cookies(callback.headers).find(value => value.startsWith("chopin_session="));
	if (callback.status !== 303 || !session) {
		throw new Error(`sign-in set no session: ${callback.status}`);
	}
	return session;
}

/** The ghu_ token the fake GitHub gives `handle`, which `/mcp` and the agent link take as a bearer. */
export const bearerOf = (handle: string) => `ghu_e2e_${handle}_1`;
