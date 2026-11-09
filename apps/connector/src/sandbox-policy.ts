import { isAbsolute, posix, win32 } from "node:path";
import { windowsArgument } from "./windows-argument";

/** The process sandbox each system gives through MXC. */
export type SandboxEngine = "seatbelt" | "bubblewrap" | "processcontainer";

/** What the owner chose for the sandbox, saved with the rest of `chopin connect`'s settings. */
export type SandboxSettings = {
	/** Refuse a run the sandbox can't cover, instead of running it unsandboxed. */
	require?: boolean;
	/** Never sandbox. */
	off?: boolean;
	/** Hosts agents may reach beyond the built-in list (`host`, `*.host` or `host:port`). */
	hosts?: string[];
	/** Directories agents may write beyond their worktree and own state. */
	writable?: string[];
};

/** Hosts every run may reach: GitHub, for git and the API, as Chopin's work needs them. */
export const GITHUB_HOSTS = [
	"github.com",
	"api.github.com",
	"codeload.github.com",
	"objects.githubusercontent.com",
	"raw.githubusercontent.com",
];

/** Package registries for npm, PyPI and crates. */
export const REGISTRY_HOSTS = [
	"registry.npmjs.org",
	"pypi.org",
	"files.pythonhosted.org",
	"crates.io",
	"index.crates.io",
	"static.crates.io",
];

/** The model providers the built-in agents and the common ACP agents talk to. */
export const MODEL_HOSTS = [
	"api.anthropic.com",
	"api.openai.com",
	"chatgpt.com",
	"auth.openai.com",
	"generativelanguage.googleapis.com",
	"oauth2.googleapis.com",
	"*.githubcopilot.com",
	"copilot-proxy.githubusercontent.com",
	"openrouter.ai",
	"*.openai.azure.com",
];

/** The ports an entry without its own port allows: HTTPS, and HTTP for the registries that use it. */
const WEB_PORTS = new Set([80, 443]);

/**
 * Every host a sandboxed run may reach: Chopin's own origin (with its port), GitHub, the model
 * providers, the package registries, and `extra` from the owner's configuration.
 */
export function allowedHosts(server: string, extra: readonly string[] = []): string[] {
	let url = new URL(server);
	let port = url.port || (url.protocol === "https:" ? "443" : "80");
	let host = url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;
	let origin = host.includes(":") ? `[${host}]:${port}` : `${host}:${port}`;
	return [...new Set([origin, ...GITHUB_HOSTS, ...MODEL_HOSTS, ...REGISTRY_HOSTS, ...extra])];
}

/** An entry as the proxy matches it: a host or `*.` suffix and the one port it is limited to. */
function parseEntry(entry: string) {
	let match = entry.trim().toLowerCase().match(/^(\[[0-9a-f:]+\]|[^:]+)(?::(\d{1,5}))?$/);
	if (!match) return undefined;
	let host = match[1]!.replace(/^\[|\]$/g, "");
	return { host, port: match[2] === undefined ? undefined : Number(match[2]) };
}

/** Whether `host` is a name that always means this machine, or an IP address. */
export function isLocalEntry(entry: string) {
	let host = parseEntry(entry)?.host;
	if (!host) return false;
	return host === "localhost" || host.endsWith(".localhost") || /^[0-9.]+$/.test(host)
		|| host.includes(":");
}

/** The entry of `hosts` that allows a connection to `host` on `port`, if one does. */
export function matchingEntry(
	hosts: readonly string[],
	host: string,
	port: number,
): string | undefined {
	let name = host.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
	return hosts.find(entry => {
		let parsed = parseEntry(entry);
		if (!parsed) return false;
		if (parsed.port === undefined ? !WEB_PORTS.has(port) : parsed.port !== port) {
			return false;
		}
		return parsed.host.startsWith("*.")
			? name.endsWith(parsed.host.slice(1)) && name.length > parsed.host.length - 1
			: name === parsed.host;
	});
}

/** An entry the owner may add: `host`, `*.host` or `host:port`, with no scheme or path. */
export function validHostEntry(entry: string) {
	return /^(\*\.)?[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d{1,5})?$/i.test(entry)
		&& !/^\*\.[^.]*$/.test(entry);
}

/**
 * Where a person keeps credentials and personal data an agent has no need of: SSH and GPG keys,
 * cloud and GitHub logins, container registry logins, and browser profiles. The agent's own
 * model login is not here; it stays readable.
 */
