import { z } from "zod";
import type { CardToolRoom } from "./card-tool-context";

export let cardToolSchema = z.object({
	room: z.custom<CardToolRoom>(value =>
		!!value && typeof value === "object"
		&& typeof (value as CardToolRoom).id === "string" && !!(value as CardToolRoom).plan
	),
});

export async function answer(name: string, produce: () => unknown): Promise<string> {
	try {
		return JSON.stringify(await produce(), null, 2) ?? "null";
	} catch (err) {
		let message = err instanceof Error ? err.message : String(err);
		console.error(`[agent/${name}]`, err);
		return `Error: ${message}`;
	}
}
