import { describe, it } from "bun:test";

import { storageContract } from "../contract";
import { PostgresStorage } from "./adapter";

let url = process.env.TEST_DATABASE_URL;

if (url) {
	storageContract("postgres", () => new PostgresStorage(url));
} else {
	describe("postgres storage", () => {
		it.skip("needs TEST_DATABASE_URL", () => {});
	});
}
