import { expect, test } from "bun:test";
import {
	checkNamespace,
	type NamespaceLink,
	type SysfsEntry,
	sysfsInterfaces,
} from "./conversation-plan-worker";

// Captured from the owned network-none Linux namespace, not invented route examples.
let observed = [
	"Inter-|   Receive                                                |  Transmit\n face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed\n    lo:       0       0    0    0    0     0          0         0        0       0    0    0    0     0       0          0\n tunl0:       0       0    0    0    0     0          0         0        0       0    0    0    0     0       0          0\n  gre0:       0       0    0    0    0     0          0         0        0       0    0    0    0     0       0          0\ngretap0:       0       0    0    0    0     0          0         0        0       0    0    0    0     0       0          0\nerspan0:       0       0    0    0    0     0          0         0        0       0    0    0    0     0       0          0\nip_vti0:       0       0    0    0    0     0          0         0        0       0    0    0    0     0       0          0\nip6_vti0:       0       0    0    0    0     0          0         0        0       0    0    0    0     0       0          0\n  sit0:       0       0    0    0    0     0          0         0        0       0    0    0    0     0       0          0\nip6tnl0:       0       0    0    0    0     0          0         0        0       0    0    0    0     0       0          0\nip6gre0:       0       0    0    0    0     0          0         0        0       0    0    0    0     0       0          0\n",
	"Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT                                                       \n",
	"00000000000000000000000000000000 00 00000000000000000000000000000000 00 00000000000000000000000000000000 ffffffff 00000001 00000000 00200200       lo\n00000000000000000000000000000001 80 00000000000000000000000000000000 00 00000000000000000000000000000000 00000000 00000002 00000000 80200001       lo\n00000000000000000000000000000000 00 00000000000000000000000000000000 00 00000000000000000000000000000000 ffffffff 00000001 00000000 00200200       lo\n",
];
let evidence: Record<string, NamespaceLink> = {
	"lo": {
		"type": "772",
		"path": "/sys/devices/virtual/net/lo",
		"index": "1",
		"link": "1",
		"flags": "0x9",
		"operstate": "unknown",
		"addresses": [
			{
				"address": "127.0.0.1",
				"family": "IPv4",
				"internal": true,
			},
			{
				"address": "::1",
				"family": "IPv6",
				"internal": true,
			},
		],
	},
	"tunl0": {
		"type": "768",
		"path": "/sys/devices/virtual/net/tunl0",
		"index": "2",
		"link": "0",
		"flags": "0x80",
		"operstate": "down",
		"addresses": [],
	},
	"gre0": {
		"type": "778",
		"path": "/sys/devices/virtual/net/gre0",
		"index": "3",
		"link": "0",
		"flags": "0x80",
		"operstate": "down",
		"addresses": [],
	},
	"gretap0": {
		"type": "1",
		"path": "/sys/devices/virtual/net/gretap0",
		"index": "4",
		"link": "0",
		"flags": "0x1002",
		"operstate": "down",
		"addresses": [],
	},
	"erspan0": {
		"type": "1",
		"path": "/sys/devices/virtual/net/erspan0",
		"index": "5",
		"link": "0",
		"flags": "0x1002",
		"operstate": "down",
		"addresses": [],
	},
	"ip_vti0": {
		"type": "768",
		"path": "/sys/devices/virtual/net/ip_vti0",
		"index": "6",
		"link": "0",
		"flags": "0x80",
		"operstate": "down",
		"addresses": [],
	},
	"ip6_vti0": {
		"type": "769",
		"path": "/sys/devices/virtual/net/ip6_vti0",
		"index": "7",
		"link": "0",
		"flags": "0x80",
		"operstate": "down",
		"addresses": [],
	},
	"sit0": {
		"type": "776",
		"path": "/sys/devices/virtual/net/sit0",
		"index": "8",
		"link": "0",
		"flags": "0x80",
		"operstate": "down",
		"addresses": [],
	},
	"ip6tnl0": {
		"type": "769",
		"path": "/sys/devices/virtual/net/ip6tnl0",
		"index": "9",
		"link": "0",
		"flags": "0x80",
		"operstate": "down",
		"addresses": [],
	},
	"ip6gre0": {
		"type": "823",
		"path": "/sys/devices/virtual/net/ip6gre0",
		"index": "10",
		"link": "0",
		"flags": "0x80",
		"operstate": "down",
		"addresses": [],
	},
};

