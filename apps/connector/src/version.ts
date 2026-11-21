declare const CHOPIN_CLI_VERSION: string | undefined;

/**
 * The connector protocol this CLI speaks, for a server to check compatibility against. Protocol 4
 * polls for the Planners its owner chose this machine for. Protocol 5 connects the machine, not
 * one checkout: it takes work in any repository its owner can push to. Protocol 6 keeps the claimed
 * document ID on build renewals and reports after assignment cleanup. Protocol 7 asks for each
 * launch's GitHub token with what it is for (`purpose`, `run`, `document`), gives the launch only
 * that token and the identity Chopin names, and starts nothing Chopin refuses one: the machine's own
 * GitHub login is never used. Protocol 8 runs every agent in an NVX microVM of its own and says so
 * as it connects; a machine that can't run them says why (`/api/connector/capability`).
 */
export const CONNECTOR_PROTOCOL = 8;

/** Embedded by the binary build with `--define`; a source or `/connector.js` run has none. */
export const VERSION = typeof CHOPIN_CLI_VERSION === "string" ? CHOPIN_CLI_VERSION : "dev";
