import { expect, test } from "bun:test";
import {
	agentStateDirectories,
	allowedHosts,
	commandLine,
	isLocalEntry,
	matchingEntry,
	mxcRequest,
	type Policy,
	readableRoots,
	sandboxPath,
	secretPaths,
	validHostEntry,
} from "./sandbox-policy";

const real = (path: string) => path === "/run/user/1/fnm/bin" ? "/home/me/.fnm/v24/bin" : path;

function policy(platform: NodeJS.Platform, engine: Policy["engine"]): Policy {
	return {
		platform,
		engine,
		command: ["atomic-acp", "--flag", "two words"],
		cwd: "/work/run",
		env: { PATH: "/usr/bin", TOKEN: "t=1", GONE: undefined },
		readable: ["/usr", "/home"],
		writable: ["/work/run", "/work/run-worktrees"],
		readonlyInside: ["/work/.git/hooks"],
		denied: ["/home/me/.ssh"],
		proxy: "http://127.0.0.1:4000",
	};
}

test("the proxy lets a run reach Chopin, GitHub, the model providers and the registries", () => {
	let hosts = allowedHosts("https://chopin.example.com");
	for (
		let [host, port] of [
			["chopin.example.com", 443],
			["github.com", 443],
			["api.github.com", 443],
			["codeload.github.com", 443],
			["objects.githubusercontent.com", 443],
			["raw.githubusercontent.com", 443],
			["api.anthropic.com", 443],
			["api.openai.com", 443],
			["registry.npmjs.org", 443],
			["pypi.org", 443],
			["files.pythonhosted.org", 443],
			["crates.io", 443],
			["static.crates.io", 443],
			["api.individual.githubcopilot.com", 443],
		] as const
	) {
		expect(matchingEntry(hosts, host, port)).toBeDefined();
	}
});

test("a host that isn't listed, or a port its entry doesn't allow, is refused", () => {
	let hosts = allowedHosts("https://chopin.example.com");
	expect(matchingEntry(hosts, "example.org", 443)).toBeUndefined();
	expect(matchingEntry(hosts, "evilgithub.com", 443)).toBeUndefined();
	expect(matchingEntry(hosts, "github.com.evil.test", 443)).toBeUndefined();
	// Web hosts take HTTPS and HTTP only; Chopin's own origin takes its own port only.
	expect(matchingEntry(hosts, "github.com", 22)).toBeUndefined();
	expect(matchingEntry(hosts, "chopin.example.com", 8443)).toBeUndefined();
	// A wildcard names subdomains, not the bare domain.
	expect(matchingEntry(["*.example.com"], "example.com", 443)).toBeUndefined();
	expect(matchingEntry(["*.example.com"], "a.example.com", 443)).toBe("*.example.com");
});

test("Chopin's origin carries its port, a loopback one included, and the owner's hosts are added", () => {
	let hosts = allowedHosts("http://127.0.0.1:8788", ["store.example.com:8443", "*.corp.test"]);
	expect(matchingEntry(hosts, "127.0.0.1", 8788)).toBe("127.0.0.1:8788");
	expect(matchingEntry(hosts, "127.0.0.1", 9000)).toBeUndefined();
	expect(matchingEntry(hosts, "store.example.com", 8443)).toBe("store.example.com:8443");
	expect(matchingEntry(hosts, "build.corp.test", 443)).toBe("*.corp.test");
	expect(isLocalEntry("127.0.0.1:8788")).toBe(true);
	expect(isLocalEntry("localhost:8788")).toBe(true);
	expect(isLocalEntry("github.com")).toBe(false);
});

test("a host the owner adds is a name, a *. name or a name with a port, and nothing else", () => {
	for (let good of ["example.com", "*.example.com", "example.com:8443", "a-b.c1.io"]) {
		expect(validHostEntry(good)).toBe(true);
	}
	for (
		let bad of [
			"https://example.com",
			"example.com/path",
			"*.com",
			"*",
			"",
			"a b",
			"-x.com",
			"x.com:",
		]
	) {
		expect(validHostEntry(bad)).toBe(false);
	}
});

test("secrets are the credentials and browser profiles of the person's home, on each system", () => {
	let linux = secretPaths("linux", "/home/me");
	for (
		let path of [
			".ssh",
			".aws",
			".gnupg",
			".azure",
			".kube",
			".docker",
			".config/gh",
			".config/gcloud",
			".mozilla",
			".config/google-chrome",
		]
	) {
		expect(linux).toContain(`/home/me/${path}`);
	}
	let mac = secretPaths("darwin", "/Users/me");
	expect(mac).toContain("/Users/me/Library/Keychains");
	expect(mac).toContain("/Users/me/Library/Application Support/Google/Chrome");
	expect(mac).toContain("/Users/me/.ssh");
	let windows = secretPaths("win32", "C:\\Users\\me");
	expect(windows).toContain("C:\\Users\\me\\.ssh");
	expect(windows).toContain("C:\\Users\\me\\AppData\\Local\\Google\\Chrome");
	// The agent's own model login stays readable.
	expect(linux.some(path => path.includes(".atomic") || path.includes(".copilot"))).toBe(false);
});

