export const CARD = "01K0N4TR8K7JGM4R1J7PW4R8YJ";
export const QUESTION = "01K0N4V4E7Y6P4MJ5WD8XZF3B2";
export const OPTION = "01K0N4W3B7P27CBAEC7A8C8WEA";

export function record(overrides: Record<string, unknown> = {}) {
	return {
		id: CARD,
		origin: "conversation",
		threadId: "thread-a",
		status: "answered",
		owner: "mina",
		decidedAt: 1_758_645_000,
		definition: { questions: [] },
		history: [],
		optionOrigins: {},
		editors: [],
		...overrides,
	} as never;
}
