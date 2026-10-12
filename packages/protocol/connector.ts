/**
 * What a local connector tells the server about itself on pairing and every connector request.
 * A request without these headers comes from a connector script older than the check.
 */
export const CONNECTOR_VERSION_HEADER = "chopin-connector-version";
export const CONNECTOR_PROTOCOL_HEADER = "chopin-connector-protocol";

/** The server refuses a connector whose protocol it does not support; it must not retry. */
export const CONNECTOR_UPDATE_REQUIRED = "connector-update-required";