export function secretPaths(platform: NodeJS.Platform, home: string): string[] {
	let path = platform === "win32" ? win32 : posix;
	let under = (...parts: string[]) => path.join(home, ...parts);
	let common = [
		under(".ssh"),
		under(".aws"),
		under(".azure"),
		under(".kube"),
		under(".docker"),
		under(".gnupg"),
		under(".netrc"),
		under(".git-credentials"),
		under(".pypirc"),
		under(".cargo", "credentials.toml"),
	];
	if (platform === "win32") {
		return [
			...common,
			under("AppData", "Roaming", "GitHub CLI"),
			under("AppData", "Roaming", "gcloud"),
			under("AppData", "Local", "Google", "Chrome"),
			under("AppData", "Local", "Microsoft", "Edge"),
			under("AppData", "Local", "BraveSoftware"),
			under("AppData", "Roaming", "Mozilla"),
		];
	}
	if (platform === "darwin") {
		return [
			...common,
			under(".config", "gh"),
			under(".config", "gcloud"),
			under("Library", "Keychains"),
			under("Library", "Cookies"),
			under("Library", "Safari"),
			under("Library", "Application Support", "Google", "Chrome"),
			under("Library", "Application Support", "Microsoft Edge"),
			under("Library", "Application Support", "BraveSoftware"),
			under("Library", "Application Support", "Firefox"),
			under("Library", "Application Support", "gcloud"),
		];
	}
	return [
		...common,
		under(".config", "gh"),
		under(".config", "gcloud"),
		under(".config", "google-chrome"),
		under(".config", "chromium"),
		under(".config", "microsoft-edge"),
		under(".config", "BraveSoftware"),
		under(".mozilla"),
		under("snap", "firefox"),
		under("snap", "chromium"),
	];
}

/**
 * The directories an agent keeps its own state in: its sessions, journal and settings. Known for
 * the built-in agents; any other agent's are added with `--sandbox-write`. An agent's own
 * variables for these directories move them.
 */
export function agentStateDirectories(
	command: readonly string[],
	env: Record<string, string | undefined>,
	home: string,
	platform: NodeJS.Platform = process.platform,
): string[] {
	let path = platform === "win32" ? win32 : posix;
	let program = path.basename(command[0] ?? "").replace(/\.(exe|cmd|bat|ps1)$/i, "");
	let dirs: string[] = [];
	if (program === "atomic" || program === "atomic-acp") {
		dirs.push(path.join(home, ".atomic"));
		for (
			let name of [
				"ATOMIC_CODING_AGENT_DIR",
				"ATOMIC_CODING_AGENT_SESSION_DIR",
				"ATOMIC_WORKFLOW_ARTIFACT_DIR",
			]
		) {
			let value = env[name];
			if (value && isAbsolute(value)) dirs.push(value);
		}
	} else if (program === "copilot") {
		dirs.push(path.join(home, ".copilot"));
		if (env.COPILOT_HOME && isAbsolute(env.COPILOT_HOME)) dirs.push(env.COPILOT_HOME);
	} else if (program === "pdd-kit") {
		dirs.push(path.join(home, ".pdd-kit"));
	}
	return dirs;
}

