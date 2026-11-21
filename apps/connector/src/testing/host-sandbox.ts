import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { machineRecipes } from "../machine-sandbox";
import { PREPARE, programAt, type SupportHost } from "../nvx";
import type { Launch, Sandbox, Spawned } from "../sandbox";

/**
 * A stand-in for the machine's microVMs that starts each launch on the host, for tests of what
 * the connector does around an agent: never part of a connector, which starts nothing but in NVX.
 * A launch with a guest repository has it made as its guest would, by the same script, in a folder
 * of the stand-in's own standing in for the guest's `/work`, where it lasts as long as the stand-in.
 * Its bridge is the guest's, run by Bun from source, and its programs are found on the connector's
 * PATH where a launch's environment names none, as its image's are in a guest.
 */
export function hostSandbox(
	overrides: Partial<Sandbox> = {},
	/**
	 * A guest that takes `bootMs` to boot before its program starts, as a microVM does; `heard` hears
	 * each launch begin to boot and finish.
	 */
	stand: { bootMs?: number; heard?: (event: "boot" | "booted", launch: Launch) => void } = {},
): Sandbox {
	let work = overrides.work ?? mkdtempSync(join(tmpdir(), "chopin-work-"));
	mkdirSync(work, { recursive: true });
	return {
		report: { engine: "nvx", hypervisor: "kvm" },
		work,
		bridge: {
			command: process.execPath,
			args: ["--no-env-file", join(import.meta.dir, "..", "guest-bridge.ts")],
		},
		spawn(launch: Launch) {
			let repository = launch.repository;
			// The image has the agent on its PATH; here the host's has it.
			launch = { ...launch, env: { PATH: process.env.PATH, ...launch.env } };
			// Its workload starts as its process does, or once its stand-in boot is over.
			let bootMs = stand.bootMs ?? 0;
			let asked = launch;
			stand.heard?.("boot", asked);
			if (bootMs) {
				launch = {
					...launch,
					command: [
						"/bin/sh",
						"-c",
						`sleep ${bootMs / 1000}; exec "$@"`,
						"boot",
						...launch.command,
					],
				};
			}
			let booted = (child: Spawned) => {
				let done = false;
				let finish = () => {
					if (done) return;
					done = true;
					stand.heard?.("booted", asked);
					child.emit("workload");
				};
				child.once("spawn", () => setTimeout(finish, bootMs));
				child.once("exit", finish);
				return child;
			};
			if (!repository) {
				return booted(
					spawn(launch.command[0]!, launch.command.slice(1), {
						cwd: launch.cwd,
						env: launch.env,
						stdio: [launch.stdin, "pipe", "pipe"],
						detached: process.platform !== "win32",
					}) as Spawned,
				);
			}
			// A guest without a disk starts with nothing: a run's repository is cloned afresh.
			if (!launch.disk && repository.path.startsWith(`${work}/`)) {
				rmSync(repository.path, { recursive: true, force: true });
			}
			// Guests that share the stand-in's `/work` clone one at a time, as each guest has its own.
			let serialized = 'flock "$CHOPIN_STAND_IN_LOCK" /bin/sh -c "$CHOPIN_STAND_IN_PREPARE" '
				+ 'prepare true && exec /bin/sh -c "$CHOPIN_STAND_IN_PREPARE" chopin-launch "$@"';
			return booted(spawn("/bin/sh", ["-c", serialized, "chopin-launch", ...launch.command], {
				cwd: work,
				env: {
					...launch.env,
					CHOPIN_STAND_IN_LOCK: join(work, ".clone.lock"),
					CHOPIN_STAND_IN_PREPARE: PREPARE,
					CHOPIN_GUEST_REPOSITORY: repository.path,
					CHOPIN_GUEST_SOURCE: repository.source,
					...repository.dissociate ? { CHOPIN_GUEST_DISSOCIATE: "1" } : {},
					...repository.origin ? { CHOPIN_GUEST_ORIGIN: repository.origin } : {},
					...repository.commit ? { CHOPIN_GUEST_COMMIT: repository.commit } : {},
					...repository.branch ? { CHOPIN_GUEST_BRANCH: repository.branch } : {},
				},
				stdio: [launch.stdin, "pipe", "pipe"],
				detached: process.platform !== "win32",
			}) as Spawned);
		},
		makeDisk: async path => {
			await Bun.write(path, "");
		},
		close: async () => {},
		...overrides,
	};
}

/** The stand-in most tests share. */
export const HOST_SANDBOX = hostSandbox();

/** A machine the microVM support check passes: Linux on x86_64 with `/dev/kvm` its own. */
export const SUPPORTED_HOST: SupportHost = {
	platform: "linux",
	arch: "x64",
	exists: path => path === "/dev/kvm",
	readWrite: path => path === "/dev/kvm",
};

/**
 * The images the stand-in has: a program on the host's PATH is in it as it is, as a built image
 * would have it; any other needs what a microVM's would (see `machineRecipes`).
 */
export const hostRecipes: typeof machineRecipes = options => {
	let found = (command: string[] | undefined) =>
		!!command?.length
		&& !!Bun.which(command[programAt(command)] ?? "", { PATH: process.env.PATH ?? "" });
	return machineRecipes({
		...options,
		...found(options.command) ? { install: ["true"] } : {},
		...found(options.plannerCommand) ? { plannerInstall: ["true"] } : {},
	});
};
