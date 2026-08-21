/** Capability boundary for the shared, repository-scoped Copilot runtime. */

import type {
	PermissionHandler,
	PermissionRequest,
	PermissionRequestResult,
} from "@github/copilot-sdk";

function deny(feedback: string): PermissionRequestResult {
	return { kind: "reject", feedback };
}

function allow(): PermissionRequestResult {
	return { kind: "approve-once" };
}

export type GateOptions = {
	owner: string;
	repository: string;
	tools: Set<string>;
	active?: () => Promise<boolean>;
};

export function gate(options: GateOptions): PermissionHandler {
	return async (request: PermissionRequest): Promise<PermissionRequestResult> => {
		if (options.active && !(await options.active())) {
			return deny("The Copilot owner or repository permission is no longer active.");
		}
		if (request.kind === "custom-tool") {
			return options.tools.has(request.toolName)
				? allow()
				: deny(`${request.toolName} is not available to the planner.`);
		}
		if (request.kind === "mcp") {
			if (request.serverName !== "github" || !request.readOnly) {
				return deny("Only read-only GitHub MCP calls are available.");
			}
			let args = request.args && typeof request.args === "object" && !Array.isArray(request.args)
				? request.args
				: undefined;
			let owner = args?.owner;
			let repository = args?.repo;
			let tool = request.toolName.toLowerCase();
			let unsafe = tool.includes("search") || tool.includes("issue")
				|| hasForeignScope(request.args, options.owner, options.repository);
			return !unsafe && owner === options.owner && repository === options.repository
				? allow()
				: deny("GitHub MCP calls must name this channel's repository.");
		}
		return deny("The planner has no host filesystem, shell or URL access.");
	};
}

/** A worker may submit one terminal result and has no ambient capabilities. */
export function terminalGate(
	tool: string,
	active?: () => Promise<boolean>,
): PermissionHandler {
	return async (request: PermissionRequest): Promise<PermissionRequestResult> => {
		if (active && !(await active())) {
			return deny("The Copilot owner is no longer active.");
		}
		return request.kind === "custom-tool" && request.toolName === tool
			? allow()
			: deny("This worker may only submit its registered result.");
	};
}

/** Public research receives no private tools and may only use exact web search. */
export function publicResearchGate(
	resultTool: string,
	active?: () => Promise<boolean>,
): PermissionHandler {
	return async (request: PermissionRequest): Promise<PermissionRequestResult> => {
		if (active && !(await active())) return deny("The Copilot owner is no longer active.");
		if (request.kind === "custom-tool") {
			return request.toolName === resultTool
				? allow()
				: deny("This worker may only submit its registered research result.");
		}
		if (request.kind === "mcp") {
			return request.serverName === "github"
					&& request.readOnly
					&& request.toolName === "web_search"
				? allow()
				: deny("Only the exact read-only public web search tool is available.");
		}
		if (request.kind === "url") return deny("Public research has no direct URL fetch capability.");
		return deny("Public research has no repository, filesystem, shell, or private document tools.");
	};
}

function hasForeignScope(value: unknown, owner: string, repository: string): boolean {
	if (typeof value === "string") return /\b(?:repo|org|user):/i.test(value);
	if (Array.isArray(value)) return value.some(item => hasForeignScope(item, owner, repository));
	if (!value || typeof value !== "object") return false;
	return Object.entries(value).some(([key, child]) => {
		if (key === "owner" && child !== owner) return true;
		if (key === "repo" && child !== repository) return true;
		return hasForeignScope(child, owner, repository);
	});
}
