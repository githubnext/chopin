import { describe, expect, test } from "bun:test";
import {
	type AgentImage,
	guestPath,
	nvxArguments,
	type NvxArtifacts,
	nvxSupport,
	OPEN_LAUNCHER,
	PREPARE,
	SandboxRefused,
	type SupportHost,
	type VmContext,
	type VmLaunch,
	vmSpec,
	within,
} from "./nvx";

function host(values: Partial<SupportHost> & { devices?: Record<string, boolean> }): SupportHost {
	let devices = values.devices ?? {};
	return {
		platform: values.platform ?? "linux",
		arch: values.arch ?? "x64",
		...values.uid === undefined ? {} : { uid: values.uid },
		exists: path => path in devices,
		readWrite: path => devices[path] === true,
	};
}

const WHP = "C:\\Windows\\System32\\WinHvPlatform.dll";

describe("which machines can run NVX", () => {
	test("Linux on x86_64 with read and write access to /dev/kvm runs it on KVM", () => {
		expect(nvxSupport(host({ devices: { "/dev/kvm": true } }))).toEqual({
			supported: true,
			hypervisor: "kvm",
			package: "linux-kvm",
		});
	});

	test("one under the Microsoft Hypervisor runs it on MSHV", () => {
		expect(nvxSupport(host({ devices: { "/dev/mshv": true } }))).toEqual({
			supported: true,
			hypervisor: "mshv",
			package: "linux-mshv",
		});
	});

	test("Windows on x86_64 with the Windows Hypervisor Platform runs it, and without it is told how to turn it on", () => {
		expect(nvxSupport(host({ platform: "win32", devices: { [WHP]: false } }))).toEqual({
			supported: true,
			hypervisor: "whp",
			package: "windows-whp",
		});
		expect(nvxSupport(host({ platform: "win32" }))).toEqual({
			supported: false,
			reason: "The Windows Hypervisor Platform is off.",
			fix: "In an administrator PowerShell: Enable-WindowsOptionalFeature -Online -FeatureName "
				+ "HypervisorPlatform -All, then restart",
		});
	});

	test("chopin running as root is refused, as a microVM's agent can't run as root", () => {
		expect(nvxSupport(host({ uid: 0, devices: { "/dev/kvm": true } }))).toEqual({
			supported: false,
			reason: "chopin runs as root here, and a microVM's agent can't run as root.",
			fix: "Run chopin as your own user",
		});
	});

	test("a user who can't use /dev/kvm is told to join the kvm group", () => {
		let support = nvxSupport(host({ devices: { "/dev/kvm": false } }));
		expect(support).toMatchObject({
			supported: false,
			reason: expect.stringContaining("/dev/kvm"),
		});
		expect(support.supported === false && support.fix).toContain("usermod -aG kvm");
	});

	test("a machine without virtualization, a Mac and an Arm machine have nothing to fix", () => {
		for (
			let machine of [
				host({}),
				host({ platform: "darwin", arch: "arm64" }),
				host({ arch: "arm64", devices: { "/dev/kvm": true } }),
				host({ platform: "win32", arch: "arm64" }),
			]
		) {
			let support = nvxSupport(machine);
			expect(support.supported).toBe(false);
			expect(support.supported === false && support.fix).toBeFalsy();
		}
	});
});

const BASE = "/home/mona/.local/state/chopin/connector";
const IMAGE: AgentImage = {
	layer: { path: `${BASE}/images/abc.erofs`, uuid: "11111111-2222-4333-8444-555555555555" },
	user: "1000:1000",
	path: ["/opt/chopin/agent/bin"],
	environment: { GIT_EXEC_PATH: "/opt/chopin/agent/sys/usr/lib/git-core" },
};
const CONTEXT: VmContext = {
	platform: "linux",
	base: BASE,
	image: IMAGE,
	proxyPort: 41234,
	real: path => path,
};
const ARTIFACTS: NvxArtifacts = {
	root: "/nvx",
	nvx: "/nvx/bin/nvx",
	layer: { path: "/nvx/guest/ubuntu-distro.erofs", uuid: "ce928f69-cb15-9708-60a3-39cd51c643d5" },
};

