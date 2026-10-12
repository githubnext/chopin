import type { RequestPermissionRequest } from "@agentclientprotocol/sdk";

/**
 * What an ACP permission request would do, as terminal lines: the tool kind and title, then the
 * actual command, the paths it touches, or its raw input.
 */
export function describePermission(request: RequestPermissionRequest): string[] {
	let call = request.toolCall;
	let lines = [`${call.kind ?? "tool"}: ${call.title ?? "Agent permission request"}`];
	let input = call.rawInput as Record<string, unknown> | undefined;
	let command = input?.command ?? input?.cmd;
	if (Array.isArray(command)) command = command.join(" ");
	if (typeof command === "string" && command.trim()) {
		lines.push(...command.trim().split("\n").map((line, index) => `${index ? "  " : "$ "}${line}`));
	} else if (call.locations?.length) {
		lines.push(
			...call.locations.map(location =>
				location.line ? `${location.path}:${location.line}` : location.path
			),
		);
	} else if (input && Object.keys(input).length) {
		let json = JSON.stringify(input);
		lines.push(json.length > 500 ? `${json.slice(0, 499)}…` : json);
	}
	return lines;
}

/** Remembers an "always allow" answer for a tool kind for the rest of the connector's run. */
export function permissionMemory() {
	let allowed = new Set<string>();
	let key = (request: RequestPermissionRequest) =>
		request.toolCall.kind ?? request.toolCall.title ?? "tool";
	return {
		/** The option to pick without asking, when this kind was already always-allowed. */
		remembered(request: RequestPermissionRequest): string | undefined {
			if (!allowed.has(key(request))) return undefined;
			let option = request.options.find(item => item.kind === "allow_always")
				?? request.options.find(item => item.kind === "allow_once");
			return option?.optionId;
		},
		chose(request: RequestPermissionRequest, optionId: string | undefined) {
			let option = request.options.find(item => item.optionId === optionId);
			if (option?.kind === "allow_always") allowed.add(key(request));
		},
	};
}
