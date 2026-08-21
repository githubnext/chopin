import { useEffect } from "react";

export function motionInput(type: string): "keyboard" | "pointer" | undefined {
	return type === "keydown" ? "keyboard" : type === "pointerdown" ? "pointer" : undefined;
}

export function useMotionInput(): void {
	useEffect(() => {
		let record = (event: Event) => {
			let input = motionInput(event.type);
			if (input) document.documentElement.dataset.motionInput = input;
		};
		window.addEventListener("keydown", record, true);
		window.addEventListener("pointerdown", record, true);
		return () => {
			window.removeEventListener("keydown", record, true);
			window.removeEventListener("pointerdown", record, true);
		};
	}, []);
}
