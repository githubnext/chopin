import { modifyToolbar } from "@github-ui/playground/toolbar";
import {
	PlaygroundToolbarGroup,
	PlaygroundToolbarSelect,
} from "@github-ui/playground/toolbar-controls";
import { useToolPreference } from "@github-ui/playground/preferences";
import { demoId, demoPath, typingSpeed, typingSpeeds } from "./director";

function TypingSpeedControl() {
	let { value: speed, set: setSpeed } = useToolPreference(typingSpeed);
	return (
		<PlaygroundToolbarGroup>
			<PlaygroundToolbarSelect
				aria-label="Typing speed"
				value={String(speed)}
				onChange={event => setSpeed(Number(event.target.value))}
			>
				{typingSpeeds.map(value => <option key={value} value={value}>{value} WPM</option>)}
			</PlaygroundToolbarSelect>
		</PlaygroundToolbarGroup>
	);
}

export default modifyToolbar({
	demos: [
		{
			id: demoId,
			title: "Plan offline sync with Copilot",
			description:
				"Mira researches, drafts, decides, and builds a plan with her team and Copilot. Pausing during a beat rewinds that beat, and Play starts it again from its beginning.",
			path: demoPath,
		},
	],
	controls: [{ id: "chopin/typing-speed", Component: TypingSpeedControl }],
});
