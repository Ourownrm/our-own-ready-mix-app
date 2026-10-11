// Round 204 — quotation follow-ups on the Manager and Administrator home
// screens (owner: follow-up of sent quotations is top priority), plus how many
// quotations wait for the Administrator's approval.
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { apiRequest } from "./api.js";
import { usePermissions } from "./PermissionContext.jsx";
import { fmtDate } from "./quotationTerms.js";

export default function QuotationFollowupsCard() {
  const { can, ready } = usePermissions();
  const allowed = ready && can("accounts.quotations", "view");
  const canApprove = ready && can("accounts.quotation-approve", "edit");
  const [due, setDue] = useState(null);
  const [toApprove, setToApprove] = useState(0);

  useEffect(() => {
    if (!allowed) return;
    let alive = true;
    apiRequest("/quotations/followups").then((r) => { if (alive) setDue(r.filter((f) => f.overdue || f.due_today)); }).catch(() => {});
    if (canApprove) apiRequest("/quotations?status=pending_approval").then((r) => { if (alive) setToApprove(r.length); }).catch(() => {});
    return () => { alive = false; };
  }, [allowed, canApprove]);

  if (!allowed || due == null) return null;
  if (!due.length && !toApprove) return null;
  return (
    <div className="card" style={{ marginBottom: 16, borderLeft: "4px solid var(--rebar)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: due.length ? 8 : 0 }}>
        <div style={{ fontSize: 13, fontWeight: 700 }}>Quotation follow-ups</div>
        {due.length > 0 && <span className="badge badge-warning">{due.length} to call</span>}
        {toApprove > 0 && (
          <Link to="/accounts?tab=quotations" style={{ fontSize: 12 }}>{toApprove} waiting for your approval</Link>
        )}
        <Link to="/accounts?tab=quotations" style={{ marginLeft: "auto", fontSize: 12 }}>Open quotations →</Link>
      </div>
      {due.slice(0, 5).map((f) => (
        <Link key={f.id} to={`/accounts?tab=quotations&id=${f.id}`} style={{ display: "flex", gap: 8, fontSize: 12.5, padding: "4px 0", borderTop: "1px solid var(--border)", color: "inherit", textDecoration: "none" }}>
          <span style={{ fontWeight: 600 }}>{f.customer_name}</span>
          <span style={{ color: "var(--slate)" }}>{f.site_name} · {f.quote_no}</span>
          <span style={{ marginLeft: "auto", color: f.overdue ? "var(--alert-red)" : "var(--amber)", whiteSpace: "nowrap" }}>
            {f.status === "approved" ? "send it" : f.overdue ? `since ${fmtDate(f.due_on)}` : "today"}
          </span>
        </Link>
      ))}
      {due.length > 5 && <div style={{ fontSize: 12, color: "var(--slate)", marginTop: 4 }}>and {due.length - 5} more</div>}
    </div>
  );
}
