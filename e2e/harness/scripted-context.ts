export function scriptContext(prompt: unknown) {
	let text: unknown = prompt;
	if (prompt && typeof prompt === "object" && "role" in prompt && prompt.role === "user") {
		let content = "content" in prompt ? prompt.content : undefined;
		text = Array.isArray(content)
			? content.map(part => {
				if (!part || part.type !== "text" || typeof part.text !== "string") {
					throw new Error("scripted Planner requires a text prompt");
				}
				return part.text;
			}).join("")
			: content;
	}
	if (typeof text !== "string") throw new Error("scripted Planner requires a text prompt");
	let lines = text.split("\n");
	let header = /^\[Background job: (heading|refine|suggest|prose)\]$/.exec(lines[0] ?? "");
	if (!header || lines.filter(line => line.startsWith("[Background job:")).length !== 1) {
		throw new Error("scripted Planner requires one exact background job header");
	}
	let kind = header[1] as "heading" | "refine" | "suggest" | "prose";
	let cards = lines.filter(line => line.startsWith("Decision card"));
	if (kind === "heading") {
		if (cards.length) throw new Error("a heading prompt cannot name a decision card");
		return { kind, target: "document" };
	}
	let target = cards.length === 1
		? (kind === "prose"
			? /^Decision card id: ([^\s:]{1,200})$/.exec(cards[0]!)
			: /^Decision card ([^\s:]{1,200}): "[^\r\n]*"$/.exec(cards[0]!))?.[1]
		: undefined;
	if (!target) throw new Error("scripted Planner requires one exact decision card target");
	return { kind, target };
}

export function readRevision(result: { output: unknown; isError?: boolean }): number {
	if (result.isError || typeof result.output !== "string") {
		throw new Error("read_plan must return successful JSON");
	}
	let parsed: unknown = JSON.parse(result.output);
	if (
		!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !("revision" in parsed)
		|| !Number.isSafeInteger(parsed.revision) || (parsed.revision as number) < 0
	) throw new Error("read_plan returned an invalid revision");
	return parsed.revision as number;
}
