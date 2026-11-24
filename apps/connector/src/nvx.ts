import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { join, posix, win32 } from "node:path";

/**
 * The NVX release this connector runs every agent in: its version and, for each host, the package
 * downloaded from NVX's own GitHub release, with its SHA-256. NVX publishes development releases
 * only, several a day, so the pin moves only with a `chopin` release that was tested on it.
 */
export const NVX_RELEASE = {
	version: "0.1.0-dev.30bf7f09e59a",
	tag: "v0.1.0-dev.30bf7f09e59a",
	packages: {
		"linux-kvm": {
			file: "nvx-0.1.0-linux-kvm.tar.gz",
			sha256: "64d7372790ee53cde628e7c6f76afba737b4cef7f7308582ae9864184afab145",
		},
		"linux-mshv": {
			file: "nvx-0.1.0-linux-mshv.tar.gz",
			sha256: "72d026350aedcc195e3a82ccaa7efeb822d335fd6a4a55df7ecf4fc98d8902ed",
		},
		"windows-whp": {
			file: "nvx-0.1.0-windows-whp.zip",
			sha256: "45347c1c95256939c2ab798178fb9ac3628c9f5b976d65e646d8113c573f8e32",
		},
	},
} as const;

export type NvxPackage = keyof typeof NVX_RELEASE.packages;
export type Hypervisor = "kvm" | "mshv" | "whp";

/** What every refusal of a machine that can't run NVX starts with. */
export const UNSUPPORTED_LEAD = "This machine can't run Chopin's work: Chopin runs each agent in "
	+ "its own microVM, which needs Linux or Windows on x86_64 with hardware virtualization.";

/** Whether this machine can run NVX, and if not why, with the one fix where there is one. */
export type NvxSupport =
	| { supported: true; hypervisor: Hypervisor; package: NvxPackage }
	| { supported: false; reason: string; fix?: string };

/** What the support check reads of the machine; tests give it a made-up one. */
export type SupportHost = {
	platform: NodeJS.Platform;
	arch: string;
	/** The user it runs as; a root one can't be a microVM's workload user. */
	uid?: number;
	/** Windows' own folder (`%SystemRoot%`), where the Windows Hypervisor Platform's library is. */
	systemRoot?: string;
	exists(path: string): boolean;
	/** Whether this process may read and write the device at `path`. */
	readWrite(path: string): boolean;
	/**
	 * Whether the user is in the group that owns the device at `path`, as the system's group
	 * database has it now, though this process doesn't hold that group: whatever started it (a login,
	 * or the systemd user manager that runs the chopin service) began before the user joined it.
	 */
	joinedLater?(path: string): boolean;
};

/** The words for a machine that can't run NVX, as `chopin pair`, `connect` and status say them. */
export function unsupportedWords(support: Extract<NvxSupport, { supported: false }>): string[] {
	return [`${UNSUPPORTED_LEAD} ${support.reason}`, ...support.fix ? [`Fix: ${support.fix}`] : []];
}

/**
 * Whether NVX can run here, from the platform and the hypervisor's device. A Linux machine needs
 * read and write access to `/dev/kvm` (or `/dev/mshv`, under the Microsoft Hypervisor); Windows
 * needs the Windows Hypervisor Platform, which only a VM's start shows, so a Windows machine on
 * x86_64 passes here and is checked by starting one (see `NvxSandbox`).
 */
export function nvxSupport(host: SupportHost): NvxSupport {
	if (host.platform === "darwin") {
		return {
			supported: false,
			reason: "macOS has no hypervisor NVX can use, so a Mac can't be one of Chopin's machines.",
		};
	}
	if (host.platform !== "linux" && host.platform !== "win32") {
		return { supported: false, reason: `NVX doesn't run on ${host.platform}.` };
	}
	if (host.arch !== "x64") {
		return {
			supported: false,
			reason: `NVX boots x86_64 guests only, and this machine is ${host.arch}.`,
		};
	}
	if (host.platform === "win32") {
		// The library is there only with the Windows Hypervisor Platform turned on.
		let library = `${host.systemRoot ?? "C:\\Windows"}\\System32\\WinHvPlatform.dll`;
		if (!host.exists(library)) {
			return {
				supported: false,
				reason: "The Windows Hypervisor Platform is off.",
				fix: "In an administrator PowerShell: Enable-WindowsOptionalFeature -Online -FeatureName "
					+ "HypervisorPlatform -All, then restart",
			};
		}
		return { supported: true, hypervisor: "whp", package: "windows-whp" };
	}
	if (host.uid === 0) {
		return {
			supported: false,
			reason: "chopin runs as root here, and a microVM's agent can't run as root.",
			fix: "Run chopin as your own user",
		};
	}
	let device: Extract<NvxSupport, { supported: true }> | undefined;
	if (host.exists("/dev/kvm") && host.readWrite("/dev/kvm")) {
		device = { supported: true, hypervisor: "kvm", package: "linux-kvm" };
	} else if (host.exists("/dev/mshv") && host.readWrite("/dev/mshv")) {
		device = { supported: true, hypervisor: "mshv", package: "linux-mshv" };
	}
	if (device) return device;
	if (host.exists("/dev/kvm")) return deviceDenied("/dev/kvm", host);
	if (host.exists("/dev/mshv")) return deviceDenied("/dev/mshv", host);
	return {
		supported: false,
		reason: "It has no /dev/kvm: hardware virtualization is off or unavailable. On a cloud VM, "
			+ "choose a size with nested virtualization; on your own computer, turn on VT-x or AMD-V "
			+ "in its firmware.",
	};
}

