/**
 * A local server that serves a fake chopin release in the layout GitHub uses:
 * `<base>/cli-v<version>/<asset>` and the API's list of releases.
 */
export type Content = string | Uint8Array<ArrayBuffer>;
/** An asset, or a redirect to another path on the same plain-HTTP server. */
type Served = Content | { redirect: string };

export function sha256(content: Content) {
	return new Bun.CryptoHasher("sha256").update(content).digest("hex");
}

export function fakeRelease(releases: Record<string, Record<string, Served>>) {
	let requests: string[] = [];
	let server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request): Response {
			let path = new URL(request.url).pathname;
			requests.push(path);
			if (path === "/api/releases") {
				return Response.json(
					// Newest first, as GitHub lists them, among tags that are not CLI releases.
					[
						"color-controls-slice-4",
						...Object.keys(releases).toReversed().map(v => `cli-v${v}`),
					].map(tag => ({
						tag_name: tag,
						draft: false,
						prerelease: false,
					})),
				);
			}
			let [, tag, name] = path.split("/");
			let content = releases[tag.replace(/^cli-v/, "")]?.[name];
			if (content === undefined) return new Response("Not Found", { status: 404 });
			if (typeof content === "object" && "redirect" in content) {
				return Response.redirect(`${origin}${content.redirect}`, 302);
			}
			return new Response(content);
		},
	});
	let origin = `http://127.0.0.1:${server.port}`;
	return {
		requests,
		env: {
			CHOPIN_RELEASE_BASE_URL: origin,
			CHOPIN_RELEASES_API_URL: `${origin}/api/releases`,
		},
		[Symbol.dispose]: () => void server.stop(true),
	};
}

export function fakeChopin(version: string) {
	return `#!/bin/sh\necho "chopin ${version} (connector protocol 1)"\n`;
}

/** A release's assets for one platform: the binary and a checksums.txt that lists it. */
export function assets(name: string, binary: Content, checksum = sha256(binary)) {
	return {
		[name]: binary,
		"checksums.txt": `${"0".repeat(64)}  other-file\n${checksum}  ${name}\n`,
	};
}
