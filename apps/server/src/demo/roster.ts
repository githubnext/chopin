export type DemoActor = {
	readonly id: string;
	readonly name: string;
	readonly avatar: string;
};

const ACTORS: readonly DemoActor[] = Object.freeze([
	Object.freeze({ id: "demo:lily", name: "Lily", avatar: "/demo/lily.svg" }),
	Object.freeze({ id: "demo:felix", name: "Felix", avatar: "/demo/felix.svg" }),
]);

export type DemoRoster = {
	list(): readonly DemoActor[];
	get(id: string): DemoActor | undefined;
};

// Inert unless the validated local flag (AuthConfig.demoPersonas) is on.
export function demoRoster(config: { demoPersonas?: true }): DemoRoster {
	let enabled = config.demoPersonas === true;
	return {
		list: () => enabled ? ACTORS : [],
		get: id => enabled ? ACTORS.find(actor => actor.id === id) : undefined,
	};
}