/** The hypervisors' devices on Linux. */
export type HypervisorDevice = "/dev/kvm" | "/dev/mshv";

/**
 * What an administrator can do instead of a group for a user's /dev/kvm: grant it with a udev rule.
 * Never `systemctl restart user@…`, which would end every session and service of the user's.
 */
const UDEV_RULE = 'Or have an administrator add a udev rule, such as KERNEL=="kvm", GROUP="kvm", '
	+ 'MODE="0660", RUN+="/usr/bin/setfacl -m u:<user>:rw /dev/kvm" (logind may drop that ACL)';

/**
 * Why a Linux user can't use the hypervisor's `device`, which is there, with the fix: join the kvm
 * group, or, for one who has since chopin's login began, start that login again (for the service,
 * whose systemd user manager a logout leaves running, the machine), or have it granted.
 */
export function deviceDenied(
	device: HypervisorDevice,
	host: Pick<SupportHost, "joinedLater">,
): Extract<NvxSupport, { supported: false }> {
	if (device === "/dev/mshv") {
		return {
			supported: false,
			reason: "Your user can't read and write /dev/mshv.",
			fix: "Give your user read and write access to /dev/mshv, then connect again.",
		};
	}
	if (host.joinedLater?.(device)) {
		return {
			supported: false,
			reason: "Your user is in the kvm group, but chopin runs in a login that began before you "
				+ "joined it, so it can't read and write /dev/kvm yet.",
			fix: `Log out and back in (for the chopin service, restart the machine). ${UDEV_RULE}`,
		};
	}
	return {
		supported: false,
		reason: "Your user can't read and write /dev/kvm.",
		fix: "sudo usermod -aG kvm $USER, then log out and back in (for the chopin service, restart "
			+ `the machine). ${UDEV_RULE}`,
	};
}

/** NVX as installed: its command and the Ubuntu layer its guests boot. */
export type NvxArtifacts = {
	root: string;
	nvx: string;
	layer: { path: string; uuid: string };
};

/**
 * The NVX package extracted at `root`, as its release lays it out: `bin/nvx` and the Ubuntu
 * distro layer with its manifest, which names the layer's UUID. Undefined when any is missing.
 */
export function artifactsAt(root: string, platform: NodeJS.Platform): NvxArtifacts | undefined {
	let nvx = join(root, "bin", platform === "win32" ? "nvx.exe" : "nvx");
	let layer = join(root, "guest", "ubuntu-distro.erofs");
	let manifest = `${layer}.manifest.json`;
	if (!existsSync(nvx) || !existsSync(layer) || !existsSync(manifest)) return undefined;
	let uuid: unknown;
	try {
		uuid = (JSON.parse(readFileSync(manifest, "utf8")) as { uuid?: unknown }).uuid;
	} catch {
		return undefined;
	}
	if (typeof uuid !== "string" || !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(uuid)) {
		return undefined;
	}
	return { root, nvx, layer: { path: layer, uuid } };
}

/** Where the pinned NVX release is extracted in the connector's state directory. */
export function nvxDirectory(base: string) {
	return join(base, "nvx", NVX_RELEASE.version);
}

/** Where the pinned package is downloaded from: Chopin's release copy, else NVX's own release. */
export function packageUrls(name: NvxPackage): string[] {
	let file = NVX_RELEASE.packages[name].file;
	return [
		`https://github.com/microsoft/nvx/releases/download/${NVX_RELEASE.tag}/${file}`,
	];
}

/** Lines of a package's `SHA256SUMS` that its files don't match, as `<file>: <why>`. */
export function checkSums(root: string): string[] {
	let sums: string;
	try {
		sums = readFileSync(join(root, "SHA256SUMS"), "utf8");
	} catch {
		return ["SHA256SUMS: missing"];
	}
	let problems: string[] = [];
	for (let line of sums.split("\n")) {
		let match = /^([0-9a-f]{64})\s+\*?(.+)$/.exec(line.trim());
		if (!match) continue;
		let [, digest, file] = match as unknown as [string, string, string];
		let path = join(root, ...file.split("/"));
		let actual: string;
		try {
			actual = createHash("sha256").update(readFileSync(path)).digest("hex");
		} catch {
			problems.push(`${file}: missing`);
			continue;
		}
		if (actual !== digest) problems.push(`${file}: differs`);
	}
	return problems;
}

