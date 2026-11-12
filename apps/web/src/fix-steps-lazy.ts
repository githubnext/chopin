import { lazy } from "react";

/** The fix-it steps, loaded with their styles only once a machine has something to fix. */
export const loadFixSteps = () => import("./fix-steps");
export const LazyFixSteps = lazy(loadFixSteps);
