import { expect, test } from "bun:test";
import {
	agentStateDirectories,
	allowedHosts,
	BUILT_IN_HOST_LIST,
	commandLine,
	type Disk,
	HOST_GROUPS,
	matchingEntry,
	mxcRequest,
	ownerEntry,
	type Policy,
	readableRoots,
	readGrantsAround,
	sandboxPath,
	secretPaths,
	validHostEntry,
	windowsReadRoots,
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
		// What git reads to decide which programs to run, held back inside the git directory a run writes.
		readonlyInside: [
			"/work/.git/hooks",
			"/work/.git/info",
			"/work/.git/config",
			"/work/.git/worktrees/run/commondir",
			"/work/run/.git",
		],
		denied: ["/home/me/.ssh"],
		proxy: "http://127.0.0.1:4000",
	};
}

test("the proxy lets a run reach Chopin, GitHub, the model providers, every common language's registries, the formal-methods toolchains and research", () => {
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
			["release-assets.githubusercontent.com", 443],
			["elan.lean-lang.org", 443],
			["releases.lean-lang.org", 443],
			["reservoir.lean-lang.org", 443],
			["lean-lang.org", 443],
			["mathlib4.lean-cache.cloud", 443],
			["lakecache.blob.core.windows.net", 443],
			["static.rust-lang.org", 443],
			["sh.rustup.rs", 443],
			["aka.ms", 443],
			["opam.ocaml.org", 443],
			["fstar-lang.org", 443],
			["builds.dotnet.microsoft.com", 443],
			["api.nuget.org", 443],
			["docs.lemmascript.org", 443],
			["pldb.kirancodes.me", 443],
			["arxiv.org", 443],
			["proxy.golang.org", 443],
			["repo.maven.apache.org", 443],
			["plugins.gradle.org", 443],
			["rubygems.org", 443],
			["repo.packagist.org", 443],
			["hackage.haskell.org", 443],
			["repo.hex.pm", 443],
			["download.swift.org", 443],
			["pub.dev", 443],
			["pkg.julialang.org", 443],
			["center2.conan.io", 443],
			["globalcdn.nuget.org", 443],
			["jsr.io", 443],
			["conda.anaconda.org", 443],
		] as const
	) {
		expect(matchingEntry(hosts, host, port)).toBeDefined();
	}
});

test("every built-in host is a valid entry, and no group is empty", () => {
	for (let [group, hosts] of Object.entries(HOST_GROUPS)) {
		expect(hosts.length).toBeGreaterThan(0);
		for (let host of hosts) {
			expect({ group, host, valid: validHostEntry(host) }).toEqual({ group, host, valid: true });
		}
	}
});

