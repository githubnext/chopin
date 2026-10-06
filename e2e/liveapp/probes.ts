/** Test-only observation. These references never own or restore application state. */
export function lifetimeProbes() {
	return {
		name: "frontend-lifetime-probes",
		enforce: "pre" as const,
		transform(code: string, id: string) {
			if (id.endsWith("/packages/editor/src/collaboration.tsx")) {
				return code.replace(
					"setCollab({ binding, provider });",
					'setCollab({ binding, provider }); Reflect.get(globalThis, "__frontendProbe")?.remember("editor", { editor, binding, provider, doc });',
				).replace(
					"doc.destroy();",
					'doc.destroy(); Reflect.get(globalThis, "__frontendProbe")?.release("editor");',
				);
			}
			if (id.endsWith("/apps/web/src/room-workspace.tsx")) {
				return code.replace(
					"setWire(socket);",
					'setWire(socket); Reflect.get(globalThis, "__frontendProbe")?.remember("room", { socket, conversationStore, questions, cardMeta, threads });',
				).replace(
					"socket.dispose();",
					'socket.dispose(); Reflect.get(globalThis, "__frontendProbe")?.release("room");',
				);
			}
		},
	};
}

export function installProbe() {
	let identities = new WeakMap<object, number>();
	let next = 0;
	let groups = new Map<string, Record<string, WeakRef<object>>>();
	let counts: Record<string, number> = {};
	let releases: Record<string, number> = {};
	Reflect.set(globalThis, "__frontendProbe", {
		remember(name: string, values: Record<string, object>) {
			counts[name] = (counts[name] ?? 0) + 1;
			groups.set(
				name,
				Object.fromEntries(Object.entries(values).map(([key, value]) => [key, new WeakRef(value)])),
			);
		},
		release(name: string) {
			releases[name] = (releases[name] ?? 0) + 1;
			groups.delete(name);
		},
		snapshot() {
			let ids: Record<string, number> = {};
			for (let [name, values] of groups) {
				for (let [key, reference] of Object.entries(values)) {
					let value = reference.deref();
					if (!value) continue;
					if (!identities.has(value)) identities.set(value, ++next);
					ids[`${name}.${key}`] = identities.get(value)!;
				}
			}
			return { ids, counts: { ...counts }, releases: { ...releases } };
		},
	});
}
