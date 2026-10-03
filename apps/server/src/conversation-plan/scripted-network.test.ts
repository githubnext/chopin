import { expect, it, mock } from "bun:test";

import { createScriptedFetch } from "../../../../e2e/harness/scripted-network";

it("rejects unhandled, malformed and credential-bearing URLs before native fetch", async () => {
	let native = mock(async () => new Response("unexpected network"));
	let fetch = createScriptedFetch(native);
	let rejected = [
		"https://provider.invalid/secret-path?token=confidential",
		"https://api.github.com/user",
		"https://api.githubcopilot.com/mcp/",
		"http://127.0.0.1:8789/",
		"http://127.0.0.1:8792/",
		"http://127.0.0.1/",
		"http://localhost:8788/",
		"http://[::1]:8788/",
		"https://127.0.0.1:8788/",
		"ftp://127.0.0.1:8797/",
		"file:///secret-path",
		"http://confidential:password@127.0.0.1:8788/",
		"http://confidential@127.0.0.1:8797/",
		"not-a-url-confidential",
		"/relative-confidential",
		"",
	];
	for (let input of rejected) {
		await expect(fetch(input)).rejects.toThrow(Error);
	}
	await expect(fetch(new URL("http://remote.invalid:8788/"))).rejects.toThrow(Error);
	await expect(fetch(new Request("https://remote.invalid/"))).rejects.toThrow(Error);
	await expect(fetch({ secret: "confidential" } as unknown as string)).rejects.toThrow(Error);
	expect(native).not.toHaveBeenCalled();
});

it("delegates only the two fixture origins with native redirect following disabled", async () => {
	let response = new Response(null, {
		status: 302,
		headers: { location: "https://remote.invalid/secret-path" },
	});
	let native = mock(async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
		expect(new Request(_input, init).redirect).toBe("error");
		return response;
	});
	let fetch = createScriptedFetch(native);
	for (let redirect of [undefined, "follow", "manual", "error"] as const) {
		for (let input of ["http://127.0.0.1:8788/health", "http://127.0.0.1:8797/mcp"]) {
			expect(await fetch(input, redirect ? { redirect } : undefined)).toBe(response);
		}
	}
	expect(native).toHaveBeenCalledTimes(8);
});

it("normalizes input forms and overrides while preserving body, headers and abort propagation", async () => {
	let controller = new AbortController();
	let native = mock(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
		expect(input).toBeInstanceOf(Request);
		expect(init).toBeUndefined();
		let request = input as Request;
		expect(request.method).toBe("POST");
		expect(request.redirect).toBe("error");
		expect(request.headers.get("x-fixture")).toBe("original");
		expect(request.signal.aborted).toBe(false);
		return new Response(await request.text());
	});
	let fetch = createScriptedFetch(native);
	let init = Object.freeze({
		method: "POST",
		body: new Uint8Array([104, 105]),
		signal: controller.signal,
		headers: new Headers({ "x-fixture": "original" }),
	});
	let request = new Request("http://127.0.0.1:8797/", {
		method: "PUT",
		body: "original request body",
		redirect: "follow",
	});
	for (let input of ["http://127.0.0.1:8788/", new URL("http://127.0.0.1:8797/"), request]) {
		expect(await (await fetch(input, init)).text()).toBe("hi");
	}
	controller.abort();
	for (let [input] of native.mock.calls) {
		expect((input as Request).signal.aborted).toBe(true);
	}
	expect(init).not.toHaveProperty("redirect");
	expect(request.bodyUsed).toBe(false);
	let inherited = createScriptedFetch(async input => {
		let normalized = input as Request;
		expect(normalized.method).toBe("PUT");
		expect(normalized.redirect).toBe("error");
		return new Response(await normalized.text());
	});
	expect(await (await inherited(request)).text()).toBe("original request body");
});

it("guards preconnect with the same origin restriction before delegating", () => {
	let native = mock(async () => new Response("unused"));
	let preconnect = mock(
		(_url: string | URL, _options?: Parameters<typeof globalThis.fetch.preconnect>[1]) => {},
	);
	let fetch = createScriptedFetch(Object.assign(native, { preconnect }));
	let options = Object.freeze({ dns: true, tcp: true, https: false });
	let local = new URL("http://127.0.0.1:8797/mcp");
	fetch.preconnect("http://127.0.0.1:8788/", options);
	fetch.preconnect(local, options);
	expect(preconnect).toHaveBeenCalledTimes(2);
	expect(preconnect.mock.calls[1]?.[0]).toBe("http://127.0.0.1:8797/mcp");
	expect(preconnect.mock.calls[1]?.[1]).toEqual({ ...options, http: undefined });
	for (let input of ["https://remote.invalid/", "http://127.0.0.1:8789/", "bad confidential"]) {
		expect(() => fetch.preconnect(input)).toThrow(Error);
	}
	expect(preconnect).toHaveBeenCalledTimes(2);
	expect(native).not.toHaveBeenCalled();
});

