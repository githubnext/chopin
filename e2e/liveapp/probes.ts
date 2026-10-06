/** Test-only observation. These references never own or restore application state. */
export function lifetimeProbes() {
	return {
		name: "frontend-lifetime-probes",
		enforce: "pre" as const,
		transform(code: string, id: string) {
			if (id.endsWith("/apps/web/src/navigation-shell.tsx")) {
				return code.replace(
					'import("./document-search-dialog")',
					'import("./document-search-dialog").then(async module => { await Reflect.get(globalThis, "__frontendProbe")?.lazyReady(); return module; })',
				);
			}
			if (id.endsWith("/apps/web/src/main.tsx")) {
				return code.replace(
					"createRoot(root)",
					'(value => { Reflect.get(globalThis, "__frontendProbe")?.remember("reactRoot", { value }); return value; })(createRoot(root))',
				);
			}
			if (id.endsWith("/packages/editor/src/widgets/index.ts")) {
				return code.replace(
					"registered = true;",
					'registered = true; Reflect.get(globalThis, "__frontendProbe")?.record("registration");',
				);
			}
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
	let lazy: Promise<void> | undefined, releaseLazy: (() => void) | undefined, waiting = false;
	Reflect.set(globalThis, "__frontendProbe", {
		blockLazy() {
			lazy = new Promise<void>(resolve => {
				releaseLazy = resolve;
			});
		},
		async lazyReady() {
			waiting = true;
			await lazy;
			waiting = false;
		},
		lazyWaiting: () => waiting,
		releaseLazy() {
			releaseLazy?.();
			lazy = undefined;
		},
		record(name: string) {
			counts[name] = (counts[name] ?? 0) + 1;
		},
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
			let editor = groups.get("editor")?.editor?.deref() as {
				_listeners: Record<string, Set<unknown>>;
			} | undefined;
			let provider = groups.get("editor")?.provider?.deref() as { epoch: string } | undefined;
			let listeners = Object.fromEntries(
				Object.entries(editor?._listeners ?? {}).map(([key, value]) => [key, value.size]),
			);
			return {
				ids,
				counts: { ...counts },
				releases: { ...releases },
				listeners,
				epoch: provider?.epoch,
			};
		},
	});
}
