import { describe, expect, it } from "bun:test";

import { requestedModel, UsageReader, usageTokens } from "./usage-reader";

function read(contentType: string | null, text: string, pieces = 1) {
	let reader = new UsageReader(contentType);
	let bytes = new TextEncoder().encode(text);
	let size = Math.ceil(bytes.length / pieces);
	for (let start = 0; start < bytes.length; start += size) {
		reader.push(bytes.slice(start, start + size));
	}
	return reader.end();
}

function body(value: unknown) {
	return new TextEncoder().encode(JSON.stringify(value));
}

function events(values: Array<[string | undefined, unknown]>, newline = "\n") {
	return values.map(([event, data]) =>
		`${event ? `event: ${event}${newline}` : ""}data: ${JSON.stringify(data)}${newline}${newline}`
	).join("");
}

describe("reading the tokens a provider reports", () => {
	it("takes the cached part out of OpenAI's input, and keeps Anthropic's cache apart", () => {
		expect(
			usageTokens({
				prompt_tokens: 120,
				completion_tokens: 30,
				prompt_tokens_details: { cached_tokens: 20 },
			}),
		).toEqual({ input: 100, output: 30, cacheRead: 20 });
		expect(
			usageTokens({
				input_tokens: 50,
				output_tokens: 8,
				input_tokens_details: { cached_tokens: 50 },
			}),
		).toEqual({ input: 0, output: 8, cacheRead: 50 });
		expect(
			usageTokens({
				input_tokens: 12,
				output_tokens: 3,
				cache_read_input_tokens: 100,
				cache_creation_input_tokens: 7,
			}),
		).toEqual({ input: 12, output: 3, cacheRead: 100, cacheWrite: 7 });
		expect(usageTokens({ prompt_tokens: 4, total_tokens: 4 })).toEqual({ input: 4 });
		expect(usageTokens({ input_tokens: -1, output_tokens: 1.5, total_tokens: 3 })).toBeUndefined();
		expect(usageTokens(null)).toBeUndefined();
	});

	it("reads a JSON answer once it has all come, split anywhere", () => {
		let body = JSON.stringify({
			id: "chatcmpl",
			usage: { prompt_tokens: 10, completion_tokens: 2 },
		});
		expect(read("application/json", body, 7)).toEqual({ tokens: { input: 10, output: 2 } });
		expect(read(null, body)).toEqual({ tokens: { input: 10, output: 2 } });
		expect(read("application/json", "{not json")).toEqual({ tokens: {} });
	});

	it("takes the provider's error code from an error answer", () => {
		expect(
			read(
				"application/json",
				JSON.stringify({
					error: { message: "Slow down", type: "requests", code: "rate_limit_exceeded" },
				}),
			),
		).toEqual({ tokens: {}, error: "rate_limit_exceeded" });
		expect(
			read(
				"application/json",
				JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "x" } }),
			),
		).toEqual({ tokens: {}, error: "overloaded_error" });
		expect(
			read("application/json", JSON.stringify({ error: { code: "has spaces in it" } })),
		).toEqual({ tokens: {}, error: "provider-error" });
		expect(read("application/json", JSON.stringify({ error: null, output: [] }))).toEqual({
			tokens: {},
		});
	});

	it("follows Anthropic's stream, whose output count grows in its last delta", () => {
		let stream = events([
			["message_start", {
				type: "message_start",
				message: {
					usage: {
						input_tokens: 25,
						output_tokens: 1,
						cache_read_input_tokens: 300,
						cache_creation_input_tokens: 40,
					},
				},
			}],
			["content_block_delta", { type: "content_block_delta", delta: { text: "Hi" } }],
			["message_delta", { type: "message_delta", usage: { output_tokens: 61 } }],
			["message_stop", { type: "message_stop" }],
		], "\r\n");
		for (let pieces of [1, 3, 17, stream.length]) {
			expect(read("text/event-stream; charset=utf-8", stream, pieces)).toEqual({
				tokens: { input: 25, output: 61, cacheRead: 300, cacheWrite: 40 },
			});
		}
	});

	it("reads the usage of OpenAI's Responses stream and its chat stream's last chunk", () => {
		expect(
			read(
				"text/event-stream",
				events([
					["response.created", { type: "response.created", response: { usage: null } }],
					["response.completed", {
						type: "response.completed",
						response: {
							error: null,
							usage: {
								input_tokens: 40,
								output_tokens: 9,
								input_tokens_details: { cached_tokens: 30 },
							},
						},
					}],
				]),
				5,
			),
		).toEqual({ tokens: { input: 10, output: 9, cacheRead: 30 } });
		expect(
			read(
				"text/event-stream",
				`${
					events([
						[undefined, { choices: [{ delta: { content: "a" } }], usage: null }],
						[undefined, { choices: [], usage: { prompt_tokens: 3, completion_tokens: 1 } }],
					])
				}data: [DONE]\n\n`,
			),
		).toEqual({ tokens: { input: 3, output: 1 } });
	});

	it("says a stream that reports an error ended in one", () => {
		expect(
			read(
				"text/event-stream",
				events([
					["message_start", { type: "message_start", message: { usage: { input_tokens: 5 } } }],
					["error", { type: "error", error: { type: "overloaded_error" } }],
				]),
			),
		).toEqual({ tokens: { input: 5 }, error: "overloaded_error" });
		expect(
			read(
				"text/event-stream",
				events([["response.failed", {
					type: "response.failed",
					response: { error: { code: "server_error" } },
				}]]),
			),
		).toEqual({ tokens: {}, error: "server_error" });
	});

	it("reads an event whose last line has no blank line after it", () => {
		expect(
			read("text/event-stream", `data: ${JSON.stringify({ usage: { prompt_tokens: 2 } })}`),
		).toEqual({ tokens: { input: 2 } });
	});
});

describe("the model a request names", () => {
	it("is its body's model, when it is one that can be shown", () => {
		expect(requestedModel(body({ messages: [], model: " gpt-a " }))).toBe("gpt-a");
		expect(requestedModel(body({ model: "x".repeat(201) }))).toBeUndefined();
		expect(requestedModel(body({ model: "a\nb" }))).toBeUndefined();
		expect(requestedModel(body({ model: 4 }))).toBeUndefined();
		expect(requestedModel(body([{ model: "gpt-a" }]))).toBeUndefined();
		expect(requestedModel(new TextEncoder().encode("model=gpt-a"))).toBeUndefined();
		expect(requestedModel(undefined)).toBeUndefined();
	});
});
