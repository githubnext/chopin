export type CardEvent =
	| { kind: "decided"; id: string; threadId?: string; actor: string; optionIds: string[] }
	| { kind: "reopened"; id: string; threadId?: string; actor: string }
	| { kind: "discarded"; id: string; threadId?: string; actor: string }
	| {
		kind: "option-added";
		id: string;
		threadId?: string;
		actor: string;
		optionId: string;
		label: string;
		origin: "chat" | "planner" | "human";
	};
