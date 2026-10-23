import { useEffect, useState } from "react";
import { modifyToolbar, navigatePage } from "@github-ui/playground/toolbar";
import {
	PlaygroundToolbarButton,
	PlaygroundToolbarGroup,
	PlaygroundToolbarLabel,
	PlaygroundToolbarSelect,
	PlaygroundToolbarStatus,
} from "@github-ui/playground/toolbar-controls";
import { useToolPreference } from "@github-ui/playground/preferences";
import {
	type DirectorAction,
	directorBridge,
	type DirectorState,
	typingSpeed,
	typingSpeeds,
} from "./director";
import { demoSlug, findPlan, planPath } from "./plans";

function send(action: DirectorAction) {
	directorBridge.sendAction(action);
}

function DirectorControl() {
	let [state, setState] = useState<DirectorState>(null);
	let { value: speed, set: setSpeed } = useToolPreference(typingSpeed);
	useEffect(() => directorBridge.subscribeState(setState), []);

	if (!state) {
		return (
			<PlaygroundToolbarGroup>
				<PlaygroundToolbarButton
					onClick={() => navigatePage(planPath(findPlan(demoSlug)!))}
				>
					Open demo plan
				</PlaygroundToolbarButton>
			</PlaygroundToolbarGroup>
		);
	}

	let total = state.labels.length;
	let finished = state.beat >= total;
	return (
		<PlaygroundToolbarGroup>
			<PlaygroundToolbarLabel>
				Beat
				<PlaygroundToolbarSelect
					value={state.beat}
					disabled={state.playing}
					onChange={event => send({ type: "jump", beat: Number(event.target.value) })}
				>
					{state.labels.map((label, index) => (
						<option key={label} value={index}>
							{index + 1}. {label}
						</option>
					))}
					<option value={total}>End of demo</option>
				</PlaygroundToolbarSelect>
			</PlaygroundToolbarLabel>
			{state.playing
				? (
					<>
						<PlaygroundToolbarStatus>
							{state.auto ? "Playing all" : `Playing beat ${state.beat + 1}`}
						</PlaygroundToolbarStatus>
						<PlaygroundToolbarButton onClick={() => send({ type: "stop" })}>
							Stop
						</PlaygroundToolbarButton>
					</>
				)
				: (
					<>
						<PlaygroundToolbarButton onClick={() => send({ type: "play-all" })}>
							{finished ? "Replay all" : state.beat === 0 ? "Play all" : "Play rest"}
						</PlaygroundToolbarButton>
						{!finished && (
							<PlaygroundToolbarButton onClick={() => send({ type: "play" })}>
								Play beat
							</PlaygroundToolbarButton>
						)}
					</>
				)}
			<PlaygroundToolbarButton onClick={() => send({ type: "reset" })}>
				Reset
			</PlaygroundToolbarButton>
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
	controls: [{ id: "chopin/director", Component: DirectorControl }],
});
