import { isIP } from "node:net";

/**
 * The address a request came from. The socket's peer is the client unless it is a proxy the
 * operator trusts (TRUSTED_PROXIES); then X-Forwarded-For is read from the right, past every
 * trusted hop, to the first address that isn't one. A client can write anything to the left of
 * what the proxies append, so nothing an untrusted hop says is believed.
 */

type Range = { bytes: Uint8Array; prefix: number };

/** IPv4 as its IPv6-mapped form, so one comparison covers both. */
function bytesOf(address: string): Uint8Array | undefined {
	let plain = address.replace(/^\[|\]$/g, "").replace(/%.*$/, "");
	let mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(plain)?.[1];
	if (mapped) plain = mapped;
	let kind = isIP(plain);
	if (kind === 4) {
		let bytes = new Uint8Array(16);
		bytes[10] = 0xff;
		bytes[11] = 0xff;
		plain.split(".").forEach((part, index) => (bytes[12 + index] = Number(part)));
		return bytes;
	}
	if (kind !== 6) return undefined;
	let [head, tail = ""] = plain.split("::");
	let groups = (part: string) => part ? part.split(":") : [];
	let left = groups(head!);
	let right = groups(tail);
	// An embedded IPv4 tail counts as two groups.
	let last = right.at(-1) ?? left.at(-1);
	let four = last && last.includes(".") ? bytesOf(last)!.slice(12) : undefined;
	if (four) (right.length ? right : left).pop();
	let fill = 8 - left.length - right.length - (four ? 2 : 0);
	let all = [...left, ...Array(plain.includes("::") ? fill : 0).fill("0"), ...right];
	let bytes = new Uint8Array(16);
	all.forEach((group, index) => {
		let value = parseInt(group, 16);
		bytes[index * 2] = value >> 8;
		bytes[index * 2 + 1] = value & 0xff;
	});
	if (four) bytes.set(four, 12);
	return bytes;
}

/** The plain form of an address: an IPv4-mapped IPv6 one as IPv4. */
function plainAddress(address: string): string | undefined {
	let bytes = bytesOf(address);
	if (!bytes) return undefined;
	let mapped = bytes.slice(0, 12).every((value, index) => value === (index >= 10 ? 0xff : 0));
	return mapped ? bytes.slice(12).join(".") : address.replace(/^\[|\]$/g, "");
}

export type TrustedProxies = { matches(address: string): boolean };

/** TRUSTED_PROXIES: comma-separated IPs and CIDRs, IPv4 or IPv6. Malformed entries are ignored. */
export function trustedProxies(raw: string | undefined): TrustedProxies {
	let ranges: Range[] = [];
	for (let entry of (raw ?? "").split(",").map(value => value.trim()).filter(Boolean)) {
		let [address, bits] = entry.split("/");
		let bytes = bytesOf(address!);
		if (!bytes) continue;
		let v4 = isIP(address!) === 4;
		let prefix = bits === undefined ? 128 : Number(bits) + (v4 ? 96 : 0);
		if (bits !== undefined && (!/^\d+$/.test(bits) || prefix > 128 || (v4 && Number(bits) > 32))) {
			continue;
		}
		ranges.push({ bytes, prefix });
	}
	return {
		matches(address) {
			let bytes = bytesOf(address);
			return !!bytes && ranges.some(range => {
				for (let bit = 0; bit < range.prefix; bit++) {
					let mask = 0x80 >> (bit % 8);
					if ((bytes[bit >> 3]! & mask) !== (range.bytes[bit >> 3]! & mask)) return false;
				}
				return true;
			});
		},
	};
}

let peers = new WeakMap<Request, string>();

/** Remember the socket's peer for a request, as the server reads it before routing. */
export function peerAddress(request: Request, address: string | undefined) {
	if (address) peers.set(request, address);
}

export function clientAddress(request: Request, trusted: TrustedProxies): string | undefined {
	let peer = peers.get(request);
	if (!peer) return undefined;
	let address = peer;
	if (trusted.matches(peer)) {
		let hops = (request.headers.get("x-forwarded-for") ?? "").split(",").map(value => value.trim())
			.filter(Boolean);
		for (let hop of hops.reverse()) {
			if (!bytesOf(hop)) break;
			address = hop;
			if (!trusted.matches(hop)) break;
		}
	}
	return plainAddress(address);
}