/** Releases of NVX in `<base>/nvx` other than the pinned one, which a connector removes. */
export function staleReleases(base: string): string[] {
	let parent = join(base, "nvx");
	let names: string[];
	try {
		names = readdirSync(parent);
	} catch {
		return [];
	}
	return names
		.filter(name => /^\d+\.\d+\.\d+/.test(name) && name !== NVX_RELEASE.version)
		.map(name => join(parent, name));
}

/** Removes the NVX releases the connector no longer pins. */
export function removeStaleReleases(base: string) {
	for (let path of staleReleases(base)) rmSync(path, { recursive: true, force: true });
}

/** A host path the guest sees, at the guest path. */
export type Share = {
	host: string;
	guest: string;
	mode: "ro" | "rw";
	/** On an `rw` share, its only writable parts, as host paths inside it. */
	writable?: string[];
	/** Host paths inside the share that the guest can't see. */
	denied?: string[];
};

/** Where an image's agent, Node and git are in its guests. */
export const IMAGE_GUEST_PATH = "/opt/chopin/agent";

/** An agent's image: the layer its guests boot, with its runtime in it (see `images.ts`). */
export type AgentImage = {
	layer: { path: string; uuid: string };
	/** The guest's user, `uid:gid`: the connector's own, which the layer has an account for. */
	user: string;
	/** Guest directories put first on the agent's PATH. */
	path: string[];
	/** What the image's tools need in the guest's environment (git's and the CA bundle's paths). */
	environment: Record<string, string>;
};

/** The guest's own PATH, after the image's directories. */
const GUEST_PATH = ["/usr/local/sbin", "/usr/local/bin", "/usr/sbin", "/usr/bin", "/sbin", "/bin"];

/** The variables only Windows sets, upper-cased: they name nothing a Linux guest has. */
const WINDOWS_ONLY = new Set([
	"ALLUSERSPROFILE",
	"APPDATA",
	"COMMONPROGRAMFILES",
	"COMMONPROGRAMFILES(ARM)",
	"COMMONPROGRAMFILES(X86)",
	"COMMONPROGRAMW6432",
	"COMPUTERNAME",
	"COMSPEC",
	"DRIVERDATA",
	"HOMEDRIVE",
	"HOMEPATH",
	"LOCALAPPDATA",
	"LOGONSERVER",
	"NUMBER_OF_PROCESSORS",
	"NVM_HOME",
	"NVM_SYMLINK",
	"ONEDRIVE",
	"ONEDRIVECOMMERCIAL",
	"ONEDRIVECONSUMER",
	"OS",
	"PATHEXT",
	"PROCESSOR_ARCHITECTURE",
	"PROCESSOR_IDENTIFIER",
	"PROCESSOR_LEVEL",
	"PROCESSOR_REVISION",
	"PROGRAMDATA",
	"PROGRAMFILES",
	"PROGRAMFILES(ARM)",
	"PROGRAMFILES(X86)",
	"PROGRAMW6432",
	"PSMODULEPATH",
	"PUBLIC",
	"SESSIONNAME",
	"SYSTEMDRIVE",
	"SYSTEMROOT",
	"USERDOMAIN",
	"USERDOMAIN_ROAMINGPROFILE",
	"USERNAME",
	"USERPROFILE",
	"VCINSTALLDIR",
	"VSINSTALLDIR",
	"WINDIR",
]);

/**
 * Whether `name` is the host's alone, which a guest is never given: a variable only Windows sets,
 * in any case, and on a Windows host its PATH and SHELL, which name Windows programs. Each would
 * name the host user's profile to a guest that has none of it.
 */
function hostOnly(name: string, platform: NodeJS.Platform) {
	let upper = name.toUpperCase();
	return WINDOWS_ONLY.has(upper)
		|| platform === "win32" && (upper === "PATH" || upper === "SHELL");
}

/** What the guest of one launch is: its shares, network, environment and command. */
export type VmSpec = {
	/** The layer and user it boots; the release's own Ubuntu layer and `nobody` without one. */
	image?: AgentImage;
	shares: Share[];
	/** The port of the connector's allow-list proxy on host loopback: the guest's only way out. */
	proxyPort: number;
	environment: Record<string, string>;
	command: string[];
	cwd: string;
	memoryMib: number;
	/** The share of its memory its writable root may take, in percent (NVX's default is 50). */
	ramUpperPercent?: number;
	/** The scratch disk its writable root is on, instead of its memory. */
	disk?: string;
	processors: 1 | 2 | 4 | 8;
	hostname: string;
};

