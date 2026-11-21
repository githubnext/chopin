import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { runCli } from "../main";
import { deviceDenied, unsupportedWords } from "../nvx";
import type { Spawned } from "../sandbox";
import { hostRecipes, hostSandbox, SUPPORTED_HOST } from "./host-sandbox";

/**
 * `chopin` as the tests run it: every command as it is, but on a machine the microVM check passes,
 * with each agent started on the host (see `hostSandbox`) for tests of what the connector does
 * around agents. `CHOPIN_TEST_KVM=denied` makes it a Linux machine whose user can't open
 * `/dev/kvm`, for tests of a machine that can't run microVMs. `CHOPIN_TEST_KVM_LOST=<file>` makes
 * it one whose user loses `/dev/kvm` while the file is there, as when logind takes back a login's
 * access: each launch then fails as its microVM would, and says so. Never built into a `chopin`,
 * which reads the machine itself and starts agents only in NVX.
 */
let denied = process.env.CHOPIN_TEST_KVM === "denied";
let lostFile = process.env.CHOPIN_TEST_KVM_LOST;
let lost = () => !!lostFile && existsSync(lostFile);
await runCli(process.argv.slice(2), {
	support: denied
		? { ...SUPPORTED_HOST, readWrite: () => false }
		: { ...SUPPORTED_HOST, readWrite: path => !lost() && SUPPORTED_HOST.readWrite(path) },
	recipes: hostRecipes,
	// Its guests' repositories are in `work` in the state directory, where tests find them.
	openSandbox: async options => {
		let sandbox = hostSandbox({ work: join(options.directory, "work") });
		return {
			...sandbox,
			spawn(launch) {
				if (!lost()) return sandbox.spawn(launch);
				let problem = deviceDenied("/dev/kvm", {});
				options.unsupported?.(problem);
				return spawn("/bin/sh", [
					"-c",
					'echo "$0" >&2; exit 1',
					unsupportedWords(problem).join(" "),
				], {
					stdio: [launch.stdin, "pipe", "pipe"],
					detached: true,
				}) as Spawned;
			},
		};
	},
	...lostFile ? { runsAgainMs: 100 } : {},
});
