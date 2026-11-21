import {
	CONNECTOR_SANDBOX_HEADER,
	CONNECTOR_SANDBOX_HYPERVISOR_HEADER,
} from "@chopin/protocol/connector";

/** What a connector whose agents each run in an NVX microVM says as it connects. */
export const MICROVMS = {
	[CONNECTOR_SANDBOX_HEADER]: "nvx",
	[CONNECTOR_SANDBOX_HYPERVISOR_HEADER]: "kvm",
};
