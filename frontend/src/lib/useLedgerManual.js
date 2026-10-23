// Round 235 — "Record payment" in the ledgers is off unless an Administrator
// allows it (Cost → Bank statements). Payments come from the bank statement
// lines and, for cash, from C Ledger.
import { useEffect, useState } from "react";
import { apiRequest } from "./api.js";

let cache = null;
export const LEDGER_PAY_NOTE = "Payments are entered from the bank statement (Cost → Bank statements) or, for cash, in C Ledger.";
export function useLedgerManual() {
  const [on, setOn] = useState(cache);
  useEffect(() => {
    let live = true;
    apiRequest("/cost/bank/ledger-settings").then((s) => { cache = !!s.manual_payments; if (live) setOn(cache); }).catch(() => { if (live) setOn(true); });
    return () => { live = false; };
  }, []);
  return on === true;   // until known: hidden
}
