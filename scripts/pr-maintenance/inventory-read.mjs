import { execFileSync } from "node:child_process";

function pause(milliseconds) {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

export function createInventoryRead(repository, options = {}) {
	if (
		!/^[-\w.]+\/[-\w.]+$/.test(repository ?? "")
		|| repository.split("/").some(part => part === "." || part === "..")
	) throw new Error("Invalid inventory repository");
	let read = options.read ?? execFileSync;
	let wait = options.pause ?? pause;
	let prefix = `repos/${repository}/`;
	return args => {
		if (
			!Array.isArray(args) || args[0] !== "api" || typeof args[1] !== "string"
			|| !args[1].startsWith(prefix) || args[1].includes("#")
			|| ![2, 4].includes(args.length)
			|| (args.length === 4 && (args[2] !== "--paginate" || args[3] !== "--slurp"))
		) throw new Error("Invalid read-only inventory request");
		let path = args[1].slice(prefix.length);
		if (
			!/^(?:pulls(?:\?state=open&sort=updated&direction=asc&per_page=100|\/[1-9][0-9]*)|commits\/(?:[A-Za-z0-9_.!~'()-]|%[0-9A-F]{2})+|compare\/[A-Za-z0-9_.~-]+\.\.\.[A-Za-z0-9_.~-]+|actions\/workflows\/ci\.yml\/runs\?head_sha=[A-Za-z0-9]+&event=pull_request&per_page=1)$/
				.test(path)
		) throw new Error("Invalid read-only inventory request");
		if (path.startsWith("commits/")) {
			let segment = path.slice("commits/".length);
			let decoded;
			try {
				decoded = decodeURIComponent(segment);
			} catch {
				throw new Error("Invalid read-only inventory request");
			}
			if (
				encodeURIComponent(decoded) !== segment
				|| decoded.split("/").some(part => part === "." || part === "..")
				|| [...decoded].some(character =>
					character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
				)
			) throw new Error("Invalid read-only inventory request");
		}
		let result;
		let unavailable = false;
		for (let attempt = 0; attempt < 3; attempt++) {
			try {
				result = read("gh", args, {
					encoding: "utf8",
					stdio: ["ignore", "pipe", "pipe"],
					maxBuffer: 16 * 1024 * 1024,
					timeout: 30_000,
				});
				break;
			} catch (error) {
				let stderr = typeof error?.stderr === "string" || Buffer.isBuffer(error?.stderr)
					? Buffer.from(error.stderr)
					: null;
				let transient = stderr && stderr.length <= 8192
					&& /^gh: (?:HTTP\s?(?:502|503|504)|[^\r\n]{1,200}\(HTTP\s?(?:502|503|504)\))\r?$/m.test(
						stderr.toString("utf8"),
					);
				if (!transient || attempt === 2) {
					unavailable = true;
					break;
				}
				wait(attempt === 0 ? 1000 : 3000);
			}
		}
		if (unavailable) throw new Error("Inventory read unavailable");
		try {
			return JSON.parse(result);
		} catch {
			throw new Error("Invalid inventory JSON");
		}
	};
}
