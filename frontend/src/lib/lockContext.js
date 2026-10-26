// Round 243 — whether the app is under the emergency lock, for the header
// (it shows nothing but the title while locked). Set by LockdownGate.
import { createContext, useContext } from "react";
export const LockContext = createContext(false);
export const useLocked = () => useContext(LockContext);