test("no built-in host is storage a stranger can write to and read back", () => {
	let hosts = allowedHosts("https://chopin.example.com");
	for (
		let [host, port] of [
			["storage.googleapis.com", 443],
			["attacker.blob.core.windows.net", 443],
			["s3.amazonaws.com", 443],
			["attacker.s3.amazonaws.com", 443],
			["gist.githubusercontent.com", 443],
			["gist.github.com", 443],
			["user-images.githubusercontent.com", 443],
			["pastebin.com", 443],
			["attacker.github.io", 443],
			["httpbin.org", 443],
			["webhook.site", 443],
			["attacker.cloudfront.net", 443],
			["attacker.workers.dev", 443],
			["attacker.ngrok.io", 443],
		] as const
	) {
		expect({ host, entry: matchingEntry(hosts, host, port) }).toEqual({ host, entry: undefined });
	}
	for (let entry of BUILT_IN_HOST_LIST) {
		expect(entry).not.toMatch(
			/^\*\.(githubusercontent\.com|github\.io|blob\.core\.windows\.net|googleapis\.com|amazonaws\.com|cloudfront\.net|azureedge\.net|workers\.dev|vercel\.app|netlify\.app)$/,
		);
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
	// What the owner chose may be on a private network; a built-in name may not.
	for (let entry of ["127.0.0.1:8788", "localhost:8788", "store.example.com:8443", "*.corp.test"]) {
		expect(ownerEntry(entry), entry).toBe(true);
	}
	for (let entry of ["github.com", "api.github.com", "*.githubcopilot.com", "registry.npmjs.org"]) {
		expect(ownerEntry(entry), entry).toBe(false);
	}
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
				readonlyPaths: [
					"/usr",
					"/home",
					"/work/.git/hooks",
					"/work/.git/info",
					"/work/.git/config",
					"/work/.git/worktrees/run/commondir",
					"/work/run/.git",
				],
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

test("what git reads to run programs is read-only inside the directories a run writes, in the same request on every system", () => {
	let requests = (["linux", "darwin", "win32"] as const).map(platform =>
		mxcRequest(policy(platform, platform === "win32" ? "processcontainer" : "bubblewrap"))
	);
	for (let request of requests) {
		expect(request.filesystem.readwritePaths).toEqual(["/work/run", "/work/run-worktrees"]);
		expect(request.filesystem.readonlyPaths).toEqual(requests[0]!.filesystem.readonlyPaths);
		for (
			let path of [
				"/work/.git/config",
				"/work/.git/hooks",
				"/work/.git/info",
				"/work/.git/worktrees/run/commondir",
				"/work/run/.git",
			]
		) {
			expect(request.filesystem.readonlyPaths).toContain(path);
			// Held back from the write grant of the directory around them, never granted on their own.
			expect(request.filesystem.readwritePaths).not.toContain(path);
		}
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

/** A disk that is a table of directories, with the paths a user can't read and the links it has. */
function disk(
	tree: Record<string, string[]>,
	unreadable: string[] = [],
	links: Record<string, string> = {},
): Disk {
	return {
		list: directory => tree[directory] ?? [],
		resolve: path => unreadable.includes(path) ? undefined : links[path] ?? path,
	};
}

test("the read grants leave the state directory out by listing what is around it, so nothing made inside it later is granted", () => {
	let hidden = "/home/me/.local/state/chopin/connector";
	let tree: Record<string, string[]> = {
		"/home": ["me", "you"],
		"/home/me": [".bashrc", ".local", ".ssh", "projects"],
		"/home/me/.local": ["bin", "state"],
		"/home/me/.local/state": ["chopin", "mise"],
		"/home/me/.local/state/chopin": ["connector", "log"],
	};
	let grants = readGrantsAround(["/usr", "/home"], hidden, disk(tree), "linux");
	expect(grants.sort()).toEqual([
		"/home/me/.bashrc",
		"/home/me/.local/bin",
		"/home/me/.local/state/chopin/log",
		"/home/me/.local/state/mise",
		"/home/me/.ssh",
		"/home/me/projects",
		"/home/you",
		"/usr",
	]);
	// No grant is the directory or one of its parents: each would show a run made after it.
	for (let grant of grants) {
		expect(hidden === grant || hidden.startsWith(`${grant}/`)).toBe(false);
	}
	// What a launch grants doesn't depend on what the directory holds, so a run made inside it
	// after the launch is in no grant.
	let busy = disk({
		...tree,
		[hidden]: ["runs", "machine.json"],
		[`${hidden}/runs`]: ["first", "later"],
	});
	expect(readGrantsAround(["/usr", "/home"], hidden, busy, "linux").sort()).toEqual(grants);
});

test("a root that doesn't hold the state directory is granted as it is, and one inside it not at all", () => {
	let hidden = "/home/me/state";
	let none = disk({});
	expect(readGrantsAround(["/usr", "/opt"], hidden, none, "linux")).toEqual(["/usr", "/opt"]);
	expect(readGrantsAround([hidden, `${hidden}/runs`], hidden, none, "linux")).toEqual([]);
});

test("a link is granted by the real path it leads to, unless that is in the state directory or holds it", () => {
	let hidden = "/home/me/state";
	let around = disk(
		{ "/home/me": ["a", "dotfiles", "into", "over", "private", "state"] },
		["/home/me/private"],
		{
			"/home/me/a": "/data/a",
			"/home/me/dotfiles": "/home/me/dotfiles-real",
			"/home/me/into": "/home/me/state/runs",
			"/home/me/over": "/home",
		},
	);
	expect(readGrantsAround(["/home/me"], hidden, around, "linux").sort()).toEqual([
		"/data/a",
		"/home/me/dotfiles-real",
	]);
});

test("a root reached through a link that holds the state directory is walked at its real path", () => {
	let around = disk(
		{ "/var/home": ["me", "you"], "/var/home/me": ["notes", "state"] },
		[],
		{ "/home": "/var/home" },
	);
	expect(readGrantsAround(["/home"], "/var/home/me/state", around, "linux").sort()).toEqual([
		"/var/home/me/notes",
		"/var/home/you",
	]);
});

test("on Windows and macOS the state directory is found whatever the case its path is written in", () => {
	let around = disk({
		"C:\\Users": ["Me", "Other"],
		"C:\\Users\\Me": ["Documents", ".Local"],
		"C:\\Users\\Me\\.Local": ["State"],
		"C:\\Users\\Me\\.Local\\State": ["Chopin", "Mise"],
	});
	expect(
		readGrantsAround(
			["C:\\Users"],
			"c:\\users\\me\\.local\\state\\chopin",
			around,
			"win32",
		).sort(),
	).toEqual([
		"C:\\Users\\Me\\.Local\\State\\Mise",
		"C:\\Users\\Me\\Documents",
		"C:\\Users\\Other",
	]);
	let mac = disk({ "/": ["Users", "usr"], "/Users": ["me"], "/Users/me": ["Library", "State"] });
	expect(readGrantsAround(["/"], "/Users/me/state", mac, "darwin").sort()).toEqual([
		"/Users/me/Library",
		"/usr",
	]);
});

/** A Windows disk of directories, for the read roots: `list` names what is directly in one. */
function windowsDisk(directories: string[]) {
	let known = new Set(directories.map(path => path.toLowerCase()));
	return {
		directory: (path: string) => known.has(path.toLowerCase()),
		list: (path: string) =>
			directories.filter(item => item.toLowerCase().startsWith(`${path.toLowerCase()}\\`))
				.map(item => item.slice(path.length + 1)).filter(name => !name.includes("\\")),
	};
}

test("on Windows a launch reads the profile and MXC's baseline for a container, and no other folder or drive", () => {
	let home = "C:\\Users\\me";
	let disk = windowsDisk([
		home,
		"C:\\Tools\\bin",
		"D:\\sdk\\bin",
		"D:\\go",
		"C:\\Windows",
		"C:\\Windows\\System32",
		"C:\\Users\\me\\AppData\\Local\\Programs",
		"C:\\Users\\me\\AppData\\Local\\Programs\\Git",
		"C:\\Users\\me\\AppData\\Local\\Programs\\Python",
		"C:\\Program Files\\PowerShell\\Modules",
		// Folders the person can read and the baseline does not name.
		"D:\\data",
		"E:\\",
		"C:\\Users\\other",
	]);
	let roots = windowsReadRoots(
		{
			// Windows' own spelling of the name, a blank entry and one that isn't there, which MXC skips.
			Path: "C:\\Tools\\bin;;C:\\Windows\\System32;D:\\sdk\\bin;C:\\gone;d:\\SDK\\bin",
			GOROOT: "D:\\go",
			PSModulePath: "C:\\Program Files\\PowerShell\\Modules;C:\\missing\\Modules",
			LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local",
			WINDIR: "C:\\Windows",
		},
		home,
		disk,
	);
	expect(roots).toEqual([
		home,
		"C:\\Tools\\bin",
		"D:\\sdk\\bin",
		"C:\\Program Files\\PowerShell\\Modules",
		"D:\\go",
		"C:\\Users\\me\\AppData\\Local\\Programs\\Git",
		"C:\\Users\\me\\AppData\\Local\\Programs\\Python",
	]);
	// A blank, absent or empty-valued PATH grants nothing but the profile.
	for (let env of [{}, { PATH: "" }, { PATH: ";;" }, { Path: undefined }]) {
		expect(windowsReadRoots(env, home, disk)).toEqual([home]);
	}
});
