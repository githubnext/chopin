import { expect, test } from "bun:test";
import { sandboxLabel, sandboxSummary } from "@chopin/protocol/connector";
import {
	APPARMOR_FILE,
	apparmorProfile,
	failureMessage,
	type Host,
	linuxFix,
	packagesFor,
	probeRequest,
	probeSandbox,
} from "./sandbox-probe";

const TOOLS = [
	"bwrap",
	"slirp4netns",
	"unshare",
	"nsenter",
	"ip",
	"iptables",
	"ip6tables",
	"iptables-restore",
	"ip6tables-restore",
];

const UBUNTU = [
	'PRETTY_NAME="Ubuntu 24.04.5 LTS"',
	"ID=ubuntu",
	"ID_LIKE=debian",
].join("\n");

type Ran = { code: number | null; output: string };

const succeed = async (): Promise<Ran> => ({ code: 0, output: "" });

function host(
	overrides: Partial<Host> & { tools?: string[]; files?: Record<string, string> } = {},
) {
	let { tools = TOOLS, files = {}, ...rest } = overrides;
	let ran: unknown[] = [];
	let made: Host = {
		platform: "linux",
		arch: "x64",
		release: "6.8.0-147-generic",
		env: {},
		read: path => ({ "/etc/os-release": UBUNTU, ...files })[path],
		exists: path => path in files,
		find: program => tools.includes(program) ? `/usr/bin/${program}` : undefined,
		run: async (_executor, request): Promise<Ran> => {
			ran.push(request);
			return { code: 0, output: "" };
		},
		...rest,
	};
	return { host: made, ran };
}

test("on Ubuntu 24.04 with AppArmor restricting user namespaces the one fix installs and permits in one sudo", async () => {
	let { host: ubuntu, ran } = host({
		tools: TOOLS.filter(tool => tool !== "slirp4netns"),
		files: { "/proc/sys/kernel/apparmor_restrict_unprivileged_userns": "1\n" },
	});
	let report = await probeSandbox(ubuntu, "/opt/mxc/lxc-exec", "http://127.0.0.1:9");
	expect(report).toEqual({
		engine: "none",
		reason: "The Linux sandbox can't run: slirp4netns isn't installed and AppArmor restricts user "
			+ "namespaces (kernel.apparmor_restrict_unprivileged_userns=1), which bubblewrap needs.",
		fix: `sudo sh -c 'apt-get install -y slirp4netns && printf "%s\\n" "abi <abi/4.0>," `
			+ `"include <tunables/global>" `
			+ `"profile chopin-mxc-bwrap /usr/bin/bwrap flags=(unconfined) { userns, }" `
			+ `"profile chopin-mxc-unshare /usr/bin/unshare flags=(unconfined) { userns, }" `
			+ `> ${APPARMOR_FILE} && apparmor_parser -r ${APPARMOR_FILE}'`,
	});
	// Nothing was started: what is missing is known without launching.
	expect(ran).toEqual([]);
	expect(sandboxSummary(report)).toStartWith("Not sandboxed: The Linux sandbox can't run");
	expect(sandboxLabel(report)).toContain(" Fix: sudo sh -c 'apt-get install -y slirp4netns");
});

test("where AppArmor has the profile and everything is installed, the probe launches and reports bubblewrap", async () => {
	let { host: ready, ran } = host({
		files: {
			"/proc/sys/kernel/apparmor_restrict_unprivileged_userns": "1\n",
			[APPARMOR_FILE]: "",
		},
	});
	let report = await probeSandbox(ready, "/opt/mxc/lxc-exec", "http://127.0.0.1:9");
	expect(report).toEqual({ engine: "bubblewrap" });
	expect(sandboxLabel(report)).toBe("Sandboxed (Linux bubblewrap)");
	// The probe launches a command that does nothing, in the shape of a real launch.
	expect(ran).toEqual([probeRequest(ready, "bubblewrap", "http://127.0.0.1:9")]);
	expect(ran[0]).toMatchObject({
		version: "1.0.0",
		containment: "bubblewrap",
		process: { commandLine: "exec true" },
		network: { egress: { default: "deny" } },
		runtimeConfig: { networkProxy: "http://127.0.0.1:9" },
	});
});

test("a missing tool alone is installed by the machine's package manager, with no AppArmor step", async () => {
	let missing = new Set(["slirp4netns", "iptables-restore", "ip6tables-restore", "nsenter"]);
	for (
		let [id, command] of [
			["ubuntu", "sudo sh -c 'apt-get install -y slirp4netns util-linux iptables'"],
			["fedora", "sudo sh -c 'dnf install -y slirp4netns util-linux iptables'"],
			["arch", "sudo sh -c 'pacman -S --needed --noconfirm slirp4netns util-linux iptables'"],
			["alpine", "sudo sh -c 'apk add slirp4netns util-linux iptables'"],
		] as const
	) {
		let { host: machine } = host({
			tools: TOOLS.filter(tool => !missing.has(tool)),
			files: { "/etc/os-release": `ID=${id}\n` },
		});
		let report = await probeSandbox(machine, "/opt/mxc/lxc-exec", "http://127.0.0.1:9");
		expect(report).toMatchObject({ engine: "none", fix: command });
	}
});

test("a package manager chopin doesn't know gets the reason and no command", async () => {
	let { host: odd } = host({
		tools: TOOLS.filter(tool => tool !== "bwrap"),
		files: { "/etc/os-release": "ID=gentoo\n" },
	});
	let report = await probeSandbox(odd, "/opt/mxc/lxc-exec", "http://127.0.0.1:9");
	expect(report).toEqual({
		engine: "none",
		reason: "The Linux sandbox can't run: bwrap isn't installed.",
	});
});

