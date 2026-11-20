import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";

const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SCRAM_ITERATIONS = 4096;

export function machineStoreName(machineId: string): string {
	if (CANONICAL_UUID.test(machineId)) return `m_${machineId.replaceAll("-", "")}`;
	return `m_x${createHash("sha256").update(machineId, "utf8").digest("hex").slice(0, 48)}`;
}

export function quotedIdentifier(name: string): string {
	if (!name || name.includes("\0")) throw new Error("an identifier can't be empty or hold NUL");
	return `"${name.replaceAll('"', '""')}"`;
}

export function quotedLiteral(value: string): string {
	if (value.includes("\0")) throw new Error("a literal can't hold NUL");
	return `'${value.replaceAll("'", "''")}'`;
}

export function newStorePassword(): string {
	return randomBytes(32).toString("base64url");
}

export function scramVerifier(password: string, salt = randomBytes(16)): string {
	let salted = pbkdf2Sync(password.normalize("NFKC"), salt, SCRAM_ITERATIONS, 32, "sha256");
	let clientKey = createHmac("sha256", salted).update("Client Key").digest();
	let storedKey = createHash("sha256").update(clientKey).digest();
	let serverKey = createHmac("sha256", salted).update("Server Key").digest();
	return `SCRAM-SHA-256$${SCRAM_ITERATIONS}:${salt.toString("base64")}$${
		storedKey.toString("base64")
	}:${serverKey.toString("base64")}`;
}