describe("what a launch's microVM is given", () => {
	let run = `${BASE}/runs/run-1`;
	let launch: VmLaunch = {
		command: ["/home/mona/.local/bin/copilot", "--acp"],
		cwd: "/work/app",
		env: { CHOPIN_MCP_TOKEN_FILE: `${run}.tokens/mcp` },
		own: [`${run}.tokens`, `${run}.agent`],
		agentHome: `${run}.agent`,
		repository: {
			source: "/home/mona/src/app/.git",
			path: "/work/app",
			commit: "0123456789abcdef0123456789abcdef01234567",
			branch: "chopin/implement-1",
			origin: "https://github.com/mona/app.git",
		},
	};

	test("a run gets its token folder and agent state, and the git directory it clones from read-only, and nothing else", () => {
		let spec = vmSpec(launch, CONTEXT);
		expect(spec.shares).toEqual([
			{ host: `${run}.agent`, guest: `${run}.agent`, mode: "rw" },
			{ host: `${run}.tokens`, guest: `${run}.tokens`, mode: "ro" },
			{ host: "/home/mona/src/app/.git", guest: "/home/mona/src/app/.git", mode: "ro" },
		]);
	});

	test("no share the guest writes is a path into the person's repository", () => {
		let spec = vmSpec(launch, CONTEXT);
		for (let share of spec.shares.filter(share => share.mode === "rw")) {
			expect(share.host.startsWith(BASE)).toBe(true);
		}
		expect(spec.shares.find(share => share.host.startsWith("/home/mona/src"))?.mode).toBe("ro");
		expect(spec.shares.some(share => share.writable?.length)).toBe(false);
	});

	test("the guest clones the repository before the agent starts, with alternates it only reads", () => {
		let spec = vmSpec(launch, CONTEXT);
		expect(spec.command.slice(0, 2)).toEqual(["/bin/sh", "-c"]);
		expect(spec.command[2]).toBe(PREPARE);
		expect(spec.command.slice(3)).toEqual(["chopin-launch", "copilot", "--acp"]);
		expect(PREPARE).toContain('git clone -q --no-checkout --shared "$CHOPIN_GUEST_SOURCE"');
		expect(spec.environment).toMatchObject({
			CHOPIN_GUEST_REPOSITORY: "/work/app",
			CHOPIN_GUEST_SOURCE: "/home/mona/src/app/.git",
			CHOPIN_GUEST_COMMIT: "0123456789abcdef0123456789abcdef01234567",
			CHOPIN_GUEST_BRANCH: "chopin/implement-1",
			CHOPIN_GUEST_ORIGIN: "https://github.com/mona/app.git",
		});
		expect(spec.cwd).toBe("/");
	});

	test("a Planner reads the person's checkout, uncommitted files and all, and works in its own clone on its disk", () => {
		let checkout = "/home/mona/src/app";
		let folder = `${BASE}/planners/mona/app/doc-1`;
		let spec = vmSpec({
			command: ["my-planner", "--serve"],
			cwd: "/work/app",
			env: { CHOPIN_CHECKOUT: checkout, CHOPIN_WORKTREE: "/work/app" },
			own: [`${folder}.tokens`],
			reads: [checkout],
			repository: { source: `${checkout}/.git`, path: "/work/app", dissociate: true },
			disk: `${folder}.disk`,
		}, CONTEXT);
		expect(() => spec).not.toThrow();
		expect(spec.disk).toBe(`${folder}.disk`);
		expect(spec.environment.CHOPIN_GUEST_DISSOCIATE).toBe("1");
		expect(spec.shares.map(share => [share.host, share.mode])).toEqual([
			[`${folder}.tokens`, "ro"],
			[checkout, "ro"],
		]);
		let words = nvxArguments(spec, ARTIFACTS, "kvm", "/env.json");
		expect(words).toContain("--upper=scratch");
		expect(words).toContain(`--scratch=${folder}.disk`);
		expect(words).not.toContain("--upper=ram");
	});

	test("what the owner adds is shared too, and what they hide is denied inside the share holding it", () => {
		let spec = vmSpec({
			...launch,
			cwd: "/home/mona/src/app",
			reads: ["/home/mona/src/app"],
			repository: undefined,
		}, {
			...CONTEXT,
			writable: ["/home/mona/.npm"],
			hidden: ["/home/mona/src/app/.env", "/home/mona/.ssh"],
		});
		expect(spec.shares.find(share => share.host === "/home/mona/.npm")).toEqual({
			host: "/home/mona/.npm",
			guest: "/home/mona/.npm",
			mode: "rw",
		});
		expect(spec.shares.find(share => share.host === "/home/mona/src/app")?.denied).toEqual([
			"/home/mona/src/app/.env",
		]);
		expect(spec.shares.some(share => share.host === "/home/mona/.ssh")).toBe(false);
		let words = nvxArguments(spec, ARTIFACTS, "kvm", "/env.json");
		let at = words.indexOf("--mount=/home/mona/src/app,/home/mona/src/app,ro");
		expect(words[at + 1]).toBe("--mount-deny=.env");
	});

	test("a guest writes nothing outside chopin's state directory but what the owner adds", () => {
		expect(() => vmSpec({ ...launch, writable: ["/home/mona/src/app"] }, CONTEXT)).toThrow(
			SandboxRefused,
		);
		expect(() => vmSpec({ ...launch, agentHome: "/home/mona/.copilot" }, CONTEXT)).toThrow(
			/outside chopin's state directory/,
		);
	});

	test("a folder the owner lets agents write never makes what a launch only reads writable", () => {
		let code = "/home/mona/src";
		let checkout = `${code}/app`;
		// A run whose clone's source is inside it, and a Planner whose checkout it is or holds.
		for (
			let [writable, given] of [
				[[code], launch],
				[[checkout], {
					...launch,
					reads: [checkout],
					repository: { source: `${checkout}/.git`, path: "/work/app", dissociate: true },
				}],
				[[`${checkout}/.git`], launch],
			] as Array<[string[], VmLaunch]>
		) {
			expect(() => vmSpec(given, { ...CONTEXT, writable })).toThrow(
				/would be shared writable and holds .*, which a microVM may only read/,
			);
		}
	});

	test("a folder the owner lets agents write is never inside chopin's state directory", () => {
		for (let inside of [`${BASE}/nvx`, `${BASE}/images`, `${BASE}/runs`]) {
			expect(() => vmSpec(launch, { ...CONTEXT, writable: [inside] })).toThrow(
				/can't name .*, which is inside chopin's state directory/,
			);
		}
	});

	test("no share a guest writes holds anything it may only read", () => {
		let shapes: Array<[VmLaunch, readonly string[]]> = [
			[launch, []],
			[launch, ["/home/mona/.npm"]],
			[{ ...launch, reads: ["/home/mona/src/app"] }, ["/home/mona/.cache"]],
			[{ ...launch, repository: undefined, cwd: `${run}.agent` }, ["/home/mona/scratch"]],
		];
		for (let [given, writable] of shapes) {
			let spec = vmSpec(given, { ...CONTEXT, writable });
			let readOnly = [
				...given.reads ?? [],
				...given.repository ? [given.repository.source] : [],
				...(given.own ?? []).filter(path => path !== given.agentHome),
			];
			for (let share of spec.shares.filter(share => share.mode === "rw")) {
				for (let path of readOnly) expect(within(path, share.host, "linux")).toBe(false);
			}
		}
	});

	test("no share holds another or chopin's state directory", () => {
		// A folder it writes inside one it only reads would be written through the one it reads.
		expect(() => vmSpec({ ...launch, writable: [`${run}.tokens/sub`] }, CONTEXT)).toThrow(/holds/);
		// One it only reads inside another it only reads is given with that one.
		let nested = vmSpec(
			{ ...launch, reads: ["/home/mona/src/app", "/home/mona/src/app/docs"] },
			CONTEXT,
		).shares.map(share => `${share.host} ${share.mode}`);
		expect(nested).toContain("/home/mona/src/app ro");
		expect(nested.some(share => share.startsWith("/home/mona/src/app/"))).toBe(false);
		expect(() => vmSpec({ ...launch, reads: ["/home/mona"] }, CONTEXT)).toThrow(/state directory/);
	});

	test("a checkout where the guest clones repositories, or keeps its agent, is refused", () => {
		for (let checkout of ["/work/chopin", "/opt/chopin/agent"]) {
			expect(() => vmSpec({ ...launch, reads: [checkout] }, CONTEXT)).toThrow(SandboxRefused);
		}
	});

	test("a path the guest can't be given is refused before anything starts", () => {
		expect(() => vmSpec({ ...launch, reads: ["/home/mona/my repo"] }, CONTEXT)).toThrow(/space/);
		expect(() => vmSpec({ ...launch, reads: ["/run/user/1000/repo"] }, CONTEXT)).toThrow(
			/its own files/,
		);
	});

	test("the guest's only way out is the proxy, at its gateway", () => {
		let spec = vmSpec(launch, CONTEXT);
		let words = nvxArguments(spec, ARTIFACTS, "kvm", "/env.json");
		expect(words.filter(word => /^--(net|network|host-loopback)/.test(word))).toEqual([
			"--net=10.0.0.2/24",
			"--network-profile=portable",
			"--network-egress=deny",
			"--host-loopback=deny",
			"--network-proxy=10.0.0.1:41234",
		]);
		for (let name of ["HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "https_proxy", "http_proxy"]) {
			expect(spec.environment[name]).toBe("http://10.0.0.1:41234");
		}
		expect(spec.environment.NO_PROXY).toBe("");
		expect(spec.environment.NODE_USE_ENV_PROXY).toBe("1");
	});

	test("a proxy setting of the launch's own can't send the guest elsewhere", () => {
		let spec = vmSpec({
			...launch,
			env: { HTTPS_PROXY: "http://evil.example:8080", NO_PROXY: "*", no_proxy: "*" },
		}, CONTEXT);
		expect(spec.environment.HTTPS_PROXY).toBe("http://10.0.0.1:41234");
		expect(spec.environment.NO_PROXY).toBe("");
		expect(spec.environment.no_proxy).toBe("");
	});

	test("the environment goes in its file and never on the command line", () => {
		let secret = "chopin-planner-token-canary";
		let spec = vmSpec({ ...launch, env: { CHOPIN_PLANNER_TOKEN: secret } }, CONTEXT);
		expect(spec.environment.CHOPIN_PLANNER_TOKEN).toBe(secret);
		let words = nvxArguments(spec, ARTIFACTS, "kvm", "/private/env.json");
		expect(words.join(" ")).not.toContain(secret);
		expect(words).toContain("--environment-file=/private/env.json");
	});

	test("the agent boots its image's layer as the connector's own user, its programs first on PATH", () => {
		let spec = vmSpec({ ...launch, repository: undefined, cwd: `${run}.agent` }, CONTEXT);
		expect(spec.command).toEqual(["copilot", "--acp"]);
		expect(spec.environment.PATH?.split(":")[0]).toBe("/opt/chopin/agent/bin");
		expect(spec.environment.GIT_EXEC_PATH).toBe("/opt/chopin/agent/sys/usr/lib/git-core");
		expect(spec.environment.HOME).toBe(`${run}.agent`);
		let words = nvxArguments(spec, ARTIFACTS, "kvm", "/env.json");
		expect(words).toContain(`--layer=distro,${IMAGE.layer.path},${IMAGE.layer.uuid}`);
		expect(words).toContain("--workload-user=1000:1000");
		expect(words.slice(words.indexOf("--entrypoint=/usr/bin/env"))).toEqual([
			"--entrypoint=/usr/bin/env",
			"--arg=--",
			"--arg=copilot",
			"--arg=--acp",
			"--timeout=31536000",
			"--exec-timeout-ms=0",
		]);
	});

	test("an image's build boots the release's layer as its own nobody", () => {
		let words = nvxArguments(
			{
				shares: [{ host: `${BASE}/images/x/out`, guest: "/out", mode: "rw" }],
				proxyPort: 41234,
				environment: {},
				command: ["/bin/sh", "/in/build.sh"],
				cwd: "/tmp",
				memoryMib: 4096,
				ramUpperPercent: 85,
				processors: 1,
				hostname: "chopin-image",
			},
			ARTIFACTS,
			"kvm",
			"/env.json",
		);
		expect(words).toContain(`--layer=distro,${ARTIFACTS.layer.path},${ARTIFACTS.layer.uuid}`);
		expect(words).toContain("--ram-upper-percent=85");
		expect(words.some(word => word.startsWith("--workload-user"))).toBe(false);
		expect(words).toContain(`--arg=${OPEN_LAUNCHER}`);
	});

	test("git in the guest takes the shares, which the connector's user owns", () => {
		let spec = vmSpec({
			...launch,
			env: {
				GIT_CONFIG_COUNT: "1",
				GIT_CONFIG_KEY_0: "push.default",
				GIT_CONFIG_VALUE_0: "nothing",
			},
		}, CONTEXT);
		expect(spec.environment.GIT_CONFIG_COUNT).toBe("2");
		expect(spec.environment.GIT_CONFIG_KEY_1).toBe("safe.directory");
		expect(spec.environment.GIT_CONFIG_VALUE_1).toBe("*");
		expect(spec.environment.GIT_CONFIG_KEY_0).toBe("push.default");
	});
});

describe("paths in a guest on Windows", () => {
	test("a drive's paths are under /mnt", () => {
		expect(guestPath("C:\\Users\\mona\\repo", "win32")).toBe("/mnt/c/Users/mona/repo");
		expect(guestPath("D:/work", "win32")).toBe("/mnt/d/work");
		expect(() => guestPath("\\\\server\\share", "win32")).toThrow(SandboxRefused);
	});

	test("a launch's environment names its shares as the guest sees them", () => {
		let base = "C:\\Users\\mona\\AppData\\Local\\chopin";
		let tokens = `${base}\\runs\\r1.tokens`;
		let spec = vmSpec({
			command: ["C:\\Program Files\\nodejs\\copilot.cmd", "--acp"],
			cwd: "/work/app",
			env: {
				CHOPIN_MCP_TOKEN_FILE: `${tokens}\\mcp`,
				OTHER: "C:\\elsewhere",
			},
			own: [tokens],
			repository: { source: "C:\\src\\app\\.git", path: "/work/app" },
		}, { ...CONTEXT, platform: "win32", base });
		expect(spec.environment.CHOPIN_MCP_TOKEN_FILE).toBe(
			"/mnt/c/Users/mona/AppData/Local/chopin/runs/r1.tokens/mcp",
		);
		expect(spec.environment.CHOPIN_GUEST_SOURCE).toBe("/mnt/c/src/app/.git");
		expect(spec.environment.OTHER).toBe("C:\\elsewhere");
		expect(spec.command.slice(3)).toEqual(["chopin-launch", "copilot", "--acp"]);
	});
});
