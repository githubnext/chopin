import { type Result, type Snapshot, validateDefinition, validateSnapshot } from "./controls";
import type { PreviewDefinition } from "./controls";

export type Preview = Readonly<{
	definition: PreviewDefinition;
	apply: (values: unknown) => Promise<Result<Snapshot>>;
	reset: () => Promise<Result<Snapshot>>;
}>;

// Completion reports the renderer callback's outcome, not browser paint.
export function createPreview(
	input: unknown,
	render: (values: Snapshot) => void | Promise<void>,
): Result<Preview> {
	let validated = validateDefinition(input);
	if (!validated.ok) return validated;
	let definition = validated.value;
	let pending = Promise.resolve();
	let apply = (input: unknown): Promise<Result<Snapshot>> => {
		let snapshot = validateSnapshot(definition, input);
		if (!snapshot.ok) return Promise.resolve(snapshot);
		// Preserve request order even when a renderer awaits asynchronous work.
		let application = pending.then(async (): Promise<Result<Snapshot>> => {
			try {
				await render(snapshot.value);
				return snapshot;
			} catch (error) {
				return {
					ok: false,
					error: {
						code: "render",
						message: error instanceof Error ? error.message : "Renderer failed.",
					},
				};
			}
		});
		pending = application.then(() => {});
		return application;
	};
	return {
		ok: true,
		value: Object.freeze({ definition, apply, reset: () => apply(definition.baseline) }),
	};
}
