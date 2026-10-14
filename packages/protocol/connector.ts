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
/** `1` when the machine also runs Planners for documents. */
export const CONNECTOR_PLANNER_HEADER = "chopin-connector-planner";
/** The coding agent's name and version from its ACP initialize answer, when it has given one. */
export const CONNECTOR_AGENT_HEADER = "chopin-connector-agent";
export const CONNECTOR_AGENT_VERSION_HEADER = "chopin-connector-agent-version";

/** The server refuses a connector whose protocol it does not support; it must not retry. */
export const CONNECTOR_UPDATE_REQUIRED = "connector-update-required";
