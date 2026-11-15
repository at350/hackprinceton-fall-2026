import { live } from "./live";

// The store the dashboard reads. Every mode here is an agent mode (lib/mode.ts),
// so it is the live store; an engine for a non-agent mode would be chosen here.
export const store = live;
