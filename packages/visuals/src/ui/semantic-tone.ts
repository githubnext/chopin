export type SemanticTone = "neutral" | "success" | "warning" | "danger";

export function semanticClasses(base: string, className?: string) {
	return ["cv-semantic", base, className].filter(Boolean).join(" ");
}
