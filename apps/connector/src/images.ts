import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
	chmod,
	copyFile,
	link,
	lstat,
	mkdir,
	readdir,
	readFile,
	rename,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { readFileSync, statSync } from "node:fs";
import { basename, join, sep } from "node:path";
import { AGENTS } from "@chopin/protocol/agents";
import {
	BUILD_PACKAGES,
	GUEST_PACKAGES,
	type GuestPackage,
	UBUNTU_ARCHIVE,
} from "./guest-packages";
import { type AgentImage, IMAGE_GUEST_PATH, NVX_RELEASE, type VmSpec } from "./nvx";
import { holds, processStart, staleLock, type StartProbe } from "./workspace";

/** The Node.js every image runs its agent on: the 24 line, pinned by version and SHA-256. */
export const NODE_RELEASE = {
	version: "24.22.3",
	file: "node-v24.22.3-linux-x64.tar.gz",
	sha256: "061ec3e3062115705b56b51fa9cc330ab50d34b6969387d4e4b1a50c6809acc2",
} as const;

/** How an agent's image is made: the commands that install it, run in the build's guest. */
export type ImageRecipe = {
	/** What people call it, for the words that say an image is being built. */
	name: string;
	/** Shell commands run in order, with npm installing into the image. */
	install: string[];
	/** The programs the image must have once built, which a microVM of it is started to find. */
	programs: string[];
	/**
	 * A host folder the install reads (`--install-from`): copied for the build and shared with its
	 * microVM alone, read-only, at `INSTALL_FROM`. Its files are part of the image's key.
	 */
	from?: string;
	/**
	 * What runs from it, for the words that say it is built: the agent, the Planner command (whose
	 * image is built as chopin connects, so the first document's Planner starts at once), or both.
	 * The agent's unless said.
	 */
	runs?: Array<"agent" | "planner">;
};

/** Where an image's build reads the folder `--install-from` names. */
export const INSTALL_FROM = "/install-from";

