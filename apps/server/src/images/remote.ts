import dns from "node:dns";
import net, { isIP } from "node:net";
import tls from "node:tls";
import { fromMarkdown } from "mdast-util-from-markdown";
import { normalizeUri } from "micromark-util-sanitize-uri";

import { GitHubError } from "../github/client";
import { MAX_IMAGE_BYTES, sniffImageType } from "./format";

import type { Nodes } from "mdast";
import type { Duplex } from "node:stream";
import type { HostedAuth } from "../auth/routes";
import type { Router } from "../http/router";

export type RemoteTarget = { address: string; port: number; secure: boolean; host: string };

export type RemoteNetwork = {
	lookup(hostname: string): Promise<string[]>;
	connect(target: RemoteTarget): Duplex;
};

const NETWORK: RemoteNetwork = {
	async lookup(hostname) {
		let found = await dns.promises.lookup(hostname, { all: true, verbatim: true });
		return found.map(item => item.address);
	},
	connect({ address, host, port, secure }) {
		if (!secure) return net.connect({ host: address, port });
		return tls.connect({ host: address, port, ...(isIP(host) ? {} : { servername: host }) });
	},
};

const MAX_REDIRECTS = 3;
const TIMEOUT_MS = 8_000;
const HEAD_BYTES = 16 * 1024;
const READ_EVERY_MS = 50;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

class Refused extends Error {}

type Answer = { status: number; headers: Map<string, string>; body: Uint8Array };

function plain(status: number, message: string): Response {
	return new Response(message, {
		status,
		headers: {
			"cache-control": "no-store",
			"content-type": "text/plain; charset=utf-8",
			"x-content-type-options": "nosniff",
		},
	});
}

function v4Public([a, b, c, d]: number[]): boolean {
	if (a === undefined || b === undefined || c === undefined || d === undefined) return false;
	if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
	if (a === 100 && b >= 64 && b <= 127) return false;
	if (a === 168 && b === 63 && c === 129 && d === 16) return false;
	if (a === 169 && b === 254) return false;
	if (a === 172 && b >= 16 && b <= 31) return false;
	if (a === 192 && b === 168) return false;
	if (a === 192 && b === 0 && (c === 0 || c === 2)) return false;
	if (a === 192 && b === 88 && c === 99) return false;
	if (a === 198 && (b === 18 || b === 19)) return false;
	if (a === 198 && b === 51 && c === 100) return false;
	if (a === 203 && b === 0 && c === 113) return false;
	return true;
}

function hextets(address: string): number[] | undefined {
	if (address.includes("%")) return undefined;
	let text = address.replace(
		/(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/,
		(_, a, b, c, d) =>
			`${(Number(a) * 256 + Number(b)).toString(16)}:${(Number(c) * 256 + Number(d)).toString(16)}`,
	);
	let [head = "", tail, ...more] = text.split("::");
	if (more.length > 0) return undefined;
	let left = head ? head.split(":") : [];
	let right = tail ? tail.split(":") : [];
	let missing = 8 - left.length - right.length;
	if (tail === undefined ? missing !== 0 : missing < 1) return undefined;
	let groups = [...left, ...Array<string>(tail === undefined ? 0 : missing).fill("0"), ...right];
	if (!groups.every(group => /^[0-9a-f]{1,4}$/i.test(group))) return undefined;
	return groups.map(group => parseInt(group, 16));
}

export function isPublicAddress(address: string): boolean {
	if (isIP(address) === 4) return v4Public(address.split(".").map(Number));
	if (isIP(address) !== 6) return false;
	let groups = hextets(address);
	if (!groups) return false;
	let [first = 0, second = 0] = groups;
	if (groups.slice(0, 5).every(group => group === 0) && groups[5] === 0xffff) {
		let [high = 0, low = 0] = groups.slice(6);
		return v4Public([high >> 8, high & 0xff, low >> 8, low & 0xff]);
	}
	if ((first & 0xe000) !== 0x2000) return false;
	if (first === 0x2001 && (second < 0x200 || second === 0x0db8)) return false;
	if (first === 0x2002) return false;
	if (first === 0x3fff && second < 0x1000) return false;
	return true;
}

export function imageSources(text: string): string[] {
	let definitions = new Map<string, string>();
	let images: Array<{ url?: string; identifier?: string }> = [];
	let pending: Nodes[] = [fromMarkdown(text)];
	for (let node = pending.pop(); node; node = pending.pop()) {
		if (node.type === "definition") {
			let key = node.identifier.toUpperCase();
			if (!definitions.has(key)) definitions.set(key, node.url);
		} else if (node.type === "image") {
			images.push({ url: node.url });
		} else if (node.type === "imageReference") {
			images.push({ identifier: node.identifier.toUpperCase() });
		}
		if ("children" in node) pending.push(...(node.children as Nodes[]).toReversed());
	}
	return images.flatMap(({ identifier, url }) => {
		let address = url ?? definitions.get(identifier!);
		return address === undefined ? [] : [normalizeUri(address)];
	});
}

function readable(value: string | null | undefined, base?: URL): URL | undefined {
	if (!value) return undefined;
	try {
		let url = new URL(value, base);
		if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
		if (url.username || url.password) return undefined;
		return url;
	} catch {
		return undefined;
	}
}

export function transcriptShows(sidecar: unknown, target: URL): boolean {
	let transcript = (sidecar as { transcript?: unknown } | null | undefined)?.transcript;
	if (!Array.isArray(transcript)) return false;
	return transcript.some(entry => {
		let text = (entry as { text?: unknown } | null)?.text;
		return typeof text === "string" && text.includes("![")
			&& imageSources(text).some(source => readable(source)?.href === target.href);
	});
}

function hostOf(url: URL): string {
	return url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;
}

function within<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
	return new Promise((resolve, reject) => {
		let abort = () => reject(new Refused("the read took too long"));
		if (signal.aborted) return abort();
		signal.addEventListener("abort", abort, { once: true });
		work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
	});
}

