import { researchInlineContract1 } from "./research-inline-contract-1";
import { researchInlineContract2 } from "./research-inline-contract-2";
import { researchInlineContract3 } from "./research-inline-contract-3";
import { researchInlineContract4 } from "./research-inline-contract-4";
import { researchInlineContract5 } from "./research-inline-contract-5";
import { researchInlineContract6 } from "./research-inline-contract-6";
import type { StorageFactory as Factory } from "./contract-support";

export function researchInlineContract(factory: Factory): void {
	researchInlineContract1(factory);
	researchInlineContract2(factory);
	researchInlineContract3(factory);
	researchInlineContract4(factory);
	researchInlineContract5(factory);
	researchInlineContract6(factory);
}
