import { expect, test } from "bun:test";
import { clientAddress, peerAddress, trustedProxies } from "./client-address";

function request(forwarded?: string) {
	return new Request("https://chopin.test/", {
		headers: forwarded === undefined ? {} : { "x-forwarded-for": forwarded },
	});
}

test("TRUSTED_PROXIES takes IPs and CIDRs, IPv4 and IPv6, and ignores what isn't one", () => {
	let trusted = trustedProxies(
		" 172.16.0.0/12, 10.0.0.5 ,fd00::/8, ::1, nonsense, 300.1.1.1, 10.0.0.0/33",
	);
	expect(trusted.matches("172.18.0.2")).toBe(true);
	expect(trusted.matches("172.32.0.1")).toBe(false);
	expect(trusted.matches("10.0.0.5")).toBe(true);
	expect(trusted.matches("10.0.0.6")).toBe(false);
	expect(trusted.matches("fd12:3456::1")).toBe(true);
	expect(trusted.matches("::1")).toBe(true);
	expect(trusted.matches("2001:db8::1")).toBe(false);
	// An IPv4 peer as Bun reports it on a dual-stack socket.
	expect(trusted.matches("::ffff:172.18.0.2")).toBe(true);
	expect(trustedProxies(undefined).matches("127.0.0.1")).toBe(false);
});

test("without trusted proxies the socket's address is the client's, whatever X-Forwarded-For says", () => {
	let none = trustedProxies("");
	let forged = request("203.0.113.9");
	peerAddress(forged, "198.51.100.7");
	expect(clientAddress(forged, none)).toBe("198.51.100.7");
});

test("from a trusted proxy, X-Forwarded-For is read right to left to the first untrusted address", () => {
	let trusted = trustedProxies("172.16.0.0/12,10.0.0.0/8");
	// The client prepended a forged address; the proxies appended what they saw.
	let proxied = request("6.6.6.6, 203.0.113.9, 10.1.2.3");
	peerAddress(proxied, "172.18.0.2");
	expect(clientAddress(proxied, trusted)).toBe("203.0.113.9");
	let v6 = request("2001:db8::42");
	peerAddress(v6, "::ffff:172.18.0.2");
	expect(clientAddress(v6, trusted)).toBe("2001:db8::42");
	// A malformed entry stops the walk at the last good address.
	let garbled = request("not-an-ip, 10.1.2.3");
	peerAddress(garbled, "172.18.0.2");
	expect(clientAddress(garbled, trusted)).toBe("10.1.2.3");
	// Every hop trusted: the leftmost is the best there is.
	let inner = request("10.9.9.9");
	peerAddress(inner, "172.18.0.2");
	expect(clientAddress(inner, trusted)).toBe("10.9.9.9");
});

test("an untrusted peer's X-Forwarded-For is ignored, and an unknown peer gives no address", () => {
	let trusted = trustedProxies("172.16.0.0/12");
	let spoofed = request("172.18.0.2, 203.0.113.9");
	peerAddress(spoofed, "198.51.100.7");
	expect(clientAddress(spoofed, trusted)).toBe("198.51.100.7");
	expect(clientAddress(request("203.0.113.9"), trusted)).toBeUndefined();
	let mapped = request();
	peerAddress(mapped, "::ffff:198.51.100.7");
	expect(clientAddress(mapped, trusted)).toBe("198.51.100.7");
});
