import { useEffect } from "react";

export function motionImmediately(dataset?: { motionInput?: string }): boolean {
	let source = dataset
		?? (typeof document === "undefined" ? undefined : document.documentElement.dataset);
	return source?.motionInput === "keyboard";
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
		return () => {
			window.removeEventListener("keydown", recordKeyboard, true);
			window.removeEventListener("pointerdown", recordPointer, true);
		};
	}, []);
}
