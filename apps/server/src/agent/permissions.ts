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
