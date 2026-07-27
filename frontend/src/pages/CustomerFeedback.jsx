import { useEffect, useState } from "react";
import { TopBar } from "../lib/TopBar.jsx";
import { apiRequest } from "../lib/api.js";

export default function CustomerFeedback() {
  const [feedback, setFeedback] = useState([]);
  const [filter, setFilter] = useState("all"); // all | compliment | complaint
  const [error, setError] = useState("");

  useEffect(() => {
    apiRequest("/sales/feedback").then(setFeedback).catch((err) => setError(err.message));
  }, []);

  const rows = filter === "all" ? feedback : feedback.filter((f) => f.feedback_type === filter);
  const complaintCount = feedback.filter((f) => f.feedback_type === "complaint").length;

  return (
    <>
      <TopBar title="Customer Feedback" />
      <div style={{ maxWidth: 700, margin: "0 auto", padding: "0 16px 32px" }}>
        {error && <div style={{ color: "var(--alert-red)", fontSize: 13, marginBottom: 12 }}>{error}</div>}
        <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
          <button className={`btn-tab ${filter === "all" ? "active" : ""}`} onClick={() => setFilter("all")}>All ({feedback.length})</button>
          <button className={`btn-tab ${filter === "complaint" ? "active" : ""}`} onClick={() => setFilter("complaint")}>Complaints ({complaintCount})</button>
          <button className={`btn-tab ${filter === "compliment" ? "active" : ""}`} onClick={() => setFilter("compliment")}>Compliments ({feedback.length - complaintCount})</button>
        </div>
        <div className="card">
          {rows.length === 0 ? (
            <div style={{ fontSize: 13, color: "var(--slate)" }}>Nothing here yet — Sales Executives record this after visiting a site post-delivery.</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {rows.map((f) => (
                <div key={f.id} style={{ background: "var(--concrete)", borderRadius: 8, padding: 10, fontSize: 13 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <span style={{ fontWeight: 600 }}>{f.customer_name}</span>
                    <span className={`badge ${f.feedback_type === "complaint" ? "badge-danger" : "badge-success"}`}>{f.feedback_type}</span>
                  </div>
                  <div style={{ marginTop: 4 }}>{f.comment}</div>
                  <div style={{ color: "var(--slate)", fontSize: 11, marginTop: 4 }}>
                    {new Date(f.created_at).toLocaleDateString([], { day: "2-digit", month: "short", year: "numeric" })} &middot; Logged by {f.recorded_by_name}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