/** One argument as a POSIX shell reads it back unchanged. */
export function shellWord(value: string) {
	return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

/** The command line MXC runs: the executor hands it to `sh -c`, or to Windows as a line. */
export function commandLine(platform: NodeJS.Platform, words: readonly string[]) {
	return platform === "win32"
		? words.map(windowsArgument).join(" ")
		: `exec ${words.map(shellWord).join(" ")}`;
}

/** What one launch may touch, once the connector has looked at the disk. */
export type Policy = {
	platform: NodeJS.Platform;
	engine: SandboxEngine;
	command: readonly string[];
	cwd: string;
	/** The whole environment the process gets; MXC starts from an empty one. */
	env: Record<string, string | undefined>;
	/** Everything the process may read, beyond what it may write. */
	readable: readonly string[];
	/** Where it may write: its own worktree, its state, its private temporary directory. */
	writable: readonly string[];
	/** Inside a writable directory, read-only: what git reads to decide which programs to run. */
	readonlyInside?: readonly string[];
	/** Credentials and other runs' files, which it may not even read. */
	denied: readonly string[];
	/** The loopback proxy that decides which hosts it reaches. */
	proxy: string;
};

/** The MXC 1.0.0 request JSON, the same shape on every system. */
export type MxcRequest = {
	version: "1.0.0";
	containment: "bubblewrap" | "seatbelt" | "processcontainer";
	process: { commandLine: string; cwd: string; env: string[]; timeout: 0 };
	filesystem: { readonlyPaths: string[]; readwritePaths: string[]; deniedPaths: string[] };
	network: {
		egress: { default: "deny" };
		ingress: { default: "allow" | "deny"; hostLoopback: "allow" | "deny" };
	};
	runtimeConfig: { networkProxy: string };
};

const CONTAINMENT = {
	bubblewrap: "bubblewrap",
	seatbelt: "seatbelt",
	processcontainer: "processcontainer",
} as const;

/**
 * The request for one launch. Egress is denied outright and the only way out is the proxy, which
 * checks hosts, because no engine can filter by name. A Windows ProcessContainer needs ingress
 * allowed, and host loopback with it, to reach a proxy that has no package identity. No
 * `telemetry` is set, so MXC's stays off. `timeout` 0 leaves the run's length to the connector.
 */
export function mxcRequest(policy: Policy): MxcRequest {
	let windows = policy.platform === "win32";
	return {
		version: "1.0.0",
		containment: CONTAINMENT[policy.engine],
		process: {
			commandLine: commandLine(policy.platform, policy.command),
			cwd: policy.cwd,
			env: Object.entries(policy.env).flatMap(([name, value]) =>
				value === undefined ? [] : [`${name}=${value}`]
			),
			timeout: 0,
		},
		filesystem: {
			readonlyPaths: [...new Set([...policy.readable, ...policy.readonlyInside ?? []])],
			readwritePaths: [...new Set(policy.writable)],
			deniedPaths: [...new Set(policy.denied)],
		},
		network: {
			egress: { default: "deny" },
			ingress: windows
				? { default: "allow", hostLoopback: "allow" }
				: { default: "deny", hostLoopback: "deny" },
		},
		runtimeConfig: { networkProxy: policy.proxy },
	};
}

/**
 * PATH with each directory by the path it really has. A shell's PATH may name a directory through
 * a link that lies where the sandbox shows nothing (a version manager's per-login link under
 * /run), and the programs behind it are readable at their real path.
 */
export function sandboxPath(
	value: string | undefined,
	platform: NodeJS.Platform,
	real: (path: string) => string,
): string | undefined {
	if (value === undefined) return undefined;
	let delimiter = platform === "win32" ? ";" : ":";
	let seen = new Set<string>();
	let entries: string[] = [];
	for (let entry of value.split(delimiter)) {
		if (!entry) continue;
		let resolved = real(entry);
		if (seen.has(resolved)) continue;
		seen.add(resolved);
		entries.push(resolved);
	}
	return entries.join(delimiter);
}

/** The top-level directories of a POSIX root worth reading; the sandbox supplies the others. */
export function readableRoots(names: readonly string[]): string[] {
	let skipped = new Set(["dev", "proc", "sys", "run", "tmp", "boot", "lost+found"]);
	return names.filter(name => !skipped.has(name)).map(name => `/${name}`);
}

/** What `readGrantsAround` asks of the disk. */
export type Disk = {
	/** The names in a directory; none where it can't be listed. */
	list(directory: string): string[];
	/** The real path of a directory or file this user can read at `path`; undefined for anything else. */
	resolve(path: string): string | undefined;
};

/**
 * The read grants for `roots` that leave `hidden`, the connector's state directory, out. Seatbelt
 * lets a denial win over every grant, so no denial of a directory can leave a launch its own paths
 * inside it, and a denial of what is there when the launch starts doesn't cover what is made in
 * the directory later: another run, a Planner, a token file. So nothing in `roots` is granted as a
 * whole where it holds `hidden`. Each directory from the root down to it is listed instead, and
 * everything in it but the way to `hidden` is granted by its real path; what a launch may use in
 * `hidden` is granted to it by name. What is made in `hidden` later is in no grant, on any system.
 * A link that leads into `hidden`, or to a directory holding it, is left out.
 */
export function readGrantsAround(
	roots: readonly string[],
	hidden: string,
	disk: Disk,
	platform: NodeJS.Platform = process.platform,
): string[] {
	let path = platform === "win32" ? win32 : posix;
	// Windows and macOS file systems usually ignore case, so a path written another way is the same.
	let fold = (value: string) =>
		platform === "win32" || platform === "darwin" ? value.toLowerCase() : value;
	let within = (inner: string, outer: string) => {
		let prefix = fold(outer.endsWith(path.sep) ? outer : outer + path.sep);
		return fold(inner) === fold(outer) || fold(inner).startsWith(prefix);
	};
	let grants = new Set<string>();
	let around = (directory: string) => {
		let toward = path.relative(directory, hidden).split(path.sep)[0]!;
		for (let name of disk.list(directory)) {
			let child = path.join(directory, name);
			if (fold(name) === fold(toward)) {
				if (fold(child) !== fold(hidden)) around(child);
				continue;
			}
			let real = disk.resolve(child);
			if (real && !within(real, hidden) && !within(hidden, real)) grants.add(real);
		}
	};
	for (let root of roots) {
		let real = disk.resolve(root) ?? root;
		if (within(real, hidden)) continue;
		if (within(hidden, real)) around(real);
		else grants.add(root);
	}
	return [...grants];
}
