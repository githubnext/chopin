import type { Frame } from "./index";
export declare namespace Experiment {
	export type Changed = Frame & { kind: "experiment:changed"; documentId: string };
}