it("offers a guarded no-op preconnect when the injected fetch has none", () => {
	let native = mock(async () => new Response("unused"));
	let fetch = createScriptedFetch(native);
	expect(() => fetch.preconnect("http://127.0.0.1:8788/")).not.toThrow();
	expect(() => fetch.preconnect("http://127.0.0.1:8797/")).not.toThrow();
	expect(() => fetch.preconnect("https://remote.invalid/confidential")).toThrow(Error);
	expect(native).not.toHaveBeenCalled();
});

it("keeps refusal errors generic for malformed input and embedded secrets", async () => {
	let fetch = createScriptedFetch(mock(async () => new Response("unused")));
	let messages = new Set<string>();
	for (
		let input of [
			"confidential-malformed-input",
			"http://confidential-user:confidential-password@127.0.0.1:8788/private",
			"https://remote.invalid/confidential-path?token=confidential-token",
		]
	) {
		let failure = await fetch(input).then(() => undefined, (error: unknown) => error);
		expect(failure).toBeInstanceOf(Error);
		let message = (failure as Error).message;
		expect(message).not.toContain("confidential");
		expect(message).not.toContain("remote.invalid");
		messages.add(message);
		let preconnectFailure: unknown;
		try {
			fetch.preconnect(input);
		} catch (error) {
			preconnectFailure = error;
		}
		expect(preconnectFailure).toBeInstanceOf(Error);
		messages.add((preconnectFailure as Error).message);
	}
	expect(messages.size).toBe(1);
});

it("preserves inherited RequestInit fields through native request normalization", async () => {
	let controller = new AbortController();
	let init = Object.create({
		method: "POST",
		body: "inherited body",
		headers: { "x-fixture": "inherited" },
		signal: controller.signal,
	}) as RequestInit;
	let native = mock(async (input: Parameters<typeof fetch>[0], options?: RequestInit) => {
		let request = new Request(input, options);
		expect(request.method).toBe("POST");
		expect(request.headers.get("x-fixture")).toBe("inherited");
		expect(request.signal.aborted).toBe(false);
		controller.abort();
		expect(request.signal.aborted).toBe(true);
		return new Response(await request.text());
	});
	let fetch = createScriptedFetch(native);
	expect(await (await fetch("http://127.0.0.1:8788/", init)).text()).toBe("inherited body");
});

it("keeps a URL-mutating init getter from sending a remote destination to native fetch", async () => {
	let url = new URL("http://127.0.0.1:8788/");
	let init = {
		get headers() {
			url.hostname = "remote.invalid";
			return { "x-fixture": "mutating getter" };
		},
	};
	let native = mock(async (input: Parameters<typeof fetch>[0], options?: RequestInit) => {
		let request = new Request(input, options);
		expect(request.url).toBe("http://127.0.0.1:8788/");
		return new Response("local");
	});
	let fetch = createScriptedFetch(native);
	expect(await (await fetch(url, init)).text()).toBe("local");
	expect(url.hostname).toBe("remote.invalid");
});

it("captures inherited preconnect options before checking a URL mutated by their getter", () => {
	let url = new URL("http://127.0.0.1:8788/");
	let options = Object.create({
		get dns() {
			url.hostname = "remote.invalid";
			return true;
		},
		tcp: true,
	}) as Parameters<typeof fetch.preconnect>[1];
	let preconnect = mock(
		(_input: string | URL, options?: Parameters<typeof fetch.preconnect>[1]) => {
			void options?.dns;
		},
	);
	let fetch = createScriptedFetch(Object.assign(
		mock(async () => new Response("unused")),
		{ preconnect },
	));
	expect(() => fetch.preconnect(url, options)).toThrow(Error);
	expect(preconnect).not.toHaveBeenCalled();
});

it("excludes Bun transport overrides and their getters from the native fetch boundary", async () => {
	let native = mock(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
		expect(input).toBeInstanceOf(Request);
		expect(init).toBeUndefined();
		expect(input).not.toHaveProperty("proxy");
		expect(input).not.toHaveProperty("unix");
		expect(input).not.toHaveProperty("tls");
		let request = input as Request;
		expect(request.url).toBe("http://127.0.0.1:8788/");
		expect(request.method).toBe("POST");
		expect(request.headers.get("x-fixture")).toBe("transport overrides excluded");
		return new Response(await request.text());
	});
	let fetch = createScriptedFetch(native);
	let init = {
		method: "POST",
		body: "standard body",
		headers: { "x-fixture": "transport overrides excluded" },
		get proxy() {
			throw new Error("offline proxy override was inspected");
		},
		get unix() {
			throw new Error("offline Unix override was inspected");
		},
		get tls() {
			throw new Error("offline TLS override was inspected");
		},
	};
	expect(await (await fetch("http://127.0.0.1:8788/", init)).text()).toBe("standard body");
});
