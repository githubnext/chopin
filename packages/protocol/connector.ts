/**
 * What a local connector tells the server about itself on pairing and every connector request.
 * A request without these headers comes from a connector script older than the check.
 */
export const CONNECTOR_VERSION_HEADER = "chopin-connector-version";
export const CONNECTOR_PROTOCOL_HEADER = "chopin-connector-protocol";

/**
 * What a connector says about its machine as it connects a checkout, shown to the machine's owner
 * only. Each is optional; a server ignores a value that isn't one it expects.
 */
export const CONNECTOR_HOST_HEADER = "chopin-connector-host";
/** `<os> <arch>`, as Node names them: `linux x64`, `darwin arm64`, `win32 x64`. */
export const CONNECTOR_PLATFORM_HEADER = "chopin-connector-platform";
/** `1` when the background service runs the connection. */
export const CONNECTOR_SERVICE_HEADER = "chopin-connector-service";
/** `1` when the machine also runs Planners for documents named to `chopin connect --planner`. */
export const CONNECTOR_PLANNER_HEADER = "chopin-connector-planner";
/**
 * `1` when the machine has a Planner command, so Chopin may ask it to run the Planner of a
 * document its owner chose it for (connector protocol 4).
 */
export const CONNECTOR_PLANNER_COMMAND_HEADER = "chopin-connector-planner-command";

/** A document whose Planner Chopin asks a connector to run, by id and by URL. */
export type PlannerAssignment = { id: string; url: string };
/**
 * Chopin's answer to a protocol 4 connector's Planner poll (`wait_for_work` with `planners`) when
 * the documents whose Planners it should run differ from the ones it named: every one it should
 * run now. It carries no `id`, so a connector that knows no `kind: "planners"` waits again.
 */
export type PlannerControl = {
	kind: "planners";
	planners: PlannerAssignment[];
	/** Why Chopin stopped asking for a document it no longer lists, by id, when it knows. */
	stopped?: Record<string, string>;
	/**
	 * Listed documents a person asked to have started again now, by id: a backend that exited
	 * starts without waiting out its backoff, and one that is running is left as it is. Sent even
	 * when the list is unchanged; a connector from before it runs the same list and ignores it.
	 */
	retry?: string[];
};
/** The coding agent's name and version from its ACP initialize answer, when it has given one. */
export const CONNECTOR_AGENT_HEADER = "chopin-connector-agent";
export const CONNECTOR_AGENT_VERSION_HEADER = "chopin-connector-agent-version";

/**
 * Whether the connector runs agents inside the operating system's process sandbox, and if it
 * can't, why and the one command that fixes it. Additive: a server or connector without these
 * says nothing and is shown as saying nothing.
 */
export const CONNECTOR_SANDBOX_HEADER = "chopin-connector-sandbox";
export const CONNECTOR_SANDBOX_REASON_HEADER = "chopin-connector-sandbox-reason";
export const CONNECTOR_SANDBOX_FIX_HEADER = "chopin-connector-sandbox-fix";

/** The sandbox each system's agents run in, through MXC, and what people call it. */
export const SANDBOX_ENGINES = {
	seatbelt: "macOS Seatbelt",
	bubblewrap: "Linux bubblewrap",
	processcontainer: "Windows ProcessContainer",
} as const;
export type SandboxEngineName = keyof typeof SANDBOX_ENGINES;

/** What a connector says about its sandbox: the engine it uses, or `none` with why not. */
export type SandboxReport =
	| { engine: SandboxEngineName }
	| { engine: "none"; reason: string; fix?: string };

/** The longest reason and fix a server keeps. */
export const SANDBOX_TEXT_LIMIT = 600;

/** "Sandboxed (Linux bubblewrap)", or "Not sandboxed: <reason>". */
export function sandboxSummary(report: SandboxReport): string {
	return report.engine === "none"
		? `Not sandboxed: ${report.reason}`
		: `Sandboxed (${SANDBOX_ENGINES[report.engine]})`;
}

/** The summary with, for a machine that has none, the one fix after the reason. */
export function sandboxLabel(report: SandboxReport): string {
	return report.engine === "none" && report.fix
		? `${sandboxSummary(report)} Fix: ${report.fix}`
		: sandboxSummary(report);
}

/** The report in a request's headers, or undefined when it names none or an engine unknown here. */
export function parseSandboxReport(
	header: (name: string) => string | undefined,
): SandboxReport | undefined {
	let engine = header(CONNECTOR_SANDBOX_HEADER);
	if (engine && Object.hasOwn(SANDBOX_ENGINES, engine)) {
		return { engine: engine as SandboxEngineName };
	}
	if (engine !== "none") return undefined;
	let text = (value: string | undefined) =>
		value && value.length <= SANDBOX_TEXT_LIMIT && /^[\x20-\x7e]+$/.test(value) ? value : undefined;
	let reason = text(header(CONNECTOR_SANDBOX_REASON_HEADER));
	if (!reason) return undefined;
	let fix = text(header(CONNECTOR_SANDBOX_FIX_HEADER));
	return { engine: "none", reason, ...(fix ? { fix } : {}) };
}

/** The server refuses a connector whose protocol it does not support; it must not retry. */
export const CONNECTOR_UPDATE_REQUIRED = "connector-update-required";
