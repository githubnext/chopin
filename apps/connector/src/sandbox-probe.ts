import type { SandboxEngineName, SandboxReport } from "@chopin/protocol/connector";
import type { MxcRequest } from "./sandbox-policy";

/** What the probe needs to know about this machine; tests give it a made-up one. */
export type Host = {
	platform: NodeJS.Platform;
	arch: string;
	/** `os.release()`: the Darwin version on macOS, `10.0.<build>` on Windows. */
	release: string;
	env: Record<string, string | undefined>;
	/** The text of a small file, or undefined when it can't be read. */
	read(path: string): string | undefined;
	exists(path: string): boolean;
	/** A program found the way MXC finds it: on PATH, then in the system directories. */
	find(program: string): string | undefined;
	/** Runs the executor on a request; resolves with how it ended and what it printed. */
	run(executor: string, request: MxcRequest): Promise<{ code: number | null; output: string }>;
};

/** The tools MXC's bubblewrap backend runs, with proxy-only networking, and where distributions keep them. */
const LINUX_TOOLS: Record<string, { apt: string; dnf: string; pacman: string; apk: string }> = {
	bwrap: { apt: "bubblewrap", dnf: "bubblewrap", pacman: "bubblewrap", apk: "bubblewrap" },
	slirp4netns: {
		apt: "slirp4netns",
		dnf: "slirp4netns",
		pacman: "slirp4netns",
		apk: "slirp4netns",
	},
	unshare: { apt: "util-linux", dnf: "util-linux", pacman: "util-linux", apk: "util-linux" },
	nsenter: { apt: "util-linux", dnf: "util-linux", pacman: "util-linux", apk: "util-linux" },
	ip: { apt: "iproute2", dnf: "iproute", pacman: "iproute2", apk: "iproute2" },
	iptables: { apt: "iptables", dnf: "iptables", pacman: "iptables", apk: "iptables" },
	ip6tables: { apt: "iptables", dnf: "iptables", pacman: "iptables", apk: "iptables" },
	"iptables-restore": { apt: "iptables", dnf: "iptables", pacman: "iptables", apk: "iptables" },
	"ip6tables-restore": { apt: "iptables", dnf: "iptables", pacman: "iptables", apk: "iptables" },
};

export type PackageManager = "apt" | "dnf" | "pacman" | "apk";

const INSTALL: Record<PackageManager, string> = {
	apt: "apt-get install -y",
	dnf: "dnf install -y",
	pacman: "pacman -S --needed --noconfirm",
	apk: "apk add",
};

/** The AppArmor file that lets bubblewrap and unshare make user namespaces. */
export const APPARMOR_FILE = "/etc/apparmor.d/chopin-mxc";

/**
 * The AppArmor profiles that give the two programs MXC makes its namespaces with the `userns`
 * permission, as Ubuntu's own profiles for podman and lxc do for theirs. They name the programs
 * and nothing else, so the machine-wide restriction stays on for every other program.
 */
export function apparmorProfile(bwrap: string, unshare: string): string[] {
	return [
		"abi <abi/4.0>,",
		"include <tunables/global>",
		`profile chopin-mxc-bwrap ${bwrap} flags=(unconfined) { userns, }`,
		`profile chopin-mxc-unshare ${unshare} flags=(unconfined) { userns, }`,
	];
}

export type LinuxFacts = {
	/** The tools MXC needs that this machine lacks. */
	missing: string[];
	manager?: PackageManager | undefined;
	/** AppArmor restricts unprivileged user namespaces, and nothing yet permits MXC's programs. */
	restricted: boolean;
	bwrap?: string | undefined;
	unshare?: string | undefined;
};

/** The packages that provide `tools`, for the distribution's package manager. */
export function packagesFor(tools: readonly string[], manager: PackageManager): string[] {
	return [...new Set(tools.flatMap(tool => LINUX_TOOLS[tool]?.[manager] ?? []))];
}

/**
 * The one command that makes this machine ready: install what is missing and, where AppArmor
 * restricts user namespaces, write and load the profile, in a single `sudo`. Undefined where the
 * remedy isn't one command, such as a package manager chopin doesn't know.
 */
export function linuxFix(facts: LinuxFacts): string | undefined {
	let steps: string[] = [];
	if (facts.missing.length) {
		if (!facts.manager) return undefined;
		steps.push(`${INSTALL[facts.manager]} ${packagesFor(facts.missing, facts.manager).join(" ")}`);
	}
	if (facts.restricted) {
		let bwrap = facts.bwrap ?? "/usr/bin/bwrap";
		let unshare = facts.unshare ?? "/usr/bin/unshare";
		let lines = apparmorProfile(bwrap, unshare).map(line => `"${line}"`).join(" ");
		steps.push(`printf "%s\\n" ${lines} > ${APPARMOR_FILE}`);
		steps.push(`apparmor_parser -r ${APPARMOR_FILE}`);
	}
	return steps.length ? `sudo sh -c '${steps.join(" && ")}'` : undefined;
}

/** What is wrong on Linux, in a sentence, from the facts. */
function linuxReason(facts: LinuxFacts): string {
	let parts: string[] = [];
	if (facts.missing.length) {
		parts.push(
			`${facts.missing.join(", ")} ${facts.missing.length === 1 ? "isn't" : "aren't"} installed`,
		);
	}
	if (facts.restricted) {
		parts.push(
			"AppArmor restricts user namespaces (kernel.apparmor_restrict_unprivileged_userns=1), "
				+ "which bubblewrap needs",
		);
	}
	return `The Linux sandbox can't run: ${parts.join(" and ")}.`;
}

