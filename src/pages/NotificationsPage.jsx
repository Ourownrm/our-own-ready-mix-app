import { useEffect, useState } from "react";
import { TopBar } from "../lib/TopBar.jsx";
import { apiRequest } from "../lib/api.js";

const TYPE_LABEL = {
  breakdown_reported: "Breakdown reported", concrete_rejected: "Concrete rejected",
  driver_off_duty_during_trip: "Driver off duty mid-trip", qc_flagged_delay: "QC flagged delay",
  truck_delayed_2hrs: "Truck over 2 hours at site", no_rate_on_file: "No rate on file",
  pump_departure_overdue: "Pump departure overdue", batching_not_started: "Batching not started",
  compliance_alert: "Compliance alert", delivery_note_created: "Delivery note created",
  work_marked_complete: "Work marked completed", batching_delay_after_site_ready: "Batching delayed after site ready",
};

export default function NotificationsPage() {
  const [notifications, setNotifications] = useState([]);
  const [filter, setFilter] = useState("all"); // all | unread
  const [error, setError] = useState("");

  async function load() {
    try {
      setNotifications(await apiRequest("/notifications"));
    } catch (err) {
      setError(err.message);
    }
  }
  useEffect(() => { load(); }, []);

  const rows = filter === "unread" ? notifications.filter((n) => !n.is_read) : notifications;
  const unreadCount = notifications.filter((n) => !n.is_read).length;

  async function markRead(id) {
    try {
      await apiRequest(`/notifications/${id}/read`, { method: "POST" });
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function markAllRead() {
    try {
      await apiRequest("/notifications/mark-all-read", { method: "POST" });
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function remove(id) {
    if (!window.confirm("Delete this notification?")) return;
    try {
      await apiRequest(`/notifications/${id}`, { method: "DELETE" });
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <>
      <TopBar title="Notifications" />
      <div style={{ maxWidth: 700, margin: "0 auto", padding: "0 16px 32px" }}>
        {error && <div style={{ color: "var(--alert-red)", fontSize: 13, marginBottom: 12 }}>{error}</div>}
        <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
          <button className={`btn-tab ${filter === "all" ? "active" : ""}`} onClick={() => setFilter("all")}>All ({notifications.length})</button>
          <button className={`btn-tab ${filter === "unread" ? "active" : ""}`} onClick={() => setFilter("unread")}>Unread ({unreadCount})</button>
          {unreadCount > 0 && <button onClick={markAllRead}>Mark all read</button>}
        </div>
        <div className="card">
          {rows.length === 0 ? (
            <div style={{ fontSize: 13, color: "var(--slate)" }}>Nothing here.</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {rows.map((n) => (
                <div
                  key={n.id}
                  style={{
                    background: n.is_read ? "var(--concrete)" : "var(--amber-bg)",
                    borderRadius: 8, padding: 10, fontSize: 13,
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
                    <div>
                      <div style={{ fontWeight: 600 }}>{TYPE_LABEL[n.type] || n.type}</div>
                      <div style={{ marginTop: 2 }}>{n.message}</div>
                      {n.manager_response && <div style={{ marginTop: 4, color: "var(--slate)" }}>Response: {n.manager_response}</div>}
                      <div style={{ color: "var(--slate)", fontSize: 11, marginTop: 4 }}>
                        {new Date(n.created_at).toLocaleString([], { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}
                      </div>
                    </div>
                    <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                      {!n.is_read && <button style={{ fontSize: 11, padding: "3px 8px" }} onClick={() => markRead(n.id)}>Mark read</button>}
                      <button className="btn-danger" style={{ fontSize: 11, padding: "3px 8px" }} onClick={() => remove(n.id)}>Delete</button>
                    </div>
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
