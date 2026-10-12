import { randomBytes } from "node:crypto";
import { chmod, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { VERSION } from "./version";

/**
 * `chopin update [version]`: install a release over the running binary, verified as install.sh
 * and install.ps1 verify one, and read from the same settings:
 *
 * CHOPIN_VERIFY_ATTESTATION   0 skips `gh attestation verify`, which otherwise runs when gh is installed
 * CHOPIN_RELEASE_BASE_URL     where cli-v<version>/ assets are downloaded from
 * CHOPIN_RELEASES_API_URL     the GitHub API list of releases used to find the newest version
 */
const REPOSITORY = "githubnext/chopin";

class UpdateError extends Error {}

function fail(message: string): never {
	throw new UpdateError(`chopin update: ${message}`);
}

/** https, or plain http only from a server on this machine, as the tests use. */
function allowed(value: string) {
	let url = URL.parse(value);
	return url?.protocol === "https:" || url?.protocol === "http:" && !url.username
			&& !url.password && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
}

/** Follows redirects only to https. */
async function download(url: string) {
	let current = url;
	for (let hop = 0; hop < 10; hop++) {
		let response;
		try {
			response = await fetch(current, {
				redirect: "manual",
				headers: { "user-agent": `chopin/${VERSION}` },
			});
		} catch (error) {
			fail(`could not download ${url}: ${error instanceof Error ? error.message : error}`);
		}
		let location = response.headers.get("location");
		if (response.status >= 300 && response.status < 400 && location) {
			let next = new URL(location, current).href;
			if (!next.startsWith("https://")) {
				fail(`${url} was redirected to ${next}, which is not HTTPS. Refusing to use it.`);
			}
			current = next;
			continue;
		}
		if (!response.ok) fail(`could not download ${url} (HTTP ${response.status}).`);
		return response;
	}
	fail(`${url} redirected too many times.`);
}

/** 0.2.0 from 0.2.0, v0.2.0 or cli-v0.2.0. */
function releaseVersion(tag: string) {
	let version = tag.replace(/^cli-/, "").replace(/^v/, "");
	if (!/^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$/.test(version)) {
		fail(`"${version}" is not a version like 0.2.0.`);
	}
	return version;
}

function assetName() {
	let os = { linux: "linux", darwin: "darwin", win32: "windows" }[process.platform as string];
	let arch = process.arch;
	if (!os || !["x64", "arm64"].includes(arch)) {
		fail(`chopin is not released for ${process.platform} on ${arch}.`);
	}
	// An x64 chopin under Rosetta on Apple silicon updates to the native one.
	if (
		os === "darwin" && arch === "x64"
		&& Bun.spawnSync(["sysctl", "-n", "sysctl.proc_translated"]).stdout.toString().trim() === "1"
	) arch = "arm64";
	return `chopin-${os}-${arch}${os === "windows" ? ".exe" : ""}`;
}

/** Leaves `target` as it was unless the new binary is fully in place. */
async function replace(target: string, bytes: Uint8Array) {
	// Staged beside the target, in a new file of its own, so the rename stays on one filesystem.
	let staged = join(dirname(target), `.chopin-${randomBytes(6).toString("hex")}.new`);
	try {
		await writeFile(staged, bytes, { flag: "wx", mode: 0o755 });
		await chmod(staged, 0o755);
		if (process.platform !== "win32") {
			await rename(staged, target);
			return;
		}
		// A running .exe cannot be replaced or deleted, but it can be renamed. The next start of
		// chopin deletes the old one.
		let old = `${target}.old`;
		await rm(old, { force: true });
		await rename(target, old);
		try {
			await rename(staged, target);
		} catch (error) {
			await rename(old, target);
			throw error;
		}
	} finally {
		await rm(staged, { force: true });
	}
}

/** Deletes the binary a Windows update renamed aside while it was running. */
export async function removeReplaced() {
	if (Bun.isStandaloneExecutable && process.platform === "win32") {
		await rm(`${process.execPath}.old`, { force: true }).catch(() => {});
	}
}

/** The newest CLI release that is neither a draft nor a prerelease. */
async function newest(api: string) {
	let releases = await (await download(`${api}?per_page=100`)).json().catch(() => []) as Array<
		{ tag_name?: unknown; draft?: unknown; prerelease?: unknown }
	>;
	let latest = Array.isArray(releases)
		? releases.find(item =>
			typeof item.tag_name === "string" && item.tag_name.startsWith("cli-v") && !item.draft
			&& !item.prerelease
		)
		: undefined;
	if (!latest) fail("no chopin CLI release (a cli-v* tag) was found.");
	return releaseVersion(latest.tag_name as string);
}

/** The release a Chopin server recommends to its connectors, if it can be asked. */
async function recommended(server: string) {
	try {
		let body = await (await download(`${server}/api/connector/version`)).json() as {
			version?: unknown;
		};
		if (typeof body.version !== "string") return { reason: "it recommends none" };
		return { version: releaseVersion(body.version) };
	} catch (error) {
		return {
			reason: (error instanceof Error ? error.message : String(error)).replace(
				/^chopin update: /,
				"",
			),
		};
	}
}

async function confirm(question: string) {
	process.stdout.write(`${question} [y/N] `);
	for await (let line of console) return /^y(es)?$/i.test(line.trim());
	return false;
}

/**
 * Install `options.version`, or else the release the Chopin server at `server` recommends, or
 * else the newest. An older release needs `allowDowngrade`; on a terminal, it asks first unless
 * `yes`. Without a terminal it goes ahead, since only an upgrade or an allowed downgrade gets here.
 */
export async function update(
	options: { version?: string; allowDowngrade?: boolean; yes?: boolean; server: string },
	log = console.log,
) {
	if (!Bun.isStandaloneExecutable) {
		fail(
			"this connector is running as a script, not an installed chopin. "
				+ "Download connector.js from your Chopin server again to update it.",
		);
	}
	let base = process.env.CHOPIN_RELEASE_BASE_URL
		?? `https://github.com/${REPOSITORY}/releases/download`;
	let api = process.env.CHOPIN_RELEASES_API_URL
		?? `https://api.github.com/repos/${REPOSITORY}/releases`;
	for (let [name, value] of [["CHOPIN_RELEASE_BASE_URL", base], ["CHOPIN_RELEASES_API_URL", api]]) {
		if (!allowed(value)) {
			fail(
				`${name} must be an https:// URL (or http:// on 127.0.0.1, localhost or [::1]), not ${value}.`,
			);
		}
	}
	let target = process.execPath;
	let asset = assetName();
	let version = options.version === undefined ? undefined : releaseVersion(options.version);
	if (!version) {
		let wanted = await recommended(options.server);
		version = wanted.version;
		if (!version) {
			version = await newest(api);
			log(
				`Could not ask ${options.server} which chopin to install (${wanted.reason}), `
					+ `so installing the newest release, ${version}, instead.`,
			);
		}
	}
	if (version === VERSION) {
		log(`chopin ${VERSION} is already installed at ${target}.`);
		return;
	}
	if (Bun.semver.order(version, VERSION) < 0 && !options.allowDowngrade) {
		fail(
			`${version} is older than the installed chopin ${VERSION}. To install it anyway, run: `
				+ `chopin update ${version} --allow-downgrade`,
		);
	}
	if (
		process.stdin.isTTY && !options.yes
		&& !await confirm(`Update chopin from ${VERSION} to ${version}?`)
	) fail("not updated.");

	let release = `${base}/cli-v${version}`;
	log(`Downloading chopin ${version} (${asset}) from ${release}`);
	let bytes = new Uint8Array(await (await download(`${release}/${asset}`)).arrayBuffer());
	let checksums = await (await download(`${release}/checksums.txt`)).text();
	let expected = checksums.split(/\r?\n/).map(line =>
		line.match(/^([0-9a-fA-F]{64})\s+\*?(\S+)\s*$/)
	).find(match => match?.[2] === asset)?.[1].toLowerCase();
	if (!expected) fail(`checksums.txt has no entry for ${asset}.`);
	let actual = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
	if (actual !== expected) {
		fail(
			`the SHA-256 of ${asset} is ${actual}, but checksums.txt says ${expected}. `
				+ "Refusing to install it.",
		);
	}
	log("Verified the SHA-256 checksum.");

	let scratch = await mkdtemp(join(tmpdir(), "chopin-update-"));
	try {
		let downloaded = join(scratch, asset);
		await writeFile(downloaded, bytes, { mode: 0o755 });
		let gh = process.env.CHOPIN_VERIFY_ATTESTATION === "0" ? null : Bun.which("gh");
		if (gh) {
			let verified = Bun.spawnSync([gh, "attestation", "verify", downloaded, "-R", REPOSITORY], {
				stdout: "inherit",
				stderr: "inherit",
			});
			if (!verified.success) {
				fail(
					`gh attestation verify could not confirm ${asset} was built by ${REPOSITORY}. `
						+ "Refusing to install it. (CHOPIN_VERIFY_ATTESTATION=0 skips this check.)",
				);
			}
			log("Verified the build provenance attestation.");
		}
		let ran = Bun.spawnSync([downloaded, "--version"], { stdout: "pipe", stderr: "pipe" });
		if (!ran.success) {
			fail(
				`the downloaded chopin does not run on this machine: ${
					(ran.stdout.toString() + ran.stderr.toString()).trim()
				}`,
			);
		}
	} finally {
		await rm(scratch, { recursive: true, force: true });
	}

	await replace(target, bytes);
	// An installed background service, once chopin can install one, restarts here.
	log(`Updated chopin from ${VERSION} to ${version} at ${target}.`);
}
