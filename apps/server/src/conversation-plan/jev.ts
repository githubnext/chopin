/**
 * Decision question and answer shapes shared by every caller. `noul` is a yes/no
 * probability. `decide` in ./decisions.ts sends them to the configured classifier.
 */
export type JevQuestion =
	| { type: "noul"; instructions: string; criteria?: { true: string; false: string } }
	| { type: "choice"; instructions: string; criteria: Record<string, string> }
	| { type: "score"; instructions: string; criteria: string[] };

export type JevAnswer =
	| { type: "noul"; noul: number }
	| { type: "choice"; choice: string; confidence: number; probabilities: Record<string, number> }
	| {
		type: "score";
		score: number;
		confidence: number;
		legend: Record<string, string>;
		/** Per-level distribution, when the classifier reported one. */
		probabilities?: Record<string, number>;
	};

export type JevRequest = {
	state: object | string | unknown[];
	questions: Record<string, JevQuestion>;
};
export type JevResult = {
	model: string;
	answers: Record<string, JevAnswer>;
	usage: { input_tokens: number; output_tokens: number };
	latencyMs: number;
};