function packageManager(host: Host): PackageManager | undefined {
	let release = host.read("/etc/os-release") ?? "";
	let ids = (release.match(/^(?:ID|ID_LIKE)=(.*)$/gm) ?? [])
		.flatMap(line => line.split("=")[1]!.replaceAll('"', "").split(/\s+/));
	if (ids.some(id => id === "debian" || id === "ubuntu")) return "apt";
	if (ids.some(id => ["fedora", "rhel", "centos"].includes(id))) return "dnf";
	if (ids.includes("arch")) return "pacman";
	if (ids.includes("alpine")) return "apk";
	return undefined;
}

/** What Linux lacks for MXC's bubblewrap backend, found without starting anything. */
export function linuxFacts(host: Host): LinuxFacts {
	let missing = Object.keys(LINUX_TOOLS).filter(tool => !host.find(tool));
	let restrict = host.read("/proc/sys/kernel/apparmor_restrict_unprivileged_userns")?.trim();
	return {
		missing,
		manager: packageManager(host),
		restricted: restrict === "1" && !host.exists(APPARMOR_FILE),
		bwrap: host.find("bwrap"),
		unshare: host.find("unshare"),
	};
}

/** The line of MXC's refusal that says why, from the JSON it prints or else its first line. */
export function failureMessage(output: string): string {
	let json = output.match(/\{"error":\{.*\}\}/s)?.[0];
	if (json) {
		try {
			let message = (JSON.parse(json) as { error?: { message?: unknown } }).error?.message;
			if (typeof message === "string" && message) return message;
		} catch { /* The plain text below says it. */ }
	}
	return output.split("\n").map(line => line.trim()).find(Boolean) ?? "it did not start";
}

const NONE = (reason: string, fix?: string): SandboxReport => ({
	engine: "none",
	reason,
	...(fix ? { fix } : {}),
});

/** The engine this system's MXC uses, and why a system can't have one. */
function engineFor(host: Host): SandboxEngineName | SandboxReport {
	let arch = host.arch === "x64" || host.arch === "arm64";
	if (host.platform === "linux") {
		return arch
			? "bubblewrap"
			: NONE(`MXC's bubblewrap backend needs an x64 or arm64 machine, not ${host.arch}.`);
	}
	if (host.platform === "darwin") {
		if (host.arch !== "arm64") {
			return NONE("MXC's Seatbelt backend is built for Apple silicon, not this Intel Mac.");
		}
		if (Number(host.release.split(".")[0]) < 24) {
			return NONE("MXC's Seatbelt backend needs macOS 15 or later. Update macOS.");
		}
		return "seatbelt";
	}
	if (host.platform === "win32") {
		if (!arch) {
			return NONE(`MXC's ProcessContainer backend needs an x64 or arm64 PC, not ${host.arch}.`);
		}
		let build = Number(host.release.split(".")[2] ?? 0);
		if (build < 26100) {
			return NONE(
				"MXC's ProcessContainer backend needs Windows 11 24H2 or later (build 26100). Update Windows.",
			);
		}
		return "processcontainer";
	}
	return NONE(`chopin can't sandbox on ${host.platform}.`);
}

/**
 * The request the probe runs: the same shape as a real launch, with a command that does nothing,
 * so what MXC refuses to start for is what a run would be refused for.
 */
export function probeRequest(host: Host, engine: SandboxEngineName, proxy: string): MxcRequest {
	let windows = host.platform === "win32";
	let system = host.env.SystemRoot ?? host.env.SYSTEMROOT ?? "C:\\Windows";
	return {
		version: "1.0.0",
		containment: engine,
		process: {
			commandLine: windows ? "cmd.exe /c exit 0" : "exec true",
			cwd: windows ? system : "/usr",
			env: windows
				? [
					`SYSTEMROOT=${system}`,
					`LOCALAPPDATA=${host.env.LOCALAPPDATA ?? ""}`,
					`PATH=${system}\\System32`,
				]
				: ["PATH=/usr/bin:/bin"],
			timeout: 0,
		},
		filesystem: { readonlyPaths: [], readwritePaths: [], deniedPaths: [] },
		network: {
			egress: { default: "deny" },
			ingress: windows
				? { default: "allow", hostLoopback: "allow" }
				: { default: "deny", hostLoopback: "deny" },
		},
		runtimeConfig: { networkProxy: proxy },
	};
}

/**
 * Whether agents can run in this machine's sandbox, from what the machine lacks and then from a
 * real launch of a command that does nothing. Not sandboxed says why and, where one command
 * fixes it, the command.
 */
export async function probeSandbox(
	host: Host,
	executor: string | undefined,
	proxy: string,
): Promise<SandboxReport> {
	let engine = engineFor(host);
	if (typeof engine !== "string") return engine;
	if (!executor) {
		return NONE(
			"This chopin has no MXC executor: it is the downloaded script, not the chopin binary. "
				+ "Install the binary (see docs/chopin-cli.md).",
		);
	}
	let facts: LinuxFacts | undefined;
	if (host.platform === "linux") {
		facts = linuxFacts(host);
		if (facts.missing.length || facts.restricted) {
			return NONE(linuxReason(facts), linuxFix(facts));
		}
	}
	let ran = await host.run(executor, probeRequest(host, engine, proxy));
	if (ran.code === 0) return { engine };
	let message = failureMessage(ran.output);
	if (
		host.platform === "linux"
		&& /apparmor|uid map|RTM_NEWADDR|user namespaces?|network namespaces/i.test(message)
	) {
		return NONE(`The Linux sandbox can't make user namespaces here: ${message.slice(0, 200)}`);
	}
	return NONE(`MXC's ${engine} sandbox didn't start: ${message.slice(0, 300)}`);
}