test("the built-in agents keep their state in known directories, which their own variables move", () => {
	expect(agentStateDirectories(["atomic-acp"], {}, "/home/me", "linux")).toEqual([
		"/home/me/.atomic",
	]);
	expect(
		agentStateDirectories(
			["/opt/bin/atomic"],
			{ ATOMIC_CODING_AGENT_DIR: "/data/agent", ATOMIC_CODING_AGENT_SESSION_DIR: "relative" },
			"/home/me",
			"linux",
		),
	).toEqual(["/home/me/.atomic", "/data/agent"]);
	expect(agentStateDirectories(["copilot", "--acp"], {}, "/home/me", "linux")).toEqual([
		"/home/me/.copilot",
	]);
	expect(agentStateDirectories(["pdd-kit", "planner"], {}, "/home/me", "linux")).toEqual([
		"/home/me/.pdd-kit",
	]);
	expect(agentStateDirectories(["some-agent"], {}, "/home/me", "linux")).toEqual([]);
	expect(agentStateDirectories(["C:\\bin\\atomic-acp.cmd"], {}, "C:\\Users\\me", "win32")).toEqual([
		"C:\\Users\\me\\.atomic",
	]);
});

test("a command line quotes what a shell or the Windows runtime would split", () => {
	expect(commandLine("linux", ["atomic-acp", "--flag", "two words", "it's"])).toBe(
		"exec atomic-acp --flag 'two words' 'it'\\''s'",
	);
	expect(commandLine("darwin", ["a", "$HOME"])).toBe("exec a '$HOME'");
	expect(commandLine("win32", ["C:\\Program Files\\a.exe", "--flag", 'say "hi"'])).toBe(
		'"C:\\Program Files\\a.exe" --flag "say \\"hi\\""',
	);
});

test("the MXC request has one shape on every system: egress denied, the proxy the only way out", () => {
	for (
		let [platform, engine, containment] of [
			["linux", "bubblewrap", "bubblewrap"],
			["darwin", "seatbelt", "seatbelt"],
		] as const
	) {
		let request = mxcRequest(policy(platform, engine));
		expect(request).toEqual({
			version: "1.0.0",
			containment,
			process: {
				commandLine: "exec atomic-acp --flag 'two words'",
				cwd: "/work/run",
				env: ["PATH=/usr/bin", "TOKEN=t=1"],
				timeout: 0,
			},
			filesystem: {
				readonlyPaths: ["/usr", "/home", "/work/.git/hooks"],
				readwritePaths: ["/work/run", "/work/run-worktrees"],
				deniedPaths: ["/home/me/.ssh"],
			},
			network: {
				egress: { default: "deny" },
				ingress: { default: "deny", hostLoopback: "deny" },
			},
			runtimeConfig: { networkProxy: "http://127.0.0.1:4000" },
		});
	}
});

test("on Windows the ProcessContainer needs ingress and host loopback allowed to reach the proxy", () => {
	let request = mxcRequest(policy("win32", "processcontainer"));
	expect(request.containment).toBe("processcontainer");
	expect(request.network).toEqual({
		egress: { default: "deny" },
		ingress: { default: "allow", hostLoopback: "allow" },
	});
	expect(request.runtimeConfig.networkProxy).toBe("http://127.0.0.1:4000");
});

test("the request never opts in to MXC's telemetry and carries no rule MXC would take as an egress rule", () => {
	for (let platform of ["linux", "darwin", "win32"] as const) {
		let request = mxcRequest(policy(platform, "bubblewrap")) as Record<string, unknown>;
		expect(request).not.toHaveProperty("telemetry");
		expect(JSON.stringify(request)).not.toContain('"allow":[{');
		expect(request.network).toMatchObject({ egress: { default: "deny" } });
		expect((request.network as { egress: object }).egress).not.toHaveProperty("allow");
	}
});

test("PATH names each directory by its real path, once, so a login's link in /run still finds its programs", () => {
	expect(sandboxPath("/run/user/1/fnm/bin:/usr/bin::/usr/bin:/home/me/.fnm/v24/bin", "linux", real))
		.toBe("/home/me/.fnm/v24/bin:/usr/bin");
	expect(sandboxPath(undefined, "linux", real)).toBeUndefined();
	expect(sandboxPath("C:\\a;C:\\b", "win32", path => path)).toBe("C:\\a;C:\\b");
});

test("of the root's directories the sandbox gets the ones it doesn't supply itself", () => {
	expect(
		readableRoots(["bin", "dev", "etc", "home", "proc", "run", "sys", "tmp", "usr", "var", "opt"]),
	)
		.toEqual(["/bin", "/etc", "/home", "/usr", "/var", "/opt"]);
});
