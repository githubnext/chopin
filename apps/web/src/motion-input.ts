import { useEffect } from "react";

type MotionFeedbackTarget = {
	dataset: { motionSettled?: string };
	matches: (selector: string) => boolean;
};

export function settleMotionFeedback(target?: MotionFeedbackTarget): void {
	if (!target?.matches(".motion-feedback[data-motion-feedback]")) return;
	target.dataset.motionSettled = "";
}

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
		let settleFeedback = (event: AnimationEvent) => {
			let target = event.target;
			if (target instanceof HTMLElement || target instanceof SVGElement) {
				settleMotionFeedback(target);
			}
		};
		window.addEventListener("keydown", recordKeyboard, true);
		window.addEventListener("pointerdown", recordPointer, true);
		window.addEventListener("pointerover", recordPointer, true);
		window.addEventListener("animationend", settleFeedback, true);
		return () => {
			window.removeEventListener("keydown", recordKeyboard, true);
			window.removeEventListener("pointerdown", recordPointer, true);
			window.removeEventListener("pointerover", recordPointer, true);
			window.removeEventListener("animationend", settleFeedback, true);
		};
	}, []);
}
