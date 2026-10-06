import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Script the external streaming boundary; the real Pi SDK runs all source tools. */
export async function sourceProvider(root: string) {
	let step = 0;
	let server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			let body = await request.json() as { messages: Array<{ role: string; content: string }> };
			let index = step++ - 1;
			let tool: { name: string; arguments: object } | undefined;
			if (index === -1) tool = { name: "inspect_project", arguments: {} };
			if (index === 0) {
				tool = {
					name: "edit_source",
					arguments: {
						path: "apps/web/src/room-workspace.tsx",
						oldText: "label={metadata.title}",
						newText: "label={`${metadata.title} · live`}",
					},
				};
			}
			if (index === 1) {
				tool = { name: "check_candidate", arguments: { summary: "Update workspace presentation" } };
			}
			if (index === 2) {
				let result = body.messages.findLast(message => message.role === "tool");
				let candidate = JSON.parse(result!.content);
				if (!candidate.candidateId) return Response.json({ error: result }, { status: 500 });
				tool = { name: "publish_revision", arguments: { candidateId: candidate.candidateId } };
			}
			let delta = tool
				? {
					role: "assistant",
					tool_calls: [{
						index: 0,
						id: `call_${index}`,
						type: "function",
						function: { name: tool.name, arguments: JSON.stringify(tool.arguments) },
					}],
				}
				: { role: "assistant", content: "The workspace presentation is live." };
			let chunk = (value: object, finish: string | null) =>
				`data: ${
					JSON.stringify({
						id: `completion_${index}`,
						object: "chat.completion.chunk",
						created: 1,
						model: "fixture",
						choices: [{ index: 0, delta: value, finish_reason: finish }],
					})
				}\n\n`;
			return new Response(
				chunk(delta, null) + chunk({}, tool ? "tool_calls" : "stop") + "data: [DONE]\n\n",
				{ headers: { "content-type": "text/event-stream" } },
			);
		},
	});
	await mkdir(join(root, ".liveapp/pi"), { recursive: true });
	await writeFile(
		join(root, "liveapp.config.json"),
		JSON.stringify({ provider: "fixture", model: "fixture", repairAttempts: 0 }),
	);
	await writeFile(
		join(root, ".liveapp/pi/models.json"),
		JSON.stringify({
			providers: {
				fixture: {
					baseUrl: `http://127.0.0.1:${server.port}/v1`,
					api: "openai-completions",
					apiKey: "pilot-fake-credential",
					models: [{
						id: "fixture",
						name: "Local source-edit fixture",
						reasoning: false,
						input: ["text"],
						contextWindow: 128000,
						maxTokens: 8192,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					}],
				},
			},
		}),
	);
	return { close: () => server.stop(true) };
}
