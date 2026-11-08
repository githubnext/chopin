import { createAssistantMessageEventStream } from "@bastani/pi-ai";
import { readFileSync } from "node:fs";

// An Atomic extension with one scripted model, so a test can run the real Atomic without a login:
// its first answer calls the bash tool with the command in SCRIPTED_COMMAND_FILE, and once the
// tool's result is back it says it is done.
function stream(model, context) {
	let out = createAssistantMessageEventStream();
	let output = {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "pending",
		timestamp: Date.now(),
	};
	out.push({ type: "start", partial: output });
	if (!context.messages.some(message => message.role === "toolResult")) {
		let command = readFileSync(process.env.SCRIPTED_COMMAND_FILE, "utf8");
		let call = { type: "toolCall", id: "call_scripted_1", name: "bash", arguments: { command } };
		output.content.push(call);
		out.push({ type: "toolcall_start", contentIndex: 0, partial: output });
		out.push({ type: "toolcall_end", contentIndex: 0, toolCall: call, partial: output });
		output.stopReason = "toolUse";
		out.push({ type: "done", reason: "toolUse", message: output });
	} else {
		let text = "scripted run finished";
		output.content.push({ type: "text", text });
		out.push({ type: "text_start", contentIndex: 0, partial: output });
		out.push({ type: "text_delta", contentIndex: 0, delta: text, partial: output });
		out.push({ type: "text_end", contentIndex: 0, content: text, partial: output });
		output.stopReason = "stop";
		out.push({ type: "done", reason: "stop", message: output });
	}
	out.end();
	return out;
}

export default async function(pi) {
	await pi.registerProvider("scripted", {
		baseUrl: "http://127.0.0.1:1",
		apiKey: "scripted-key",
		api: "scripted-api",
		models: [{
			id: "scripted-1",
			name: "Scripted",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 100000,
			maxTokens: 4096,
		}],
		streamSimple: stream,
	});
}
