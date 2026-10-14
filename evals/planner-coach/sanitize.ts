import { createHash } from "node:crypto";

export function hash(value: string | Uint8Array): string {
	return createHash("sha256").update(value).digest("hex");
}

/** Preserve transcript content except credentials, including provider error messages. */
export function sanitizer(secrets: string[] = []) {
	return (value: unknown): string => {
		let text = typeof value === "string" ? value : value instanceof Error
			? `${value.name}: ${value.message}`
			: JSON.stringify(value, (_key, held) =>
				held instanceof Error
					? { name: held.name, message: held.message }
					: typeof held === "bigint"
					? String(held)
					: held);
		text ??= "null";
		for (let secret of secrets.filter(Boolean)) text = text.replaceAll(secret, "[REDACTED]");
		return text.replace(/\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)\b/g, "[REDACTED]")
			.replace(/Bearer\s+[^\s"\\]+/gi, "Bearer [REDACTED]");
	};
}