async function publicAddress(
	network: RemoteNetwork,
	host: string,
	signal: AbortSignal,
): Promise<string> {
	let addresses = isIP(host) ? [host] : await within(network.lookup(host), signal);
	if (addresses.length === 0 || !addresses.every(isPublicAddress)) {
		throw new Refused(`${host} is not on the public internet`);
	}
	return addresses[0]!;
}

function requestHead(url: URL): string {
	return [
		`GET ${url.pathname}${url.search} HTTP/1.1`,
		`Host: ${url.host}`,
		"Accept: image/avif,image/webp,image/apng,image/*;q=0.8",
		"Accept-Encoding: identity",
		"Connection: close",
		"User-Agent: Chopin",
		"",
		"",
	].join("\r\n");
}

function unchunked(data: Uint8Array): Uint8Array | undefined {
	let bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
	let parts: Uint8Array[] = [];
	let total = 0;
	let at = 0;
	for (;;) {
		let line = bytes.indexOf("\r\n", at);
		if (line < 0) return undefined;
		let field = bytes.subarray(at, line).toString("latin1").split(";")[0]!.trim();
		if (!/^[0-9a-f]{1,8}$/i.test(field)) throw new Refused("a malformed chunk");
		let size = parseInt(field, 16);
		if (size === 0) return Buffer.concat(parts);
		total += size;
		if (total > MAX_IMAGE_BYTES) throw new Refused("the image is too large");
		let start = line + 2;
		if (bytes.length < start + size + 2) return undefined;
		parts.push(bytes.subarray(start, start + size));
		at = start + size + 2;
	}
}

function parsed(data: Buffer, ended: boolean): Answer | undefined {
	let end = data.indexOf("\r\n\r\n");
	if (end < 0) {
		if (data.length > HEAD_BYTES) throw new Refused("the answer's head is too long");
		return undefined;
	}
	let [first = "", ...lines] = data.subarray(0, end).toString("latin1").split("\r\n");
	let status = /^HTTP\/1\.[01] ([1-5]\d\d)(?: |$)/.exec(first);
	if (!status) throw new Refused("not an HTTP answer");
	let code = Number(status[1]);
	let rest = data.subarray(end + 4);
	if (code < 200) return parsed(rest, ended);
	let headers = new Map<string, string>();
	for (let line of lines) {
		let colon = line.indexOf(":");
		if (colon < 1) throw new Refused("a malformed header");
		let name = line.slice(0, colon).trim().toLowerCase();
		let value = line.slice(colon + 1).trim();
		let earlier = headers.get(name);
		headers.set(name, earlier === undefined ? value : `${earlier}, ${value}`);
	}
	if (code !== 200) return { status: code, headers, body: new Uint8Array() };
	let coding = headers.get("content-encoding")?.toLowerCase();
	if (coding !== undefined && coding !== "identity") throw new Refused("an encoded answer");
	let transfer = headers.get("transfer-encoding")?.toLowerCase();
	if (transfer !== undefined) {
		if (transfer !== "chunked") throw new Refused("an unknown transfer coding");
		let body = unchunked(rest);
		return body && { status: code, headers, body };
	}
	let declared = headers.get("content-length");
	if (declared !== undefined) {
		if (!/^\d+$/.test(declared)) throw new Refused("a malformed length");
		let size = Number(declared);
		if (size > MAX_IMAGE_BYTES) throw new Refused("the image is too large");
		return rest.length >= size
			? { status: code, headers, body: rest.subarray(0, size) }
			: undefined;
	}
	return ended ? { status: code, headers, body: rest } : undefined;
}