/** A word as a POSIX shell reads it back, quoted only when it has to be. */
export function shellWord(value: string) {
	return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * The recipe of a built-in agent, by the program its ACP command starts: its npm packages at the
 * versions this release pins (`CodingAgent.image`). An image is rebuilt only when its recipe
 * changes, so a version moves only with a `chopin` release.
 */
export function builtInRecipe(program: string): ImageRecipe | undefined {
	let agent = AGENTS.find(item => item.acp[0] === program);
	return agent
		? {
			name: agent.name,
			install: [["npm", "install", "-g", ...agent.image].map(shellWord).join(" ")],
			programs: [program],
		}
		: undefined;
}

const IMAGE = IMAGE_GUEST_PATH;
const SYSTEM = `${IMAGE}/sys`;

/** What every image gives its agent's guest: its programs first on PATH, and git's own paths. */
export function imageEnvironment(): Pick<AgentImage, "path" | "environment"> {
	let certificates = `${IMAGE}/ca-certificates.crt`;
	return {
		path: [`${IMAGE}/bin`, `${IMAGE}/node/bin`, `${SYSTEM}/usr/bin`],
		environment: {
			LD_LIBRARY_PATH: `${SYSTEM}/usr/lib/x86_64-linux-gnu:${SYSTEM}/lib/x86_64-linux-gnu`,
			GIT_EXEC_PATH: `${SYSTEM}/usr/lib/git-core`,
			GIT_TEMPLATE_DIR: `${SYSTEM}/usr/share/git-core/templates`,
			SSL_CERT_FILE: certificates,
			GIT_SSL_CAINFO: certificates,
			CURL_CA_BUNDLE: certificates,
		},
	};
}

/** The guest's user, as NVX takes it: the connector's own user and group, so shares are its own. */
export type GuestUser = { uid: number; gid: number };

/**
 * An image's key: what it is made from, which a change of any part of changes. Its NVX release and
 * layer, its Node.js, its Ubuntu packages, its install commands, what the folder they read holds
 * (`from`, its `installInputs` digest) and the user it runs as.
 */
export function imageKey(
	recipe: ImageRecipe,
	layer: string,
	user: GuestUser,
	from?: string,
): string {
	return createHash("sha256")
		.update(JSON.stringify({
			nvx: NVX_RELEASE.version,
			layer,
			node: NODE_RELEASE.sha256,
			packages: [...GUEST_PACKAGES, ...BUILD_PACKAGES].map(item => item.sha256),
			install: recipe.install,
			...from === undefined ? {} : { from },
			user,
			build: buildScript(recipe, user, "00000000-0000-4000-8000-000000000000"),
		}))
		.digest("hex")
		.slice(0, 32);
}

/**
 * The digest of what the folder `from` holds: each file's path in it, content and whether it is
 * executable, and each folder's path, but not where the folder is or who owns what. With `into`,
 * also copies it there, readable by the build's `nobody` whatever the folder's own modes, so the
 * build reads exactly what was digested. Anything but a file or a folder is refused: a link would
 * lead the build to whatever it names on the host.
 */
export async function installInputs(from: string, into?: string): Promise<string> {
	let digest = createHash("sha256");
	let writable = process.platform !== "win32";
	let walk = async (relative: string) => {
		for (let name of (await readdir(join(from, relative))).sort()) {
			let path = join(relative, name);
			let info = await lstat(join(from, path));
			let shown = JSON.stringify(path.split(sep).join("/"));
			if (info.isDirectory()) {
				digest.update(`folder ${shown}\n`);
				if (into) {
					await mkdir(join(into, path));
					if (writable) await chmod(join(into, path), 0o755);
				}
				await walk(path);
			} else if (info.isFile()) {
				let content = await readFile(join(from, path));
				let executable = (info.mode & 0o111) !== 0;
				let hash = createHash("sha256").update(content).digest("hex");
				digest.update(`file ${shown} ${executable ? "executable" : "plain"} ${hash}\n`);
				if (into) {
					await writeFile(join(into, path), content);
					if (writable) await chmod(join(into, path), executable ? 0o755 : 0o644);
				}
			} else {
				throw new Error(
					`${join(from, path)} isn't a file or a folder, and an image's build is given only those.`,
				);
			}
		}
	};
	await walk("");
	return digest.digest("hex");
}

/**
 * What the build's guest runs, as its user (the layer's `nobody`), in its own memory: the release's
 * layer unpacked, Node, git and the CA bundle in `/opt/chopin/agent`, the install, an account for
 * the connector's user, then the new layer written to `/out`, compressed as the release's is.
 */
export function buildScript(recipe: ImageRecipe, user: GuestUser, uuid: string): string {
	let root = "/tmp/chopin-image/root";
	let agent = `${root}${IMAGE}`;
	return [
		"set -eu",
		"B=/tmp/chopin-image",
		`R=${root}`,
		`A=${agent}`,
		'mkdir -p "$B/tools" "$A/node" "$A/sys" "$A/bin"',
		'for deb in /in/tools/*.deb; do dpkg-deb -x "$deb" "$B/tools"; done',
		'T="$B/tools"',
		'tools() { LD_LIBRARY_PATH="$T/usr/lib/x86_64-linux-gnu:$T/lib/x86_64-linux-gnu" "$@"; }',
		'tools "$T/usr/bin/fsck.erofs" --extract="$R" /in/base.erofs',
		'tar -xzf /in/node.tar.gz --strip-components=1 -C "$A/node"',
		'for deb in /in/sys/*.deb; do dpkg-deb -x "$deb" "$A/sys"; done',
		`export PATH="$A/bin:$A/node/bin:$A/sys/usr/bin:$PATH"`,
		'export LD_LIBRARY_PATH="$A/sys/usr/lib/x86_64-linux-gnu:$A/sys/lib/x86_64-linux-gnu"',
		'export GIT_EXEC_PATH="$A/sys/usr/lib/git-core"',
		// Node carries Mozilla's roots; git, curl and the agent's own tools read them from this file.
		`node -e 'require("fs").writeFileSync(process.argv[1], require("tls").rootCertificates.join("\\n") + "\\n")' "$A/ca-certificates.crt"`,
		'export SSL_CERT_FILE="$A/ca-certificates.crt" GIT_SSL_CAINFO="$A/ca-certificates.crt"',
		`export npm_config_prefix="$A" npm_config_cache="$B/npm-cache" HOME="$B/home"`,
		'mkdir -p "$HOME"',
		...recipe.install,
		"git --version",
		`echo "agent:x:${user.uid}:${user.gid}:Chopin agent:/home/agent:/bin/sh" >> "$R/etc/passwd"`,
		`grep -q ":${user.gid}:" "$R/etc/group" || echo "agent:x:${user.gid}:" >> "$R/etc/group"`,
		'mkdir -p "$R/home/agent"',
		// Where the guest clones its repositories (`/work`): anyone may make a folder there.
		'mkdir -p "$R/work" && chmod 1777 "$R/work"',
		// The guest's git takes the repositories it is given, whoever the host says owns them, for
		// every git it runs, receive-pack included, which drops settings from the environment.
		'printf "[safe]\\n\\tdirectory = *\\n" >> "$R/etc/gitconfig"',
		`tools "$T/usr/bin/mkfs.erofs" -zlz4hc -U ${uuid} --all-root /out/image.erofs "$R"`,
	].join("\n");
}

/** Runs one microVM to its end; resolves with its exit code and what it printed. */
export type VmRunner = (spec: VmSpec) => Promise<{ code: number | null; output: string }>;

/** Fetches `url` to `path`; resolves once it is there whole. */
export type Downloader = (url: string, path: string) => Promise<void>;

async function sha256(path: string) {
	return createHash("sha256").update(await readFile(path)).digest("hex");
}

/** `<base>/images/cache/<sha256>`, fetched once and checked. */
async function cached(base: string, url: string, digest: string, download: Downloader) {
	let folder = join(base, "images", "cache");
	await mkdir(folder, { recursive: true, mode: 0o700 });
	let path = join(folder, digest);
	if (await stat(path).then(() => true, () => false) && await sha256(path) === digest) return path;
	let partial = `${path}.${randomBytes(4).toString("hex")}.part`;
	try {
		await download(url, partial);
		let got = await sha256(partial);
		if (got !== digest) throw new Error(`${url} isn't what chopin pins: its SHA-256 is ${got}.`);
		await rename(partial, path);
	} finally {
		await rm(partial, { force: true });
	}
	return path;
}

async function fetched(
	base: string,
	folder: string,
	items: readonly GuestPackage[],
	download: Downloader,
) {
	await mkdir(folder, { recursive: true });
	for (let item of items) {
		let path = await cached(base, UBUNTU_ARCHIVE + item.path, item.sha256, download);
		await copyFile(path, join(folder, `${item.name}.deb`));
	}
}

/** What a build recorded of the image `<base>/images/<key>`: it, and the programs found in it. */
type Recorded = { image: AgentImage; programs: string[]; record: Record<string, unknown> };

/** The file of the layer a record names: its own, or `<key>.erofs` for one from before. */
function layerName(key: string, record: { layer?: unknown }) {
	return typeof record.layer === "string" ? basename(record.layer) : `${key}.erofs`;
}

/** Writes `<key>.json` whole: a chopin reads the record before it or after it, never half. */
async function writeRecord(images: string, key: string, record: Record<string, unknown>) {
	let temporary = join(images, `${key}.json-${process.pid}-${randomBytes(4).toString("hex")}`);
	await writeFile(temporary, JSON.stringify(record));
	await rename(temporary, join(images, `${key}.json`));
}

/** The image `<base>/images/<key>`, as its build recorded it. */
function recorded(base: string, key: string): Recorded | undefined {
	try {
		let record = JSON.parse(readFileSync(join(base, "images", `${key}.json`), "utf8")) as {
			uuid?: unknown;
			user?: GuestUser;
			layer?: unknown;
			programs?: unknown;
			recipe?: { programs?: unknown };
		};
		if (typeof record.uuid !== "string" || !record.user) return undefined;
		let layer = join(base, "images", layerName(key, record));
		statSync(layer);
		// A record from before images were shared names the programs of its one recipe.
		let programs = record.programs ?? record.recipe?.programs;
		return {
			image: {
				layer: { path: layer, uuid: record.uuid },
				user: `${record.user.uid}:${record.user.gid}`,
				...imageEnvironment(),
			},
			programs: Array.isArray(programs) ? programs.filter(item => typeof item === "string") : [],
			record,
		};
	} catch {
		return undefined;
	}
}

/** What makes images and finds programs in them: microVMs (`vmBuilder`), or a stand-in in tests. */
export type ImageBuilder = {
	/**
	 * Makes `recipe`'s image at `job.layer`, its root file system's UUID `job.uuid`, from the folder
	 * `recipe.from` holding what `job.inputs` digests; it leaves nothing at `job.layer` if it fails.
	 */
	build(
		recipe: ImageRecipe,
		job: { key: string; layer: string; uuid: string; inputs?: string; name: string },
	): Promise<void>;
	/** Which of `programs` a microVM of `image` doesn't find; throws when it can't start one. */
	missing(image: AgentImage, programs: string[]): Promise<string[]>;
};

/** "atomic-acp's image", or "the image atomic-acp and my-planner share". */
export function imageName(recipes: ImageRecipe[]) {
	let names = [...new Set(recipes.map(item => item.name))];
	return names.length === 1
		? `${names[0]}'s image`
		: `the image ${names.slice(0, -1).join(", ")} and ${names.at(-1)} share`;
}

function sentence(text: string) {
	return text.charAt(0).toUpperCase() + text.slice(1);
}

export type ImagesOptions = {
	/** The connector's state directory. */
	base: string;
	/** The UUID of the release's Ubuntu layer, which every image is made from: part of each key. */
	layer: string;
	user: GuestUser;
	builder: ImageBuilder;
	/** Hears that an image is being built, which takes minutes: the recipes it is for. */
	building?: (recipes: ImageRecipe[]) => void;
	/** Hears that another chopin on this base dir is building or checking one, and waits for it. */
	waiting?: (recipes: ImageRecipe[]) => void;
	/** How a lock's process is read, to tell a lock a chopin that died left (`processStart`). */
	probe?: StartProbe;
};

/** The images a machine's launches run from (see `imageStore`). */
export type ImageStore = {
	/** Every image, made where it isn't, by program; fails with the words of a build that failed. */
	ready(): Promise<Map<string, AgentImage>>;
	/** Whether a launch of `program` has an image here. */
	has(program: string): boolean;
	/** `program`'s image as it is on disk now, checked for its programs, or undefined if it isn't. */
	found(program: string): AgentImage | undefined;
	/**
	 * `program`'s image: found, or made. Every caller that asks for an image while it is being made
	 * waits on that one build, and a build that fails fails them all with its words.
	 */
	image(program: string): Promise<AgentImage>;
	/** The images' keys, which pruning keeps. */
	keys(): string[];
};

/**
 * The image each program of `recipes` runs from: one per key, so recipes with the same install (an
 * agent and a Planner command installed by the same commands) share one, built once and checked for
 * all their programs. An image is found where it was built before, and checked for any program it
 * wasn't checked for then; otherwise it is built, in a microVM, into `<base>/images/<key>.<uuid>.erofs`,
 * which its record `<key>.json` names.
 * One build of a key runs at a time: in this process every caller shares the one under way, and
 * across the chopins on a base dir one holds `<key>.lock` while another waits for it and finds the
 * image made.
 */
export async function imageStore(
	recipes: Map<string, ImageRecipe>,
	options: ImagesOptions,
): Promise<ImageStore> {
	let groups = new Map<string, { recipes: ImageRecipe[]; programs: string[]; inputs?: string }>();
	for (let [program, recipe] of recipes) {
		let inputs = recipe.from === undefined
			? undefined
			: await installInputs(recipe.from).catch(error => {
				throw new Error(
					`Couldn't read ${recipe.from}, the folder --install-from names for ${recipe.name}'s image: ${
						error instanceof Error ? error.message : String(error)
					}`,
				);
			});
		let key = imageKey(recipe, options.layer, options.user, inputs);
		let group = groups.get(key) ?? { recipes: [], programs: [], ...inputs ? { inputs } : {} };
		group.recipes.push(recipe);
		group.programs.push(program);
		groups.set(key, group);
	}
	let keyOf = new Map(
		[...groups].flatMap(([key, group]) => group.programs.map(program => [program, key] as const)),
	);
	/** The build of each key under way in this process, which every caller meanwhile waits on. */
	let flights = new Map<string, Promise<AgentImage>>();
	let made = (key: string) => {
		let flight = flights.get(key);
		if (!flight) {
			let group = groups.get(key)!;
			flight = ensureImage(key, group.recipes, group.inputs, options).finally(() =>
				flights.delete(key)
			);
			flights.set(key, flight);
		}
		return flight;
	};
	let found = (program: string) => {
		let key = keyOf.get(program);
		if (key === undefined || flights.has(key)) return undefined;
		let image = recorded(options.base, key);
		let wanted = groups.get(key)!.recipes.flatMap(recipe => recipe.programs);
		return image && wanted.every(item => image.programs.includes(item)) ? image.image : undefined;
	};
	return {
		async ready() {
			let images = new Map<string, AgentImage>();
			for (let [key, group] of groups) {
				let image = await made(key);
				for (let program of group.programs) images.set(program, image);
			}
			return images;
		},
		has: program => keyOf.has(program),
		found,
		async image(program) {
			let key = keyOf.get(program);
			if (key === undefined) throw new Error(`No recipe makes an image with ${program}.`);
			return found(program) ?? await made(key);
		},
		keys: () => [...groups.keys()],
	};
}

/** Every image `recipes` need, made where it isn't, by program (see `imageStore`). */
export async function ensureImages(
	recipes: Map<string, ImageRecipe>,
	options: ImagesOptions,
): Promise<Map<string, AgentImage>> {
	return (await imageStore(recipes, options)).ready();
}

async function ensureImage(
	key: string,
	recipes: ImageRecipe[],
	inputs: string | undefined,
	options: ImagesOptions,
): Promise<AgentImage> {
	let programs = [...new Set(recipes.flatMap(recipe => recipe.programs))];
	let name = imageName(recipes);
	let images = join(options.base, "images");
	await mkdir(images, { recursive: true, mode: 0o700 });
	let release = await lockImage(
		join(images, `${key}.lock`),
		() => options.waiting?.(recipes),
		options.probe ?? processStart(),
	);
	try {
		let found = recorded(options.base, key);
		if (found) {
			let unchecked = programs.filter(program => !found.programs.includes(program));
			if (!unchecked.length) return found.image;
			let missing = await options.builder.missing(found.image, unchecked);
			if (missing.length) {
				throw new Error(
					`${sentence(name)} has no ${missing.join(" or ")}: check its install commands.`,
				);
			}
			await writeRecord(images, key, {
				...found.record,
				programs: [...found.programs, ...unchecked],
			});
			return found.image;
		}
		options.building?.(recipes);
		let uuid = randomUUID();
		// A layer of its own name, which its record names: no other build's layer is ever under it.
		let layer = join(images, `${key}.${uuid}.erofs`);
		await options.builder.build(recipes[0]!, {
			key,
			layer,
			uuid,
			name,
			...inputs ? { inputs } : {},
		});
		let image: AgentImage = {
			layer: { path: layer, uuid },
			user: `${options.user.uid}:${options.user.gid}`,
			...imageEnvironment(),
		};
		let missing = await options.builder.missing(image, programs).catch(async error => {
			await rm(layer, { force: true });
			throw error;
		});
		if (missing.length) {
			await rm(layer, { force: true });
			throw new Error(
				`${sentence(name)} was built, but has no ${
					missing.join(" or ")
				}: check its install commands.`,
			);
		}
		await writeRecord(images, key, {
			key,
			uuid,
			layer: basename(layer),
			recipes,
			programs,
			user: options.user,
			node: NODE_RELEASE.version,
			nvx: NVX_RELEASE.version,
		});
		return image;
	} finally {
		await release();
	}
}

/** Whether the lock `text` was written by a process that is gone, or whose number another has. */
async function abandoned(text: string | undefined, probe: StartProbe) {
	let held: Record<string, unknown>;
	try {
		held = JSON.parse(text ?? "");
	} catch {
		return false;
	}
	return Number.isSafeInteger(held?.pid) && (held.pid as number) > 0 && !await holds(held, probe);
}

function read(path: string) {
	return readFile(path, "utf8").catch(() => undefined);
}

/**
 * Takes the lock at `path` for this process, waiting while another chopin holds it (`waiting` hears
 * that once) and taking over one whose process is gone, or whose number a process started since
 * has. The lock is made whole, its holder in it, by linking a file already written, so no chopin
 * ever reads it half made. A lock is taken over only under `<path>.takeover`, and only while it is
 * still the one found abandoned: two chopins that found it so never both take it, nor one take a
 * lock another took meanwhile. Letting go removes the lock only while it is this one's.
 */
async function lockImage(path: string, waiting: () => void, probe: StartProbe) {
	let holder = `${path}-${process.pid}-${randomBytes(4).toString("hex")}`;
	let mine = JSON.stringify({ pid: process.pid, started: Date.now() });
	await writeFile(holder, mine, { mode: 0o600 });
	let said = false;
	let take = async (seen: string) => {
		let guard = `${path}.takeover`;
		try {
			await link(holder, guard);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			// Another is taking it over; one that died in its few steps doing so leaves its guard.
			let left = await read(guard);
			if (await abandoned(left, probe) && await read(guard) === left) {
				await rm(guard, { force: true });
			}
			return false;
		}
		try {
			if (await read(path) === seen) await rm(path, { force: true });
		} finally {
			await rm(guard, { force: true });
		}
		return true;
	};
	try {
		for (let wait = 50;; wait = Math.min(wait * 2, 1000)) {
			try {
				await link(holder, path);
				return async () => {
					if (await read(path) === mine) await rm(path, { force: true });
				};
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			}
			let seen = await read(path);
			if (seen !== undefined && await abandoned(seen, probe) && await take(seen)) continue;
			if (!said) {
				said = true;
				waiting();
			}
			await Bun.sleep(wait);
		}
	} finally {
		await rm(holder, { force: true });
	}
}

/**
 * Makes images in microVMs: the image `recipe` makes, as a layer of its own. An agent's runtime is
 * in its layer, not a share: Node reads tens of thousands of files as it starts, which a share
 * would answer one host request at a time. The host downloads Node and the packages, checks them,
 * and shares them with the build's guest, which unpacks them over the release's layer, runs the
 * install (npm's install scripts included, no closer to the host than the agent will run) and
 * writes the new layer. A recipe's `from` folder is copied and shared with the build alone,
 * read-only, so an install can use files the host fetched with credentials no guest gets. A microVM
 * of the image is started to find programs.
 */
export function vmBuilder(options: {
	/** The connector's state directory. */
	base: string;
	/** The release's Ubuntu layer, which every image is made from. */
	layer: { path: string; uuid: string };
	user: GuestUser;
	run: VmRunner;
	download: Downloader;
	/** The guest's proxy port, for the build's npm. */
	proxyPort: number;
}): ImageBuilder {
	return {
		async build(recipe, job) {
			let building = join(
				options.base,
				"images",
				`${job.key}.building-${randomBytes(4).toString("hex")}`,
			);
			let inputs = join(building, "in");
			let output = join(building, "out");
			await mkdir(inputs, { recursive: true });
			await mkdir(output, { recursive: true });
			// The build's guest is the layer's `nobody`, which owns nothing shared: it may write here
			// alone.
			if (process.platform !== "win32") await chmod(output, 0o777);
			try {
				let node = await cached(
					options.base,
					`https://nodejs.org/dist/v${NODE_RELEASE.version}/${NODE_RELEASE.file}`,
					NODE_RELEASE.sha256,
					options.download,
				);
				await copyFile(node, join(inputs, "node.tar.gz"));
				await copyFile(options.layer.path, join(inputs, "base.erofs"));
				await fetched(options.base, join(inputs, "sys"), GUEST_PACKAGES, options.download);
				await fetched(options.base, join(inputs, "tools"), BUILD_PACKAGES, options.download);
				await writeFile(join(inputs, "build.sh"), buildScript(recipe, options.user, job.uuid));
				let shares: VmSpec["shares"] = [
					{ host: inputs, guest: "/in", mode: "ro" },
					{ host: output, guest: "/out", mode: "rw" },
				];
				if (recipe.from !== undefined) {
					// A copy, so the build reads what the key was made of, whatever happens to the
					// folder.
					let copy = join(building, "from");
					await mkdir(copy);
					if (process.platform !== "win32") await chmod(copy, 0o755);
					let copied = await installInputs(recipe.from, copy).catch(error => {
						throw new Error(
							`Couldn't read ${recipe.from}, the folder --install-from names for ${job.name}: ${
								error instanceof Error ? error.message : String(error)
							}`,
						);
					});
					if (copied !== job.inputs) {
						throw new Error(
							`${recipe.from} changed while chopin copied it for ${job.name}. Run this command again once it is done changing.`,
						);
					}
					shares.push({ host: copy, guest: INSTALL_FROM, mode: "ro" });
				}
				let proxy = `http://10.0.0.1:${options.proxyPort}`;
				let result = await options.run({
					shares,
					proxyPort: options.proxyPort,
					environment: {
						PATH: "/usr/sbin:/usr/bin:/sbin:/bin",
						HOME: "/tmp",
						TMPDIR: "/tmp",
						HTTPS_PROXY: proxy,
						HTTP_PROXY: proxy,
						https_proxy: proxy,
						http_proxy: proxy,
						NO_PROXY: "",
						NODE_USE_ENV_PROXY: "1",
						npm_config_update_notifier: "false",
						npm_config_fund: "false",
						npm_config_audit: "false",
					},
					command: ["/bin/sh", "/in/build.sh"],
					cwd: "/tmp",
					memoryMib: 4096,
					ramUpperPercent: 85,
					processors: 1,
					hostname: "chopin-image",
				});
				let layer = join(output, "image.erofs");
				if (result.code !== 0 || !await stat(layer).then(() => true, () => false)) {
					throw new Error(
						`Couldn't build ${job.name} (exit ${result.code}):\n${
							result.output.trim().split("\n").slice(-12).join("\n")
						}`,
					);
				}
				await rename(layer, job.layer);
			} finally {
				await rm(building, { recursive: true, force: true });
			}
		},
		async missing(image, programs) {
			let check = await options.run({
				shares: [],
				proxyPort: options.proxyPort,
				environment: {
					...image.environment,
					PATH: [...image.path, "/usr/sbin", "/usr/bin", "/sbin", "/bin"].join(":"),
					HOME: "/tmp",
				},
				command: [
					"/bin/sh",
					"-c",
					'for program in "$@"; do command -v "$program" >/dev/null || echo "chopin-missing: $program"; done',
					"chopin-check",
					...programs,
				],
				cwd: "/tmp",
				memoryMib: 1024,
				processors: 1,
				hostname: "chopin-image",
				image,
			});
			if (check.code !== 0) {
				throw new Error(
					`Couldn't start a microVM of the image to find ${
						programs.join(" and ")
					} in it (exit ${check.code}):\n${check.output.trim().split("\n").slice(-12).join("\n")}`,
				);
			}
			let missing = new Set(
				check.output.split("\n").filter(line => line.startsWith("chopin-missing: ")).map(line =>
					line.slice("chopin-missing: ".length).trim()
				),
			);
			return programs.filter(program => missing.has(program));
		},
	};
}

/**
 * Removes images and unfinished builds that no recipe's key in `keep` names, and of those it does,
 * every layer but the one its record names and every build left unfinished. It leaves alone a key
 * another chopin holds the lock of now: an image it is building or checking, beside this one.
 */
export async function pruneImages(
	base: string,
	keep: readonly string[],
	probe: StartProbe = processStart(),
) {
	let folder = join(base, "images");
	let names: string[];
	try {
		names = await readdir(folder);
	} catch {
		return;
	}
	let held = new Set<string>();
	for (let name of names) {
		if (name.endsWith(".lock") && !await staleLock(join(folder, name), probe)) {
			held.add(name.slice(0, -".lock".length));
		}
	}
	let kept = new Set<string>();
	for (let key of keep) {
		let record = await read(join(folder, `${key}.json`));
		kept.add(`${key}.json`);
		try {
			kept.add(layerName(key, JSON.parse(record ?? "")));
		} catch { /* No record: nothing of it is kept. */ }
	}
	for (let name of names) {
		let key = name.split(".")[0]!;
		if (name === "cache" || kept.has(name) || held.has(key)) continue;
		// A lock or a record being written: its holder's file, renamed or linked a moment later.
		if (name.includes(".lock-") || name.includes(".json-")) {
			let made = await stat(join(folder, name)).then(info => info.mtimeMs, () => 0);
			if (Date.now() - made < 60_000) continue;
		}
		// A layer a microVM of another chopin still runs may not go yet on Windows: it goes later.
		await rm(join(folder, name), { recursive: true, force: true }).catch(() => {});
	}
}
