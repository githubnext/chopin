import { isIPv6 } from "node:net";

/** What the owner chose for the sandbox, saved with the rest of `chopin connect`'s settings. */
export type SandboxSettings = {
	/** Hosts agents may reach beyond the built-in list (`host`, `*.host` or `host:port`). */
	hosts?: string[];
	/** Directories agents may write beyond their worktree and own state, shared with each microVM. */
	writable?: string[];
	/** Files and folders inside what a microVM is given that no agent may read or write. */
	hidden?: string[];
};

/**
 * The hosts every sandboxed run may reach, grouped by what needs them. Every entry is a fixed
 * public service: a package registry, a toolchain download, documentation or a model provider.
 * None is general-purpose storage a stranger can write to and read back (`storage.googleapis.com`,
 * `*.blob.core.windows.net`, `s3.amazonaws.com`, `gist.githubusercontent.com`, a paste site), and
 * no `*.` entry covers such a service, since those are where an injected instruction would send
 * what an agent read. The registries and GitHub still accept writes from whoever holds a token,
 * which is why a run's own tokens stay limited to what Chopin's work needs. Sources: GitHub
 * Agentic Workflows' ecosystem lists (github/gh-aw, pkg/workflow/data/ecosystem_domains.json),
 * Claude Code on the web's Trusted list and Codex's "common dependencies" preset.
 */
export const HOST_GROUPS = {
	github: [
		"github.com",
		"api.github.com",
		"codeload.github.com",
		"objects.githubusercontent.com",
		"raw.githubusercontent.com",
		"release-assets.githubusercontent.com",
		"github-releases.githubusercontent.com",
		"lfs.github.com",
	],
	models: [
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
	],
	/** Certificate revocation checks, which the JVM, .NET and package managers make while downloading. */
	certificates: [
		"ocsp.digicert.com",
		"crl3.digicert.com",
		"crl4.digicert.com",
		"ocsp.sectigo.com",
		"crl.sectigo.com",
		"ocsp.usertrust.com",
		"crl.usertrust.com",
		"ocsp.globalsign.com",
		"crl.globalsign.com",
		"ocsp.ssl.com",
		"crls.ssl.com",
		"ocsp.identrust.com",
		"crl.identrust.com",
		"oneocsp.microsoft.com",
		"r10.o.lencr.org",
		"r11.o.lencr.org",
		"x1.c.lencr.org",
	],
	javascript: [
		"registry.npmjs.org",
		"registry.npmjs.com",
		"registry.yarnpkg.com",
		"repo.yarnpkg.com",
		"get.pnpm.io",
		"jsr.io",
		"nodejs.org",
		"bun.sh",
		"deno.land",
		"dl.deno.land",
	],
	python: [
		"pypi.org",
		"pypi.python.org",
		"files.pythonhosted.org",
		"bootstrap.pypa.io",
		"astral.sh",
		"conda.anaconda.org",
		"repo.anaconda.com",
	],
	rust: [
		"crates.io",
		"index.crates.io",
		"static.crates.io",
		"static.rust-lang.org",
		"sh.rustup.rs",
		"docs.rs",
	],
	go: ["proxy.golang.org", "sum.golang.org", "go.dev", "golang.org", "pkg.go.dev", "dl.google.com"],
	jvm: [
		"repo.maven.apache.org",
		"repo1.maven.org",
		"central.sonatype.com",
		"maven.google.com",
		"plugins.gradle.org",
		"plugins-artifacts.gradle.org",
		"services.gradle.org",
		"downloads.gradle.org",
		"downloads.gradle-dn.com",
		"repo.gradle.org",
		"dlcdn.apache.org",
		"archive.apache.org",
		"api.adoptium.net",
		"api.foojay.io",
		"cdn.azul.com",
		"download.java.net",
		"jdk.java.net",
		"download.jetbrains.com",
		"repo.scala-sbt.org",
		"repo.clojars.org",
	],
	dotnet: [
		"dot.net",
		"dotnet.microsoft.com",
		"builds.dotnet.microsoft.com",
		"ci.dot.net",
		"nuget.org",
		"api.nuget.org",
		"globalcdn.nuget.org",
		"dist.nuget.org",
	],
	ruby: ["rubygems.org", "index.rubygems.org", "api.rubygems.org", "cache.ruby-lang.org"],
	php: ["packagist.org", "repo.packagist.org", "getcomposer.org"],
	perl: ["cpan.org", "www.cpan.org", "metacpan.org", "cpan.metacpan.org", "fastapi.metacpan.org"],
	lua: ["luarocks.org"],
	haskell: ["hackage.haskell.org", "downloads.haskell.org", "get-ghcup.haskell.org"],
	ocaml: ["opam.ocaml.org", "ocaml.org"],
	elixir: ["hex.pm", "repo.hex.pm", "builds.hex.pm", "cdn.hex.pm"],
	swift: ["download.swift.org", "swift.org", "cdn.cocoapods.org"],
	dart: ["pub.dev", "pub.dartlang.org"],
	julia: ["pkg.julialang.org", "*.pkg.julialang.org", "julialang-s3.julialang.org"],
	r: ["cloud.r-project.org", "cran.r-project.org"],
	zig: ["ziglang.org"],
	"c-cpp": ["center2.conan.io"],
	bazel: ["releases.bazel.build", "bcr.bazel.build", "mirror.bazel.build"],
	nix: ["cache.nixos.org", "channels.nixos.org"],
} as const satisfies Record<string, readonly string[]>;