/** What a launch's guest is built from besides the launch itself. */
export type VmContext = {
	platform: NodeJS.Platform;
	/** The connector's state directory: the only place a guest may write, but what the owner adds. */
	base: string;
	image: AgentImage;
	proxyPort: number;
	/** Directories the owner lets agents write as well (`--sandbox-write`). */
	writable?: readonly string[];
	/** Paths the owner hides from agents, inside whatever share holds them (`--sandbox-hide`). */
	hidden?: readonly string[];
	/** Single host files every guest reads at a guest path of their own (the MCP bridge). */
	files?: ReadonlyArray<{ host: string; guest: string }>;
	memoryMib?: number;
	processors?: 1 | 2 | 4 | 8;
	/** Real paths; the file system's by default. */
	real?: (path: string) => string;
};

/** What a launch asks of its guest (the fields of `Launch` the spec reads). */
export type VmLaunch = {
	command: string[];
	/**
	 * Where the agent works. With `repository`, the guest path of that repository; otherwise a host
	 * folder the guest reads, as a start check's empty one.
	 */
	cwd: string;
	env: Record<string, string | undefined>;
	/** Host folders in the connector's state directory it writes. */
	writable?: string[];
	/** Its own host folders in the state directory: its token folder and agent state. It reads them. */
	own?: string[];
	agentHome?: string;
	/** Host folders it only reads: a Planner's checkout, the person's, with its uncommitted files. */
	reads?: string[];
	/** The repository the guest clones and works in, from a git directory it reads. */
	repository?: GuestRepository;
	/** The scratch disk its writable root is on, which lasts beyond it (a Planner's); else memory. */
	disk?: string;
};

/**
 * A repository the guest makes of its own, in its own disk or memory: a clone of a host git
 * directory, shared read-only, which the guest's git reads through alternates and never writes.
 * The agent works in it at native speed (a shared folder's every file operation is a host round
 * trip) and pushes to GitHub as it did; the host runs no git in what the agent wrote.
 */
export type GuestRepository = {
	/** The host git directory it is cloned from: a checkout's `.git`, or one of the connector's clones. */
	source: string;
	/** The clone's path in the guest. */
	path: string;
	/** What a new clone checks out, detached: the source's HEAD unless said. */
	commit?: string;
	/** A branch made at `commit` for the work. */
	branch?: string;
	/** The clone's `origin`, its GitHub repository's HTTPS URL. */
	origin?: string;
	/**
	 * Copy the objects it needs (`--reference --dissociate`), for a clone that outlives the person's
	 * repository's garbage collection (a Planner's), instead of reading them where they are.
	 */
	dissociate?: boolean;
};

/** Where a guest's repositories are, on its own disk or in its memory. */
export const GUEST_WORK = "/work";

/** Where a guest clones `owner/name`: `<work>/<name>`, in `/work` unless a stand-in says. */
export function guestRepositoryPath(repository: string, work = GUEST_WORK) {
	let name = (repository.split("/").at(-1) ?? "repository").replace(/[^A-Za-z0-9._-]/g, "_");
	return posix.join(work, /^\.*$/.test(name) ? `_${name}` : name);
}

/**
 * What the guest runs before the agent: a clone of the repository where there is none, the commit
 * and branch checked out, then the agent, in it. Its parameters come in the environment
 * (`CHOPIN_GUEST_*`), and git's output goes to stderr, since the agent's stdout is its protocol.
 */
export const PREPARE = [
	'set -e; R="$CHOPIN_GUEST_REPOSITORY"; P="$R.part"',
	// Made whole or not at all: a clone cut short is made again at the next start.
	'if [ ! -d "$R/.git" ]; then rm -rf "$P"; mkdir -p "$(dirname "$R")"',
	' if [ -n "$CHOPIN_GUEST_DISSOCIATE" ]; then git clone -q --no-checkout --reference "$CHOPIN_GUEST_SOURCE" --dissociate "$CHOPIN_GUEST_SOURCE" "$P" >&2',
	' else git clone -q --no-checkout --shared "$CHOPIN_GUEST_SOURCE" "$P" >&2; fi',
	' [ -z "$CHOPIN_GUEST_ORIGIN" ] || git -C "$P" remote set-url origin "$CHOPIN_GUEST_ORIGIN"',
	' git -C "$P" checkout -q --detach "${CHOPIN_GUEST_COMMIT:-HEAD}" >&2',
	' mv "$P" "$R"',
	"fi",
	'[ -z "$CHOPIN_GUEST_BRANCH" ] || git -C "$R" checkout -q -B "$CHOPIN_GUEST_BRANCH" >&2',
	'cd "$R"; unset CHOPIN_GUEST_REPOSITORY CHOPIN_GUEST_SOURCE CHOPIN_GUEST_DISSOCIATE CHOPIN_GUEST_ORIGIN CHOPIN_GUEST_COMMIT CHOPIN_GUEST_BRANCH',
	'exec "$@"',
].join("\n");

