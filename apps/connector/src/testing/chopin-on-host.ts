import { join } from "node:path";
import { runCli } from "../main";
import { hostRecipes, hostSandbox, SUPPORTED_HOST } from "./host-sandbox";

/**
 * `chopin` as the tests run it: every command as it is, but on a machine the microVM check passes,
 * with each agent started on the host (see `hostSandbox`) for tests of what the connector does
 * around agents. `CHOPIN_TEST_KVM=denied` makes it a Linux machine whose user can't open
 * `/dev/kvm`, for tests of a machine that can't run microVMs. Never built into a `chopin`, which
 * reads the machine itself and starts agents only in NVX.
 */
let denied = process.env.CHOPIN_TEST_KVM === "denied";
await runCli(process.argv.slice(2), {
	support: denied ? { ...SUPPORTED_HOST, readWrite: () => false } : SUPPORTED_HOST,
	recipes: hostRecipes,
	// Its guests' repositories are in `work` in the state directory, where tests find them.
	openSandbox: async options => hostSandbox({ work: join(options.directory, "work") }),
});
