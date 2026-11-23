import { describe, expect, test } from "bun:test";

import { AI_PROXY_PATH } from "@chopin/protocol/ai-credentials";

import { applyRequestTimeout, isUnlimitedTimeoutPath, serverIdleTimeoutSeconds } from "./timeout";

describe("HTTP server idle timeouts", () => {
	test("derives a server idleTimeout above the handover hold window within Bun's 255s bound", () => {
		expect(serverIdleTimeoutSeconds(0)).toBe(60);
		expect(serverIdleTimeoutSeconds(20_000)).toBe(60);
		expect(serverIdleTimeoutSeconds(60_000)).toBe(70);
		expect(serverIdleTimeoutSeconds(120_000)).toBe(130);
		expect(serverIdleTimeoutSeconds(600_000)).toBe(255);
	});

	test("marks AI proxy, MCP, and connector long-poll paths as exempt from idle timeout", () => {
		expect(isUnlimitedTimeoutPath(`${AI_PROXY_PATH}/github-copilot/chat/completions`)).toBe(true);
		expect(isUnlimitedTimeoutPath(`${AI_PROXY_PATH}/anthropic/v1/messages`)).toBe(true);
		expect(isUnlimitedTimeoutPath(`${AI_PROXY_PATH}/openai/v1/responses`)).toBe(true);
		expect(isUnlimitedTimeoutPath("/mcp")).toBe(true);
		expect(isUnlimitedTimeoutPath("/connector/mcp")).toBe(true);

		expect(isUnlimitedTimeoutPath(AI_PROXY_PATH)).toBe(false);
		expect(isUnlimitedTimeoutPath("/api/session")).toBe(false);
		expect(isUnlimitedTimeoutPath("/api/health/ready")).toBe(false);
		expect(isUnlimitedTimeoutPath("/ws")).toBe(false);
		expect(isUnlimitedTimeoutPath("/api/v1/agent")).toBe(false);
	});

	test("applies timeout(req, 0) only to exempt paths", () => {
		let calls: Array<{ path: string; seconds: number }> = [];
		let server = {
			timeout(request: Request, seconds: number) {
				calls.push({ path: new URL(request.url).pathname, seconds });
			},
		};

		applyRequestTimeout(
			new Request(`http://chopin.test${AI_PROXY_PATH}/github-copilot/chat/completions`, {
				method: "POST",
			}),
			server,
		);
		applyRequestTimeout(new Request("http://chopin.test/mcp", { method: "POST" }), server);
		applyRequestTimeout(
			new Request("http://chopin.test/connector/mcp", { method: "POST" }),
			server,
		);
		applyRequestTimeout(new Request("http://chopin.test/api/session"), server);

		expect(calls).toEqual([
			{ path: `${AI_PROXY_PATH}/github-copilot/chat/completions`, seconds: 0 },
			{ path: "/mcp", seconds: 0 },
			{ path: "/connector/mcp", seconds: 0 },
		]);
	});

	test(
		"keeps an AI proxy SSE stream alive past Bun's server idleTimeout while regular routes still time out",
		async () => {
			let cancelled: string[] = [];
			let server = Bun.serve({
				hostname: "127.0.0.1",
				port: 0,
				idleTimeout: 1,
				fetch(request, self) {
					applyRequestTimeout(request, self);
					let path = new URL(request.url).pathname;
					let stream = new ReadableStream<Uint8Array>({
						async start(controller) {
							controller.enqueue(new TextEncoder().encode("data: first\n\n"));
							await Bun.sleep(5_000);
							try {
								controller.enqueue(new TextEncoder().encode("data: second\n\n"));
								controller.close();
							} catch {}
						},
						cancel() {
							cancelled.push(path);
						},
					});
					return new Response(stream, {
						headers: { "content-type": "text/event-stream" },
					});
				},
			});

			try {
				let base = `http://127.0.0.1:${server.port}`;
				let aiPath = `${AI_PROXY_PATH}/github-copilot/chat/completions`;
				let [aiResult, regularResult] = await Promise.all([
					fetch(`${base}${aiPath}`, { method: "POST" }).then(res => res.text()),
					fetch(`${base}/api/slow`)
						.then(res => res.text())
						.then(
							text => ({ ok: true as const, text }),
							error => ({ ok: false as const, error }),
						),
				]);

				expect(aiResult).toBe("data: first\n\ndata: second\n\n");
				expect(regularResult.ok).toBe(false);
				expect(cancelled).toEqual(["/api/slow"]);
			} finally {
				await server.stop(true);
			}
		},
		15_000,
	);
});
