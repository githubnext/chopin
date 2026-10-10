import { createContext, type ReactNode, useContext } from "react";

let Units = createContext<string | undefined>(undefined);

export function UnitsProvider({ children }: { children: ReactNode }) {
	return <Units.Provider value="requests">{children}</Units.Provider>;
}

export function useUnits() {
	let units = useContext(Units);
	if (!units) throw new Error("UsageCard requires UnitsProvider.");
	return units;
}
