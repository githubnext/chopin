declare const CHOPIN_CLI_VERSION: string | undefined;

/**
 * The connector protocol this CLI speaks, for a server to check compatibility against. Protocol 4
 * polls for the Planners its owner chose this machine for.
 */
export const CONNECTOR_PROTOCOL = 4;

/** Embedded by the binary build with `--define`; a source or `/connector.js` run has none. */
export const VERSION = typeof CHOPIN_CLI_VERSION === "string" ? CHOPIN_CLI_VERSION : "dev";
