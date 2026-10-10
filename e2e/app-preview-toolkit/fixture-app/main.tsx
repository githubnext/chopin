import { createRoot } from "react-dom/client";
import { BillingCard } from "./billing-card";
import "./theme.css";
createRoot(document.getElementById("app")!).render(<BillingCard />);
