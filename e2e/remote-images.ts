import dns from "node:dns";
import { readFile } from "node:fs/promises";
import net from "node:net";

const NAME = "pictures.example";
const ADDRESS = "93.184.215.14";
const TYPES: Record<string, string> = {
	html: "text/html",
	png: "image/png",
	svg: "image/svg+xml",
	webp: "image/webp",
};

let host = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	async fetch(request) {
		let name = new URL(request.url).pathname.split("/").pop() ?? "";
		if (!/^[\w.-]+$/.test(name)) return new Response("not here", { status: 404 });
		try {
			let body = await readFile(new URL(`./fixtures/${name}`, import.meta.url));
			return new Response(body, {
				headers: { "content-type": TYPES[name.split(".").pop()!] ?? "application/octet-stream" },
			});
		} catch {
			return new Response("not here", { status: 404 });
		}
	},
});

let lookup = dns.promises.lookup;
Object.assign(dns.promises, {
	lookup: (hostname: string, options?: unknown) =>
		hostname === NAME
			? Promise.resolve([{ address: ADDRESS, family: 4 }])
			: lookup(hostname, options as never),
});

let connect = net.connect;
Object.assign(net, {
	connect: (...args: Parameters<typeof net.connect>) => {
		let [options] = args;
		if (typeof options === "object" && (options as net.TcpNetConnectOpts).host === ADDRESS) {
			return connect({ host: "127.0.0.1", port: host.port! });
		}
		return connect(...args);
	},
});