/** A launch NVX can't be given as asked; nothing starts. */
export class SandboxRefused extends Error {
	override name = "SandboxRefused";
}

function realPath(path: string) {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

/** Whether `path` is `parent` or inside it, on `platform`'s terms. */
export function within(path: string, parent: string, platform: NodeJS.Platform) {
	let paths = platform === "win32" ? win32 : posix;
	let between = paths.relative(
		platform === "win32" ? parent.toLowerCase() : parent,
		platform === "win32" ? path.toLowerCase() : path,
	);
	return between === "" || !between.startsWith("..") && !paths.isAbsolute(between);
}

/**
 * The guest path of a host path. On Linux the guest sees each share where the host has it, so the
 * paths a launch's environment names and git's absolute pointers mean the same on both sides. On
 * Windows a drive's path is under `/mnt/<drive>`.
 */
export function guestPath(host: string, platform: NodeJS.Platform): string {
	if (platform !== "win32") return host;
	let match = /^([A-Za-z]):[\\/]?(.*)$/.exec(host);
	if (!match) {
		throw new SandboxRefused(`${host} isn't a path on a drive, which a guest can't be given.`);
	}
	let rest = match[2]!.split(/[\\/]+/).filter(Boolean);
	return posix.join("/mnt", match[1]!.toLowerCase(), ...rest);
}

/**
 * Guest paths no share may be at or under: NVX's own, where the guest clones its repositories, and
 * where its image has the agent and the bridge.
 */
const RESERVED = ["/etc", "/run", "/proc", "/sys", "/dev", "/.nvx-agent", "/work", "/opt/chopin"];

/**
 * Refuses a guest path NVX can't mount a share at: `/`, the guest's own trees, and names with
 * whitespace, quotes, backslashes, `=` or control characters.
 */
export function checkGuestPath(guest: string, host: string) {
	if (guest === "/" || RESERVED.some(reserved => within(guest, reserved, "linux"))) {
		throw new SandboxRefused(
			`Not run: ${host} is where the microVM keeps its own files, so it can't be shared with one.`,
		);
	}
	if (
		(/[\s"\\=\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/u.test(guest)
			|| [...guest].some(character => character < " " || character === "\u007f"))
	) {
		throw new SandboxRefused(
			`Not run: ${host} has a space, quote, backslash, = or control character in its path, which a microVM can't be given. Move it, or choose another --base-dir.`,
		);
	}
}

/**
 * Where the guest has the host path `value`: in the share that holds it, named as the launch named
 * it or as it really is. A path named through a link (`named`: as named, and where it really is),
 * as a base dir under a home folder whose `~/.local` is a link to another disk is, is where it really
 * is, which is all the guest has. Undefined for anything else: not a path, or none a share holds.
 */
function inGuest(
	value: string,
	shares: readonly Share[],
	named: ReadonlyMap<string, string>,
	platform: NodeJS.Platform,
): string | undefined {
	let paths = platform === "win32" ? win32 : posix;
	if (!paths.isAbsolute(value)) return undefined;
	// The innermost link it was named through, where there are several (a base dir and a folder in it).
	let link: [string, string] | undefined;
	for (let [given, found] of named) {
		if (within(value, given, platform) && given.length > (link?.[0].length ?? -1)) {
			link = [given, found];
		}
	}
	let host = link ? paths.join(link[1], paths.relative(link[0], value)) : value;
	// Shares never hold one another, so one holds it at most.
	let share = shares.find(share => within(host, share.host, platform));
	if (!share) return undefined;
	let rest = paths.relative(share.host, host).split(paths.sep).filter(Boolean);
	return posix.join(share.guest, ...rest);
}

/**
 * The guest of `launch`: exactly the shares it is allowed, the proxy as its only way out, and its
 * environment for the guest.
 *
 * It writes its working directory when the connector made it for the launch (`own`), the folders it
 * is given to write (`writable`, its agent state), and what the owner adds: nothing else, and none
 * of it outside the connector's state directory but what the owner adds. It reads the rest of what
 * it owns (its token folder), a working directory that isn't its own (a Planner's checkout, the
 * person's), what it reads (`reads`: the objects of the repository its own was cloned from) and the
 * agent's image. Shares never hold one another; a launch whose places would is refused, naming them.
 */
export function vmSpec(launch: VmLaunch, context: VmContext): VmSpec {
	let { platform } = context;
	let resolve = context.real ?? realPath;
	/** Each host path named through a link, and where it really is (see `inGuest`). */
	let named = new Map<string, string>();
	let real = (path: string) => {
		let found = resolve(path);
		if (found !== path) named.set(path, found);
		return found;
	};
	let base = real(context.base);
	let owned = new Set((launch.own ?? []).map(real));
	let repository = launch.repository;
	let cwd = repository ? undefined : real(launch.cwd);
	let writes = [
		...(launch.writable ?? []).map(real),
		...launch.agentHome ? [real(launch.agentHome)] : [],
	];
	let added = (context.writable ?? []).map(real);
	// The state directory holds NVX itself, the images, the bridge and every launch's files.
	for (let path of added) {
		if (within(path, base, platform)) {
			throw new SandboxRefused(
				`Not run: --sandbox-write can't name ${path}, which is inside chopin's state directory.`,
			);
		}
	}
	for (let path of writes) {
		if (!within(path, base, platform)) {
			throw new SandboxRefused(
				`Not run: ${path} is outside chopin's state directory, and a guest writes only what chopin made for it there.`,
			);
		}
	}
	let reads = [
		...[...owned].filter(path => !writes.includes(path)),
		...cwd ? [cwd] : [],
		...(launch.reads ?? []).map(real),
		// The git directory a guest repository is cloned from: read whole, never written.
		...repository ? [real(repository.source)] : [],
	];
	// Never written through a folder it writes: what it may only read (the person's checkout, the git
	// directory its repository is cloned from, its tokens, a working directory not its own) at or
	// inside a folder it writes is refused, as a share can't be read-only inside a writable one.
	let readOnly = [
		...(launch.reads ?? []).map(real),
		...repository ? [real(repository.source)] : [],
		...[...owned].filter(path => !writes.includes(path)),
		...cwd && !owned.has(cwd) ? [cwd] : [],
	];
	for (let path of readOnly) {
		let writable = [...writes, ...added].find(other => within(path, other, platform));
		if (writable) {
			throw new SandboxRefused(
				`Not run: ${writable} would be shared writable and holds ${path}, which a microVM may only read. Leave it out of --sandbox-write.`,
			);
		}
	}
	let places: Array<{ host: string; mode: "ro" | "rw" }> = [];
	let add = (host: string, mode: "ro" | "rw") => {
		let same = places.find(place => place.host === host);
		if (same) {
			if (mode === "rw") same.mode = "rw";
			return;
		}
		places.push({ host, mode });
	};
	for (let path of [...writes, ...added]) add(path, "rw");
	for (let path of reads) add(path, "ro");
	// A folder it only reads inside another it is given (a checkout's own `.git`) is in that one,
	// which, as above, is never one it writes but where it is its own.
	places = places.filter(place =>
		place.mode === "rw"
		|| !places.some(other => other !== place && within(place.host, other.host, platform))
	);
	for (let place of places) {
		let holder = places.find(other => other !== place && within(place.host, other.host, platform));
		if (holder) {
			throw new SandboxRefused(
				`Not run: ${holder.host} holds ${place.host}, and a microVM can't be given a folder inside another it is given. Keep chopin's state directory (--base-dir) and your checkouts apart.`,
			);
		}
		if (within(base, place.host, platform)) {
			throw new SandboxRefused(
				`Not run: ${place.host} holds chopin's state directory, which no guest may see. Move it with --base-dir.`,
			);
		}
	}
	let shares: Share[] = places.map(place => {
		let denied = (context.hidden ?? []).map(real).filter(path =>
			within(path, place.host, platform) && path !== place.host
		);
		let guest = guestPath(place.host, platform);
		checkGuestPath(guest, place.host);
		return {
			host: place.host,
			guest,
			mode: place.mode,
			...denied.length ? { denied } : {},
		};
	});
	for (let file of context.files ?? []) {
		shares.push({ host: real(file.host), guest: file.guest, mode: "ro" });
	}
	// Every host path the guest is told of, in its environment, its command or as its working
	// directory, is named where the guest has it: no value names a path it doesn't have.
	let guest = (value: string) => inGuest(value, shares, named, platform) ?? value;
	let proxy = `http://10.0.0.1:${context.proxyPort}`;
	let environment: Record<string, string> = {};
	for (let [name, value] of Object.entries(launch.env)) {
		if (value === undefined || /^(https?|all|no)_proxy$/i.test(name)) continue;
		if (hostOnly(name, platform)) continue;
		environment[name] = guest(value);
	}
	let home = launch.agentHome ? guestPath(real(launch.agentHome), platform) : "/tmp/home";
	if (repository) {
		Object.assign(environment, {
			CHOPIN_GUEST_REPOSITORY: repository.path,
			CHOPIN_GUEST_SOURCE: guestPath(real(repository.source), platform),
			...repository.dissociate ? { CHOPIN_GUEST_DISSOCIATE: "1" } : {},
			...repository.origin ? { CHOPIN_GUEST_ORIGIN: repository.origin } : {},
			...repository.commit ? { CHOPIN_GUEST_COMMIT: repository.commit } : {},
			...repository.branch ? { CHOPIN_GUEST_BRANCH: repository.branch } : {},
		});
	}
	let configs = Number(environment.GIT_CONFIG_COUNT ?? 0) || 0;
	Object.assign(environment, {
		...context.image.environment,
		PATH: [...context.image.path, ...GUEST_PATH].join(":"),
		HOME: home,
		TMPDIR: "/tmp",
		HTTPS_PROXY: proxy,
		HTTP_PROXY: proxy,
		ALL_PROXY: proxy,
		https_proxy: proxy,
		http_proxy: proxy,
		all_proxy: proxy,
		NO_PROXY: "",
		no_proxy: "",
		NODE_USE_ENV_PROXY: "1",
		// The guest's user owns none of the shared files: they are the connector's user's, open to it.
		GIT_CONFIG_COUNT: String(configs + 1),
		[`GIT_CONFIG_KEY_${configs}`]: "safe.directory",
		[`GIT_CONFIG_VALUE_${configs}`]: "*",
	});
	for (let name of ["TMP", "TEMP"]) delete environment[name];
	if (!launch.command[0]) throw new SandboxRefused("Not run: there is no command.");
	// The program, and `env` before it, by the names the guest finds them by on its PATH.
	let at = programAt(launch.command);
	let command = launch.command.map((word, index) =>
		index === 0 || index === at ? guestProgram(word, platform) : guest(word)
	);
	return {
		image: context.image,
		shares,
		proxyPort: context.proxyPort,
		environment,
		// The image's directories come first on the guest's PATH: a program by any host path runs
		// as the image installed it.
		command: repository ? ["/bin/sh", "-c", PREPARE, "chopin-launch", ...command] : command,
		cwd: cwd ? inGuest(cwd, shares, named, platform) ?? guestPath(cwd, platform) : "/",
		...launch.disk ? { disk: real(launch.disk) } : {},
		memoryMib: context.memoryMib ?? 2048,
		processors: context.processors ?? 2,
		hostname: `chopin-${
			createHash("sha256").update(repository?.path ?? cwd ?? "").update(launch.agentHome ?? "")
				.digest("hex").slice(0, 8)
		}`,
	};
}

/**
 * The program a host command names, as the guest finds it on its PATH: its file name, without the
 * `.exe` or `.cmd` a Windows install gives it.
 */
export function guestProgram(program: string, platform: NodeJS.Platform) {
	let name = (platform === "win32" ? win32 : posix).basename(program);
	return platform === "win32" ? name.replace(/\.(exe|cmd|bat|ps1)$/i, "") : name;
}

/**
 * Where `command` names the program it runs: after `env` and its VAR=VALUE assignments, when it
 * starts with `env` or an absolute path to it, else its first word.
 */
export function programAt(command: string[]) {
	let first = command[0] ?? "";
	if (first !== "env" && !(posix.isAbsolute(first) && posix.basename(first) === "env")) return 0;
	let at = 1;
	while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(command[at] ?? "")) at++;
	return command[at] && !command[at]!.startsWith("-") ? at : 0;
}

/** The guest's address and the gateway the proxy is at. */
export const GUEST_NETWORK = "10.0.0.2/24";
export const GATEWAY = "10.0.0.1";

/**
 * What a guest prints on its stdout as it starts its workload, before anything of the workload's
 * own: the line that tells the connector the workload has started, which it takes out (see
 * `startVm`).
 */
export const STARTED_LINE = ">> chopin: the workload starts";

/**
 * The guest's command around an image's workload: it says the workload starts, then runs it by the
 * name the guest finds it by on its PATH.
 */
export const LAUNCHER = `echo '${STARTED_LINE}'; exec /usr/bin/env -- "$@"`;

/**
 * The guest's command where it runs as the layer's `nobody` (an image's build), which owns nothing
 * shared: what it makes in a share is left writable to it.
 */
export const OPEN_LAUNCHER = `umask 000; echo '${STARTED_LINE}'; exec "$@"`;

/**
 * The `nvx sandbox run` command line for `spec`: the Ubuntu layer under a RAM upper, the shares,
 * the proxy-only network and the launch's command. The environment is read from `environmentFile`,
 * never put on the command line, where every process on the host could read it.
 */
export function nvxArguments(
	spec: VmSpec,
	artifacts: NvxArtifacts,
	hypervisor: Hypervisor,
	environmentFile: string,
): string[] {
	let layer = spec.image?.layer ?? artifacts.layer;
	let words = [
		"sandbox",
		"run",
		`--hypervisor=${hypervisor}`,
		`--layer=distro,${layer.path},${layer.uuid}`,
		...spec.disk
			? ["--upper=scratch", `--scratch=${spec.disk}`]
			: [
				"--upper=ram",
				...spec.ramUpperPercent ? [`--ram-upper-percent=${spec.ramUpperPercent}`] : [],
			],
		`--memory-mib=${spec.memoryMib}`,
		`--hostname=${spec.hostname}`,
		...spec.image ? [`--workload-user=${spec.image.user}`] : [],
	];
	// A policy path is relative to its share, which it then follows on the command line.
	let paths = artifacts.nvx.endsWith(".exe") ? win32 : posix;
	let inShare = (share: Share, path: string) =>
		paths.relative(share.host, path).split(paths.sep).join("/");
	for (let share of spec.shares) {
		words.push(`--mount=${share.guest},${share.host},${share.mode}`);
		for (let path of share.writable ?? []) words.push(`--mount-write=${inShare(share, path)}`);
		for (let path of share.denied ?? []) words.push(`--mount-deny=${inShare(share, path)}`);
	}
	words.push(
		`--net=${GUEST_NETWORK}`,
		"--network-profile=portable",
		"--network-egress=deny",
		"--host-loopback=deny",
		`--network-proxy=${GATEWAY}:${spec.proxyPort}`,
		`--environment-file=${environmentFile}`,
		`--cwd=${spec.cwd}`,
		"--entrypoint=/bin/sh",
		"--arg=-c",
		`--arg=${spec.image ? LAUNCHER : OPEN_LAUNCHER}`,
		"--arg=chopin-launch",
		...spec.command.map(word => `--arg=${word}`),
		// The workload's own deadline is the connector's (a run's limit, a Planner's life), not NVX's.
		"--timeout=31536000",
		"--exec-timeout-ms=0",
	);
	return words;
}

/** The environment as `--environment-file` reads it: a JSON array of `NAME=value`. */
export function environmentFile(environment: Record<string, string>): string {
	return JSON.stringify(Object.entries(environment).map(([name, value]) => `${name}=${value}`));
}

/** Makes the folders a guest writes before it starts, as `vmSpec` names them. */
export function makeWritable(spec: VmSpec) {
	for (let share of spec.shares) {
		if (share.mode === "rw") mkdirSync(share.host, { recursive: true });
	}
}

/** Fetches a URL into a file; resolves once the file holds all of it. */
export type Fetcher = (
	url: string,
	path: string,
	progress?: (bytes: number) => void,
) => Promise<void>;

/** Unpacks a package archive into a folder: `tar` reads `.tar.gz` and, on Windows 10 and later, `.zip`. */
export type Unpacker = (archive: string, into: string) => Promise<void>;

/**
 * Installs the pinned NVX release for this machine into `<base>/nvx/<version>`: downloaded, its
 * SHA-256 checked against the pin, unpacked, each of its files checked against the package's own
 * `SHA256SUMS`, then made the installed release in one rename. A release that fails any check is
 * removed and nothing is installed.
 */
export async function installNvx(
	base: string,
	name: NvxPackage,
	platform: NodeJS.Platform,
	fetchTo: Fetcher,
	unpack: Unpacker,
	progress?: (bytes: number) => void,
): Promise<NvxArtifacts> {
	let { mkdir, rename, rm, readdir, writeFile } = await import("node:fs/promises");
	let target = nvxDirectory(base);
	let pinned = NVX_RELEASE.packages[name];
	let work = `${target}.installing-${randomSuffix()}`;
	await mkdir(work, { recursive: true, mode: 0o700 });
	try {
		let archive = join(work, pinned.file);
		let failures: string[] = [];
		for (let url of packageUrls(name)) {
			try {
				await fetchTo(url, archive, progress);
				break;
			} catch (error) {
				failures.push(error instanceof Error ? error.message : String(error));
			}
		}
		if (failures.length === packageUrls(name).length) {
			throw new Error(`Couldn't download NVX ${NVX_RELEASE.version}: ${failures.join("; ")}`);
		}
		let digest = createHash("sha256").update(readFileSync(archive)).digest("hex");
		if (digest !== pinned.sha256) {
			throw new Error(
				`The NVX package downloaded isn't the one this chopin pins (SHA-256 ${digest}), so nothing was installed.`,
			);
		}
		let unpacked = join(work, "unpacked");
		await mkdir(unpacked);
		await unpack(archive, unpacked);
		// The package holds one folder, `nvx-<version>-<platform>`.
		let [inner] = await readdir(unpacked);
		let root = inner ? join(unpacked, inner) : unpacked;
		let problems = checkSums(root);
		if (problems.length) {
			throw new Error(
				`The NVX package's files don't match its SHA256SUMS: ${problems.slice(0, 3).join(", ")}`,
			);
		}
		if (!artifactsAt(root, platform)) {
			throw new Error("The NVX package has no nvx or no Ubuntu layer.");
		}
		await writeFile(join(root, ".verified"), `${NVX_RELEASE.version}\n`);
		await rm(target, { recursive: true, force: true });
		await rename(root, target);
	} finally {
		await rm(work, { recursive: true, force: true });
	}
	removeStaleReleases(base);
	return artifactsAt(target, platform)!;
}

function randomSuffix() {
	return createHash("sha256").update(`${process.pid}:${Date.now()}:${Math.random()}`).digest("hex")
		.slice(0, 8);
}
