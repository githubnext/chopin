import { expect, test } from "bun:test";
import {
	allowedHosts,
	BUILT_IN_HOST_LIST,
	HOST_GROUPS,
	matchingEntry,
	ownerEntry,
	validAllowedEntry,
	validHostEntry,
} from "./sandbox-policy";

test("the proxy lets a run reach Chopin, GitHub, the model providers and every common language's registries", () => {
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
			["static.rust-lang.org", 443],
			["sh.rustup.rs", 443],
			["opam.ocaml.org", 443],
			["builds.dotnet.microsoft.com", 443],
			["api.nuget.org", 443],
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

test("a host the connector allows as it runs may also be an IPv6 address in brackets, on a real port", () => {
	for (
		let good of [
			"db.example.com:5432",
			"10.0.0.5:5432",
			"[2001:db8::1]:5432",
			"[::1]:65535",
			"[::1]",
		]
	) {
		expect(validAllowedEntry(good), good).toBe(true);
	}
	for (
		let bad of [
			"[2001:db8::1:5432",
			"[db.example.com]:5432",
			"[1:2:3:4:5:6:7:8:9]:5432",
			"2001:db8::1:5432",
			"[::1]:0",
			"[::1]:65536",
			"db.example.com:99999",
			"https://db.example.com:5432",
		]
	) {
		expect(validAllowedEntry(bad), bad).toBe(false);
	}
});
