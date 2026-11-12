/**
 * The e2e GitHub App's id and key, which a server under test mints a paired machine's GitHub
 * tokens with; e2e/github.ts plays GitHub for it and checks only the id. The key is made for each
 * run, as nothing outside it ever checks the signature.
 */
import { generateKeyPairSync } from "node:crypto";

export const GITHUB_APP_ENV = {
	GITHUB_APP_ID: "4242",
	GITHUB_APP_PRIVATE_KEY: generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({
		type: "pkcs8",
		format: "pem",
	}).toString(),
};