test("the fix names the packages that provide the missing tools, each once", () => {
	expect(packagesFor(["unshare", "nsenter", "ip", "iptables", "ip6tables"], "apt")).toEqual([
		"util-linux",
		"iproute2",
		"iptables",
	]);
	expect(packagesFor(["ip"], "dnf")).toEqual(["iproute"]);
	expect(linuxFix({ missing: [], restricted: false })).toBeUndefined();
	expect(linuxFix({ missing: ["bwrap"], restricted: false })).toBeUndefined();
	expect(
		linuxFix({
			missing: [],
			restricted: true,
			bwrap: "/usr/local/bin/bwrap",
			unshare: "/bin/unshare",
		}),
	).toContain(`"profile chopin-mxc-bwrap /usr/local/bin/bwrap flags=(unconfined) { userns, }"`);
	expect(apparmorProfile("/usr/bin/bwrap", "/usr/bin/unshare")).toEqual([
		"abi <abi/4.0>,",
		"include <tunables/global>",
		"profile chopin-mxc-bwrap /usr/bin/bwrap flags=(unconfined) { userns, }",
		"profile chopin-mxc-unshare /usr/bin/unshare flags=(unconfined) { userns, }",
	]);
});

test("a launch MXC refuses becomes the reason, from its JSON error or its first line", async () => {
	let refuse = (output: string) => {
		let { host: machine } = host({
			files: { [APPARMOR_FILE]: "" },
			run: async () => ({ code: 255, output }),
		});
		return probeSandbox(machine, "/opt/mxc/lxc-exec", "http://127.0.0.1:9");
	};
	let namespaces = "Bubblewrap: runtimeConfig.networkProxy requires unprivileged user and network "
		+ "namespaces, which this host refused (unshare --user --net exited with exit status: 1).";
	expect(await refuse(`${namespaces}{"error":{"code":"backend_error","message":"${namespaces}"}}`))
		.toMatchObject({
			engine: "none",
			reason: expect.stringContaining("can't make user namespaces here: Bubblewrap:"),
		});
	expect(await refuse("could not install the sandbox network policy\nmore")).toEqual({
		engine: "none",
		reason: "MXC's bubblewrap sandbox didn't start: could not install the sandbox network policy",
	});
	expect(failureMessage('{"error":{"code":"x","message":"it broke"}}')).toBe("it broke");
	expect(failureMessage("")).toBe("it did not start");
});

test("Windows older than 11 24H2 and Macs that are Intel or older than macOS 15 are not sandboxed, with the fix", async () => {
	expect(
		await probeSandbox(
			host({ platform: "win32", release: "10.0.19045", run: succeed }).host,
			"C:\\mxc\\wxc-exec.exe",
			"http://127.0.0.1:9",
		),
	).toEqual({
		engine: "none",
		reason:
			"MXC's ProcessContainer backend needs Windows 11 24H2 or later (build 26100). Update Windows.",
	});
	expect(
		await probeSandbox(
			host({ platform: "win32", release: "10.0.26100", run: succeed }).host,
			"C:\\mxc\\wxc-exec.exe",
			"http://127.0.0.1:9",
		),
	).toEqual({ engine: "processcontainer" });
	expect(
		await probeSandbox(
			host({ platform: "darwin", arch: "arm64", release: "23.6.0", run: succeed }).host,
			"/mxc/mxc-exec-mac",
			"http://127.0.0.1:9",
		),
	).toEqual({
		engine: "none",
		reason: "MXC's Seatbelt backend needs macOS 15 or later. Update macOS.",
	});
	expect(
		await probeSandbox(
			host({ platform: "darwin", arch: "x64", release: "24.0.0", run: succeed }).host,
			"/mxc/mxc-exec-mac",
			"http://127.0.0.1:9",
		),
	).toEqual({
		engine: "none",
		reason: "MXC's Seatbelt backend is built for Apple silicon, not this Intel Mac.",
	});
	let sequoia = await probeSandbox(
		host({ platform: "darwin", arch: "arm64", release: "24.1.0", run: succeed }).host,
		"/mxc/mxc-exec-mac",
		"http://127.0.0.1:9",
	);
	expect(sequoia).toEqual({ engine: "seatbelt" });
	expect(sandboxLabel(sequoia)).toBe("Sandboxed (macOS Seatbelt)");
	expect(sandboxLabel({ engine: "processcontainer" })).toBe("Sandboxed (Windows ProcessContainer)");
});

test("without an executor, as for the downloaded script, there is no sandbox and the reason says so", async () => {
	let report = await probeSandbox(host().host, undefined, "http://127.0.0.1:9");
	expect(report).toMatchObject({
		engine: "none",
		reason: expect.stringContaining("This chopin has no MXC executor"),
	});
});

test("the Windows probe launches with the environment MXC requires", () => {
	let { host: windows } = host({
		platform: "win32",
		env: { SystemRoot: "C:\\Windows", LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" },
	});
	let request = probeRequest(windows, "processcontainer", "http://127.0.0.1:9");
	expect(request.process.env).toEqual([
		"SYSTEMROOT=C:\\Windows",
		"LOCALAPPDATA=C:\\Users\\me\\AppData\\Local",
		"PATH=C:\\Windows\\System32",
	]);
	expect(request.network.ingress).toEqual({ default: "allow", hostLoopback: "allow" });
});