function exchange(socket: Duplex, url: URL, signal: AbortSignal): Promise<Answer> {
	return new Promise((resolve, reject) => {
		let chunks: Buffer[] = [];
		let received = 0;
		let done = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let finish = (error: unknown, answer?: Answer) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			signal.removeEventListener("abort", aborted);
			socket.destroy();
			if (answer) resolve(answer);
			else reject(error);
		};
		let aborted = () => finish(new Refused("the read took too long"));
		let attempt = (ended: boolean) => {
			if (done) return;
			clearTimeout(timer);
			timer = undefined;
			try {
				let data = Buffer.concat(chunks);
				chunks = [data];
				let answer = parsed(data, ended);
				if (answer) finish(undefined, answer);
				else if (ended) finish(new Refused("the answer ended early"));
			} catch (error) {
				finish(error);
			}
		};
		if (signal.aborted) return aborted();
		signal.addEventListener("abort", aborted, { once: true });
		socket.on("data", (chunk: Buffer) => {
			received += chunk.length;
			if (received > MAX_IMAGE_BYTES + HEAD_BYTES) {
				return finish(new Refused("the image is too large"));
			}
			chunks.push(chunk);
			timer ??= setTimeout(() => attempt(false), READ_EVERY_MS);
		});
		socket.on("end", () => attempt(true));
		socket.on("close", () => attempt(true));
		socket.on("error", error => finish(error));
		socket.write(requestHead(url));
	});
}

async function readRemote(
	network: RemoteNetwork,
	start: URL,
	signal: AbortSignal,
): Promise<Uint8Array> {
	let url = start;
	for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
		let host = hostOf(url);
		let address = await publicAddress(network, host, signal);
		let secure = url.protocol === "https:";
		let port = url.port ? Number(url.port) : secure ? 443 : 80;
		let answer = await exchange(network.connect({ address, host, port, secure }), url, signal);
		if (REDIRECTS.has(answer.status)) {
			let next = readable(answer.headers.get("location"), url);
			if (!next) throw new Refused("a redirect to an address that cannot be read");
			url = next;
			continue;
		}
		if (answer.status !== 200) throw new Refused(`the host answered ${answer.status}`);
		if (answer.body.byteLength > MAX_IMAGE_BYTES) throw new Refused("the image is too large");
		return answer.body;
	}
	throw new Refused("too many redirects");
}

export function registerRemoteImageRoutes(
	router: Router,
	auth: HostedAuth,
	network: RemoteNetwork = NETWORK,
): void {
	router.on("GET", "/images/remote", async (request, url) => {
		let missing = plain(404, "image not found");
		let document = url.searchParams.get("document");
		let target = readable(url.searchParams.get("url"));
		if (!document || !target) return missing;
		try {
			let session = await auth.sessions.authenticate(request);
			if (!session) return missing;
			let channel = await auth.storage.channels.get(document);
			if (!channel) return missing;
			let { value: repository } = await auth.sessions.use(
				session,
				token =>
					auth.github.repositoryAccess(token, channel.repositoryOwner, channel.repositoryName),
			);
			if (repository?.id !== channel.repositoryId || !repository.permissions.pull) return missing;
			let stored = await auth.storage.collaboration.load(channel.id, auth.clock());
			if (!transcriptShows(stored?.sidecar ?? stored?.snapshot?.sidecar, target)) return missing;
		} catch (err) {
			if (err instanceof GitHubError && err.status === 401) return missing;
			return plain(503, "image is temporarily unavailable");
		}
		let bytes: Uint8Array;
		try {
			bytes = await readRemote(network, target, AbortSignal.timeout(TIMEOUT_MS));
		} catch {
			return missing;
		}
		let type = sniffImageType(bytes);
		if (!type) return missing;
		return new Response(new Uint8Array(bytes), {
			headers: {
				"cache-control": "private, no-store",
				"content-disposition": "inline",
				"content-security-policy": "default-src 'none'; sandbox",
				"content-type": type,
				"x-content-type-options": "nosniff",
			},
		});
	});
}