export type HostGroup = keyof typeof HOST_GROUPS;

/** The built-in hosts, every group's together. */
export const BUILT_IN_HOST_LIST: readonly string[] = [
	...new Set(Object.values(HOST_GROUPS).flat()),
];

/** The ports an entry without its own port allows: HTTPS, and HTTP for the registries that use it. */
const WEB_PORTS = new Set([80, 443]);

/**
 * Every host a sandboxed run may reach: Chopin's own origin (with its port), the built-in groups
 * above, and `extra` from the owner's configuration.
 */
export function allowedHosts(server: string, extra: readonly string[] = []): string[] {
	let url = new URL(server);
	let port = url.port || (url.protocol === "https:" ? "443" : "80");
	let host = url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;
	let origin = host.includes(":") ? `[${host}]:${port}` : `${host}:${port}`;
	return [...new Set([origin, ...BUILT_IN_HOST_LIST, ...extra])];
}

/** An entry as the proxy matches it: a host or `*.` suffix and the one port it is limited to. */
function parseEntry(entry: string) {
	let match = entry.trim().toLowerCase().match(/^(\[[0-9a-f:]+\]|[^:]+)(?::(\d{1,5}))?$/);
	if (!match) return undefined;
	let host = match[1]!.replace(/^\[|\]$/g, "");
	return { host, port: match[2] === undefined ? undefined : Number(match[2]) };
}

const BUILT_IN_HOSTS = new Set(BUILT_IN_HOST_LIST);

/**
 * Whether an entry is one the owner chose: Chopin's own origin or a host added with
 * `--sandbox-host`, which may be on a private network, as a self-hosted server or a corporate
 * registry is. The built-in names are public services, so a name of theirs that leads to a
 * private address has been pointed there.
 */
export function ownerEntry(entry: string) {
	return !BUILT_IN_HOSTS.has(entry.trim().toLowerCase());
}

/** The entries of `hosts` that allow a connection to `host` on `port`. */
export function matchingEntries(
	hosts: readonly string[],
	host: string,
	port: number,
): string[] {
	let name = host.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
	return hosts.filter(entry => {
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

/** The first entry of `hosts` that allows a connection to `host` on `port`, if one does. */
export function matchingEntry(
	hosts: readonly string[],
	host: string,
	port: number,
): string | undefined {
	return matchingEntries(hosts, host, port)[0];
}

/** An entry the owner may add: `host`, `*.host` or `host:port`, with no scheme or path. */
export function validHostEntry(entry: string) {
	return /^(\*\.)?[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d{1,5})?$/i.test(entry)
		&& !/^\*\.[^.]*$/.test(entry);
}

/**
 * An entry the connector allows as it runs, as its database's `host:port`: one an owner may add,
 * or an IPv6 address in brackets, as a URL writes it; any port is 1 to 65535.
 */
export function validAllowedEntry(entry: string) {
	let match = entry.match(/^(?:\[([0-9a-f:]+)\]|([^:[\]]+))(?::(\d{1,5}))?$/i);
	if (!match) return false;
	let [, address, name, port] = match;
	if (port !== undefined && (Number(port) < 1 || Number(port) > 65_535)) return false;
	return address === undefined ? validHostEntry(name!) : isIPv6(address);
}

/** Where the connector keeps the clones it made, in its state directory. */
export const CLONES = "repos";
