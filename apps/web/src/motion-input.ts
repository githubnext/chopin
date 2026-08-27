import { useEffect } from "react";

export function motionImmediately(
	dataset?: { motionInput?: string },
	prefersReducedMotion = typeof window !== "undefined"
		&& window.matchMedia("(prefers-reduced-motion: reduce)").matches,
): boolean {
	let source = dataset
		?? (typeof document === "undefined" ? undefined : document.documentElement.dataset);
	return source?.motionInput === "keyboard" || prefersReducedMotion;
}

export function useMotionInput(): void {
	useEffect(() => {
		let recordKeyboard = () => {
			document.documentElement.dataset.motionInput = "keyboard";
		};
		let recordPointer = () => {
			document.documentElement.dataset.motionInput = "pointer";
		};
		window.addEventListener("keydown", recordKeyboard, true);
		window.addEventListener("pointerdown", recordPointer, true);
		window.addEventListener("pointerover", recordPointer, true);
		return () => {
			window.removeEventListener("keydown", recordKeyboard, true);
			window.removeEventListener("pointerdown", recordPointer, true);
			window.removeEventListener("pointerover", recordPointer, true);
		};
	}, []);
}
