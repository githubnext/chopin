import { realpath } from "node:fs/promises";

/** Origin host names may be SSH aliases; the repository coordinates must match. */
export async function verifiedCheckout(
	repository: { owner: string; name: string },
	candidate: string,
): Promise<string | undefined> {
	try {
		let cwd = await realpath(candidate);
		let git = async (...args: string[]) => {
			let process = Bun.spawn(["git", "-C", cwd, ...args], {
				stdout: "pipe",
				stderr: "pipe",
			});
			let output = await new Response(process.stdout).text();
			if (await process.exited !== 0) throw new Error("not a checkout");
			return output.trim();
		};
		if (await git("rev-parse", "--is-inside-work-tree") !== "true") return undefined;
		let origin = await git("remote", "get-url", "origin");
		let path = origin.includes("://")
			? new URL(origin).pathname.replace(/^\//, "")
			: /^[^/:]+:(.+)$/.exec(origin)?.[1];
		return path?.replace(/\.git$/, "").toLowerCase()
				=== `${repository.owner}/${repository.name}`.toLowerCase()
			? cwd
			: undefined;
	} catch {
		// A missing path or an unrelated checkout is simply not verified.
		return undefined;
	}
}
