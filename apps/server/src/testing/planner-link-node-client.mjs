import { connectPlannerLink } from "../../../../packages/planner-link/src/client.ts";

let [url, token, document] = process.argv.slice(2);
let usage = { inputTokens: {}, outputTokens: {} };

let client = await connectPlannerLink({
	url,
	token,
	document,
	handlers: {
		async turn(context) {
			let { prompt, tools } = context.message;
			context.emit({ type: "stream-start", modelId: "node-scripted" });
			if (prompt === "abort" || prompt === "hang") {
				if (!context.signal.aborted) {
					await new Promise(resolve => {
						context.signal.addEventListener("abort", resolve, { once: true });
					});
				}
				return;
			}
			if (prompt === "tools") {
				for (let tool of tools) await context.callHostTool(tool.name, {});
			}
			if (prompt === "output") {
				context.emit({ type: "text-start", id: "answer" });
				context.emit({ type: "text-delta", id: "answer", delta: '{"answer":"yes"}' });
				context.emit({ type: "text-end", id: "answer" });
			}
			context.emit({ type: "finish-step", finishReason: { unified: "stop" }, usage });
			context.emit({ type: "finish", finishReason: { unified: "stop" }, totalUsage: usage });
		},
	},
});
console.log(JSON.stringify({ attached: client.document.id, node: process.version }));
process.stdin.resume();
process.stdin.on("end", () => void client.detach());
await client.closed;
process.exit(0);