test("inactive kernel fallback tunnels preserve the sealed loopback namespace", () => {
	expect(() => checkNamespace(observed[0]!, observed[1]!, observed[2]!, evidence))
		.not.toThrow();
});

let changes: [string, (links: Record<string, NamespaceLink>) => void][] = [
	["administratively UP fallback", links => {
		links.tunl0!.flags = "0x81";
	}],
	["non-DOWN fallback", links => {
		links.tunl0!.operstate = "unknown";
	}],
	["IPv4-addressed fallback", links => {
		links.tunl0!.addresses = [{ address: "192.0.2.1", family: "IPv4", internal: false }];
	}],
	["IPv6-addressed fallback", links => {
		links.tunl0!.addresses = [{ address: "::1", family: "IPv6", internal: true }];
	}],
	["missing interface", links => {
		delete links.tunl0;
	}],
	["extra interface", links => {
		links.eth0 = structuredClone(links.tunl0!);
	}],
	["wrong fallback type", links => {
		links.tunl0!.type = "1";
	}],
	["linked fallback", links => {
		links.tunl0!.link = "2";
	}],
	["physical device path", links => {
		links.tunl0!.path = "/sys/devices/pci/net/tunl0";
	}],
	["malformed flags", links => {
		links.tunl0!.flags = "0x80junk";
	}],
	["overflow flags", links => {
		links.tunl0!.flags = "0x100000080";
	}],
	["malformed interface index", links => {
		links.tunl0!.index = "2junk";
	}],
	["duplicate interface indices", links => {
		links.tunl0!.index = links.gre0!.index;
	}],
	["non-string interface index", links => {
		Reflect.set(links.tunl0!, "index", 2);
	}],
	["missing address evidence", links => {
		Reflect.deleteProperty(links.tunl0!, "addresses");
	}],
	["loopback DOWN", links => {
		links.lo!.flags = "0x8";
	}],
	["missing loopback flag", links => {
		links.lo!.flags = "0x1";
	}],
	["wrong loopback type", links => {
		links.lo!.type = "1";
	}],
	["linked loopback", links => {
		links.lo!.link = "0";
	}],
	["non-internal loopback address", links => {
		links.lo!.addresses[0]!.internal = false;
	}],
	["nonloopback IPv4", links => {
		links.lo!.addresses[0]!.address = "192.0.2.1";
	}],
	["nonloopback IPv6", links => {
		links.lo!.addresses[1]!.address = "::2";
	}],
	["unaddressed loopback", links => {
		links.lo!.addresses = [];
	}],
];
for (let [label, change] of changes) {
	test(`namespace rejects ${label}`, () => {
		let links = structuredClone(evidence);
		change(links);
		expect(() => checkNamespace(observed[0]!, observed[1]!, observed[2]!, links)).toThrow();
	});
}

