import { CommentDiscussionIcon, RocketIcon } from "@primer/octicons-react";
import PlansIcon from "./plans-icon";
import { Avatar, AvatarStack, Banner, Label, UnderlineNav } from "@primer/react";
import { useNavigate } from "@github-ui/react-router";
import { type CSSProperties, useEffect, useRef } from "react";
import { Build } from "./build";
import { Conversation, Face } from "./conversation";
import { Decisions } from "./decisions";
import { attachDirector } from "./director";
import { PlanDocument } from "./plan-document";
import { avatarUrl, demoSlug, displayName, type Plan, planPath, type PlanStatus } from "./plans";
import styles from "./plans.module.css";
import { cursorColor } from "./remote-cursor";
import { openDecisions, planStore, type Tab, usePlanState } from "./store";

export let statusVariant: Record<PlanStatus, "secondary" | "accent" | "attention" | "done"> = {
	Draft: "secondary",
	"In review": "accent",
	Building: "attention",
	Shipped: "done",
};

export function PlanView({ plan, initialTab }: { plan: Plan; initialTab?: Tab }) {
	let store = planStore(plan.slug);
	let state = usePlanState(store);
	let open = openDecisions(state);
	let navigate = useNavigate();
	// The director outlives renders; a fresh navigate must not detach it mid-beat.
	let latestNavigate = useRef(navigate);
	latestNavigate.current = navigate;

	useEffect(() => {
		if (initialTab) store.set({ tab: initialTab });
	}, [initialTab, store]);

	useEffect(() => {
		if (plan.slug !== demoSlug) return;
		return attachDirector(store, path => latestNavigate.current(path));
	}, [plan.slug, store]);

	let tabs: { id: Tab; label: string; icon: typeof RocketIcon; counter?: number }[] = [
		{ id: "plan", label: "Plan", icon: PlansIcon },
		{
			id: "decisions",
			label: "Decisions",
			icon: CommentDiscussionIcon,
			counter: open || undefined,
		},
		{ id: "build", label: "Build", icon: RocketIcon, counter: state.tasks.length || undefined },
	];
	let humans = state.viewers.filter(login => login !== "copilot");

	return (
		<div className={styles.page}>
			<header className={styles.header}>
				<h1 className={styles.title}>
					{plan.title}
					<span className={styles.number}>&nbsp;#{plan.number}</span>
				</h1>
				<div className={styles.meta}>
					<Label variant={statusVariant[state.status]} size="large">
						{state.status}
					</Label>
					<span className={styles.presence} aria-label={`${state.viewers.length} viewing`}>
						<AvatarStack size={20}>
							{humans.map(login => <Avatar key={login} src={avatarUrl(login)} alt={login} />)}
						</AvatarStack>
						{state.viewers.includes("copilot") && <Face login="copilot" size={20} />}
						<span>{state.viewers.length} viewing</span>
					</span>
					{state.activity && (
						<span
							className={styles.activity}
							role="status"
							style={{ "--cursor-color": cursorColor(state.activity.login) } as CSSProperties}
						>
							<span className={styles.activityDot} />
							{state.activity.text}…
						</span>
					)}
				</div>
			</header>
			<div className={styles.columns}>
				<div className={styles.tabs}>
					<UnderlineNav aria-label="Plan sections">
						{tabs.map(tab => (
							<UnderlineNav.Item
								key={tab.id}
								href={planPath(plan, tab.id === "plan" ? undefined : tab.id)}
								icon={tab.icon}
								counter={tab.counter}
								aria-current={state.tab === tab.id ? "page" : undefined}
								onSelect={event => {
									event.preventDefault();
									store.set({ tab: tab.id });
								}}
							>
								{tab.label}
							</UnderlineNav.Item>
						))}
					</UnderlineNav>
				</div>
				<div className={styles.tabPanel}>
					{state.tab === "plan" && (
						<div className={styles.editorFrame}>
							{open > 0 && (
								<Banner
									layout="compact"
									variant="warning"
									title="Decision needed"
									description={`${open} ${
										open === 1 ? "decision needs" : "decisions need"
									} an answer before this plan can be built.`}
									primaryAction={
										<Banner.PrimaryAction onClick={() => store.set({ tab: "decisions" })}>
											Review
										</Banner.PrimaryAction>
									}
								/>
							)}
							<PlanDocument state={state} />
						</div>
					)}
					{state.tab === "decisions" && <Decisions store={store} />}
					{state.tab === "build" && <Build store={store} />}
				</div>
				<aside className={styles.aside} aria-label={`Conversation with ${displayName("copilot")}`}>
					<Conversation store={store} />
				</aside>
			</div>
		</div>
	);
}
