/**
 * A local OpenAI-completions-compatible model stub for the Pi contract test.
 *
 * `@ai-sdk/harness-pi`'s Pi runtime speaks the real `openai` SDK client
 * against `providers.<name>.baseUrl`, so this drives the actual `createPi()`
 * runtime end to end without a real provider credential or network access.
 * Scripted by the last `role: "user"` message content, matching the plain
 * prompt string each contract case sends.
 */

export type StubTurn =
	| { kind: "text"; text: string }
	| { kind: "tool"; name: string; arguments: string }
	| { kind: "hold" };

function extractText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter((part): part is { type: string; text: string } => part?.type === "text")
			.map(part => part.text)
			.join("");
	}
	return "";
}

function sse(body: Record<string, unknown>): string {
	return `data: ${JSON.stringify(body)}\n\n`;
}

function chunk(id: string, delta: Record<string, unknown>, finishReason: string | null): string {
	return sse({
		id,
		object: "chat.completion.chunk",
		created: 0,
		model: "stub-model",
		choices: [{ index: 0, delta, finish_reason: finishReason }],
	});
}

export type StubRequest = {
	prompt: string;
	system: string;
	toolNames: string[];
	hasPriorToolResult: boolean;
	toolResults: string[];
};

export function startStubModelServer(
	respond: (prompt: string, hasPriorToolResult: boolean) => StubTurn,
): { baseUrl: string; requests: StubRequest[]; stop: () => void } {
	let requests: StubRequest[] = [];
	let server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		async fetch(request) {
			let url = new URL(request.url);
			if (request.method !== "POST" || url.pathname !== "/v1/chat/completions") {
				return new Response("Not found", { status: 404 });
			}
			let body = await request.json() as {
				messages: { role: string; content: unknown }[];
				tools?: { function?: { name?: string } }[];
			};
			let lastUser = [...body.messages].toReversed().find(message => message.role === "user");
			let prompt = extractText(lastUser?.content);
			let hasPriorToolResult = body.messages.some(message => message.role === "tool");
			let system = body.messages
				.filter(message => message.role === "system" || message.role === "developer")
				.map(message => extractText(message.content))
				.join("\n");
			requests.push({
				prompt,
				system,
				hasPriorToolResult,
				toolNames: (body.tools ?? []).map(entry => entry.function?.name ?? ""),
				toolResults: body.messages.filter(message => message.role === "tool").map(message =>
					extractText(message.content)
				),
			});
			let turn = respond(prompt, hasPriorToolResult);
			let id = crypto.randomUUID();

			if (turn.kind === "hold") {
				return new Response(
					new ReadableStream({
						start(controller) {
							request.signal.addEventListener("abort", () => controller.close(), { once: true });
						},
					}),
					{ headers: { "content-type": "text/event-stream" } },
				);
			}

			let body_ = chunk(id, { role: "assistant" }, null)
				+ (turn.kind === "text"
					? chunk(id, { content: turn.text }, null) + chunk(id, {}, "stop")
					: chunk(id, {
						tool_calls: [{
							index: 0,
							id: `call_${id}`,
							type: "function",
							function: { name: turn.name, arguments: turn.arguments },
						}],
					}, null) + chunk(id, {}, "tool_calls"))
				+ "data: [DONE]\n\n";
			return new Response(body_, { headers: { "content-type": "text/event-stream" } });
		},
	});
	return {
		baseUrl: `http://127.0.0.1:${server.port}/v1`,
		requests,
		stop: () => server.stop(true),
	};
}