test("namespace metadata is mandatory", () => {
	expect(() => Reflect.apply(checkNamespace, undefined, observed)).toThrow();
});
test("unknown DOWN unaddressed virtual device remains rejected", () => {
	let links = structuredClone(evidence);
	links.unknown0 = { ...links.tunl0!, path: "/sys/devices/virtual/net/unknown0" };
	delete links.tunl0;
	expect(() =>
		checkNamespace(observed[0]!.replace("tunl0:", "unknown0:"), observed[1]!, observed[2]!, links)
	).toThrow();
});
test("duplicate proc interface rows remain rejected", () => {
	expect(() => checkNamespace(observed[0]! + "tunl0: 0\n", observed[1]!, observed[2]!, evidence))
		.toThrow();
});
test("IPv4 forwarding remains rejected", () => {
	expect(() =>
		checkNamespace(observed[0]!, observed[1]! + "tunl0 00000000\n", observed[2]!, evidence)
	).toThrow();
});
test("IPv6 forwarding remains rejected", () => {
	expect(() =>
		checkNamespace(
			observed[0]!,
			observed[1]!,
			observed[2]!.replaceAll("00200200", "00000001"),
			evidence,
		)
	).toThrow();
});
test("malformed IPv6 kernel numeric fields fail closed", () => {
	for (let index of [5, 6, 7, 8]) {
		let lines = observed[2]!.trim().split("\n");
		let fields = lines[0]!.trim().split(/\s+/);
		fields[index] += "junk";
		lines[0] = fields.join(" ");
		expect(() => checkNamespace(observed[0]!, observed[1]!, lines.join("\n"), evidence)).toThrow();
	}
});
test("missing or invalid dev headers fail closed", () => {
	for (
		let dev of [
			"",
			observed[0]!.split("\n").slice(1).join("\n"),
			observed[0]!.replace("Receive", "Changed"),
			observed[0]!.replace("carrier", "Changed"),
		]
	) {
		expect(() => checkNamespace(dev, observed[1]!, observed[2]!, evidence)).toThrow();
	}
});
test("incomplete or malformed dev counter rows fail closed", () => {
	for (
		let row of [
			"lo: 0",
			"lo: " + "0 ".repeat(15),
			"lo: " + "0 ".repeat(17),
			"lo: -1 " + "0 ".repeat(15),
			"lo: junk " + "0 ".repeat(15),
		]
	) {
		let dev = observed[0]!.replace(/^\s*lo:.*$/m, row);
		expect(() => checkNamespace(dev, observed[1]!, observed[2]!, evidence)).toThrow();
	}
});
test("IPv4 header cannot be absent or replaced by a route", () => {
	for (let route of ["", "tunl0 00000000", observed[1]!.replace("Gateway", "Changed")]) {
		expect(() => checkNamespace(observed[0]!, route, observed[2]!, evidence)).toThrow();
	}
});

// Captured shared-namespace inventory: ten interface symlinks plus an empty control file.
let sysfsEntries: SysfsEntry[] = [
	...Object.keys(evidence).map((name): SysfsEntry => ({ name, kind: "symlink" })),
	{ name: "bonding_masters", kind: "file", content: "" },
];
test("empty bonding control is excluded from the actual interface inventory", () => {
	expect(new Set(sysfsInterfaces(sysfsEntries, ["lo"]))).toEqual(new Set(Object.keys(evidence)));
});

test("configured or unread bonding control remains rejected", () => {
	for (let content of ["bond0\n", "\n", undefined]) {
		let entries = sysfsEntries.map(entry =>
			entry.name === "bonding_masters" ? { ...entry, content } : entry
		);
		expect(() => sysfsInterfaces(entries, ["lo"])).toThrow();
	}
});
test("wrong-kind or addressed bonding control remains rejected", () => {
	for (let kind of ["other"] satisfies SysfsEntry["kind"][]) {
		let entries = sysfsEntries.map(entry =>
			entry.name === "bonding_masters" ? { ...entry, kind } : entry
		);
		expect(() => sysfsInterfaces(entries, ["lo"])).toThrow();
	}
	expect(() => sysfsInterfaces(sysfsEntries, ["lo", "bonding_masters"])).toThrow();
});
test("unknown non-interface entries and non-symlink interfaces fail closed", () => {
	expect(() =>
		sysfsInterfaces([...sysfsEntries, { name: "unknown_control", kind: "file", content: "" }], [
			"lo",
		])
	).toThrow();
	let entries = sysfsEntries.map((entry): SysfsEntry =>
		entry.name === "lo" ? { ...entry, kind: "file" } : entry
	);
	expect(() => sysfsInterfaces(entries, ["lo"])).toThrow();
});
test("sysfs address coverage and duplicate entry rejection remain mandatory", () => {
	expect(() => sysfsInterfaces(sysfsEntries, ["lo", "unknown0"])).toThrow();
	expect(() => sysfsInterfaces([...sysfsEntries, sysfsEntries[0]!], ["lo"])).toThrow();
});

test("a symlink named bonding_masters remains a real unknown interface", () => {
	let entries = sysfsEntries.map((entry): SysfsEntry =>
		entry.name === "bonding_masters" ? { ...entry, kind: "symlink" } : entry
	);
	expect(sysfsInterfaces(entries, ["lo"])).toContain("bonding_masters");
	let links = {
		...evidence,
		bonding_masters: {
			...evidence.tunl0!,
			index: "11",
			path: "/sys/devices/virtual/net/bonding_masters",
		},
	};
	let dev = observed[0]! + "bonding_masters: " + "0 ".repeat(16) + "\n";
	expect(() => checkNamespace(dev, observed[1]!, observed[2]!, links)).toThrow();
});
