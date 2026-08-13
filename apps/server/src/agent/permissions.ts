/**
 * The boundary.
 *
 * Ace runs its agent inside a microVM and can afford a permissive gate, because
 * the gate is not what protects the machine. There is no microVM here: this
 * process runs as you, on your filesystem, and this function is the whole of
 * what stands between a planning agent and everything you can reach.
 *
 * So it is an allowlist, and a narrow one. Writes are refused outright rather
 * than confined — a planner has no business writing anything, and the plan it
 * does write goes through a tool that validates every byte. Reads are confined
 * to the working directory. Shell commands must be ones the runtime itself
 * classifies as read-only. Anything not recognised is denied.
 *
 * The failure mode worth designing against is not a hostile model. It is a
 * capable one that decides the most helpful next step is to fix the bug it
 * just found.
 */

import { relative, resolve } from "node:path";

import type {
	PermissionHandler,
	PermissionRequest,
	PermissionRequestResult,
} from "@github/copilot-sdk";

/** MCP servers the planner may reach, all read-only. */
const SERVERS = new Set(["github"]);

/**
 * Paths that are refused even inside the working directory.
 *
 * A planner has no reason to read any of these, and every one of them is a
 * credential or a key in the general case.
 */
const SECRETS = [
	/(^|\/)\.env(\.|$)/,
	/(^|\/)\.git\/config$/,
	/(^|\/)\.npmrc$/,
	/(^|\/)\.netrc$/,
	/(^|\/)id_(rsa|dsa|ecdsa|ed25519)$/,
	/(^|\/)\.ssh\//,
	/(^|\/)\.aws\//,
	/(^|\/)\.config\/gh\//,
];

/**
 * Refuse, and say why.
 *
 * The feedback reaches the model. A refusal it cannot interpret becomes a
 * retry loop; one that explains the boundary gets the plan written instead.
 */
function deny(feedback: string): PermissionRequestResult {
	return { kind: "reject", feedback };
}

/** Approve this request only. Nothing is remembered between turns. */
function allow(): PermissionRequestResult {
	return { kind: "approve-once" };
}

/** Whether `path` is inside `root`, without being fooled by `..`. */
function within(root: string, path: string): boolean {
	let step = relative(root, resolve(path));
	return step !== ".." && !step.startsWith(`..${"/"}`) && !resolve(path).startsWith("..");
}

export function readable(root: string, path: string, temp = "/tmp"): boolean {
	let target = resolve(path);
	if (SECRETS.some(pattern => pattern.test(target))) return false;
	return within(root, target) || within(temp, target);
}

export type GateOptions = {
	/** Everything the agent may read. */
	root: string;
	/** Tools it may call, by name. */
	tools: Set<string>;
};

/**
 * Decide one request.
 *
 * Every branch names why, because a refusal the model cannot interpret becomes
 * a retry loop, and a refusal a person cannot interpret becomes a bug report.
 */
export function gate(options: GateOptions): PermissionHandler {
	return (request: PermissionRequest): PermissionRequestResult => {
		switch (request.kind) {
			case "custom-tool":
				return options.tools.has(request.toolName)
					? allow()
					: deny(`${request.toolName} is not available to the planner.`);

			case "read":
				return readable(options.root, request.path)
					? allow()
					: deny("Reading is limited to the working directory.");

			case "write":
				// Not confined — refused. The plan is written through a tool that
				// validates it; nothing else about this machine is the planner's
				// to change.
				return deny("The planner cannot write files. Describe the change in the plan.");

			case "shell": {
				if (request.hasWriteFileRedirection) {
					return deny("The planner cannot write files, including by redirection.");
				}
				let writes = request.commands.filter(command => !command.readOnly);
				if (writes.length > 0) {
					return deny(
						`The planner can only run commands that inspect. Refused: ${
							writes.map(command => command.identifier).join(", ")
						}`,
					);
				}
				return allow();
			}

			case "url":
				// Fetching is how a read-only agent reaches the network, and the
				// network is where exfiltration goes.
				return deny("The planner cannot fetch URLs.");

			case "mcp":
				if (!request.readOnly) return deny("Only read-only MCP calls are allowed.");
				return SERVERS.has(request.serverName)
					? allow()
					: deny(`The ${request.serverName} server is not available to the planner.`);

			default:
				// An unrecognised kind is a capability this gate has never been
				// reasoned about. Refusing is the only safe reading of silence.
				return deny("Not permitted.");
		}
	};
}

export type HostedGateOptions = {
	owner: string;
	repository: string;
	tools: Set<string>;
	active?: () => Promise<boolean>;
};

/** Shared-runtime gate: only app-owned tools and repository-bound read-only MCP calls. */
export function hostedGate(options: HostedGateOptions): PermissionHandler {
	return async (request: PermissionRequest): Promise<PermissionRequestResult> => {
		if (options.active && !(await options.active())) {
			return deny("The hosted Copilot owner or repository permission is no longer active.");
		}
		if (request.kind === "custom-tool") {
			return options.tools.has(request.toolName)
				? allow()
				: deny(`${request.toolName} is not available to the hosted planner.`);
		}
		if (request.kind === "mcp") {
			if (request.serverName !== "github" || !request.readOnly) {
				return deny("Only read-only GitHub MCP calls are available.");
			}
			let owner = request.args?.owner;
			let repository = request.args?.repo;
			let tool = request.toolName.toLowerCase();
			let unsafe = tool.includes("search") || tool.includes("issue")
				|| hasForeignScope(request.args, options.owner, options.repository);
			return !unsafe && owner === options.owner && repository === options.repository
				? allow()
				: deny("GitHub MCP calls must name this channel's repository.");
		}
		return deny("Hosted planning has no host filesystem, shell or URL access.");
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
