import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { apiRequest } from "../lib/api.js";
import { TopBar } from "../lib/TopBar.jsx";
import { useAuth } from "../lib/AuthContext.jsx";
import { PieChart } from "../lib/PieChart.jsx";
import ProductionChart from "../lib/ProductionChart.jsx";
import RawMaterialStockCard from "../lib/RawMaterialStockCard.jsx";
import ComplianceAlertsCard from "../lib/ComplianceAlertsCard.jsx";
import { GroupedMenu } from "../lib/GroupedMenu.jsx";

export default function Reports() {
  const [data, setData] = useState(null);
  const [onDutySales, setOnDutySales] = useState([]);
  const [error, setError] = useState("");
  const { user } = useAuth();

  async function load() {
    try {
      const [d, s] = await Promise.all([
        apiRequest("/reports/director-dashboard"),
        apiRequest("/sales/on-duty"),
      ]);
      setData(d);
      setOnDutySales(s);
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => {
    load();
    const interval = setInterval(load, 60000);
    return () => clearInterval(interval);
  }, []);

  return (
    <>
      <TopBar title="Reports & Director's Dashboard" />
      <div style={{ maxWidth: 1000, margin: "0 auto", padding: "0 16px 32px" }}>
        {user?.role === "administrator" && (
          <div style={{ marginBottom: 16, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <Link to="/manager"><button type="button">View Manager Dashboard</button></Link>
            <Link to="/administrator"><button type="button">Users and roles</button></Link>
            <Link to="/notifications"><button type="button">Notifications</button></Link>
            <GroupedMenu
              label="Reports"
              items={[
                { label: "Production Report", to: "/production-report" },
                { label: "Time cross check", to: "/trip-time-crosscheck" },
                { label: "Equipment Breakdowns", to: "/breakdowns" },
                { label: "Fuel and Lubricant report", to: "/fuel-report" },
                { label: "Trip Allowance report", to: "/trip-allowance-report" },
                { label: "Statutory Compliance", to: "/compliance" },
                { label: "Delay justification report", to: "/delay-justification-report" },
              ]}
            />
            <GroupedMenu
              label="Masters"
              items={[
                { label: "Customer", to: "/administrator?view=customers" },
                { label: "Projects & Sites", to: "/administrator?view=sites" },
                { label: "Concrete Grade & Rates", to: "/administrator?view=rates" },
                { label: "Trucks and Pumps", to: "/administrator?view=fleet" },
                { label: "Sales Persons", to: "/administrator?view=salespersons" },
                { label: "Fuel Stations and Equipment's", to: "/administrator?view=fuel" },
              ]}
            />
            <GroupedMenu
              label="Sales"
              items={[
                { label: "Sales Performance", to: "/sales-performance" },
                { label: "Sales Forecast", to: "/sales-forecast" },
                { label: "Assign a Lead", to: "/administrator?view=assign-lead" },
                { label: "Browse Leads", to: "/leads" },
                { label: "Customer Feed Back", to: "/customer-feedback" },
              ]}
            />
            <GroupedMenu
              label="Manage"
              items={[
                { label: "Correct Order", to: "/administrator?view=orders" },
                { label: "Correct Tickets", to: "/administrator?view=tickets" },
              ]}
            />
          </div>
        )}
        {error && <div style={{ color: "var(--alert-red)", fontSize: 13, marginBottom: 12 }}>{error}</div>}
        {!data ? (
          <div style={{ fontSize: 13, color: "var(--slate)" }}>Loading...</div>
        ) : (
          <>
            {/* 1. Daily production chart */}
            <ProductionChart />

            {/* 2. KPIs */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12, marginBottom: 20 }}>
              <Kpi label="Order qty today" value={`${data.order_qty_today} m³`} />
              <Kpi label="Supplied qty today" value={`${data.supplied_qty_today} m³`} />
              <Kpi label="Monthly production qty" value={`${data.monthly_production_qty} m³`} />
              <Kpi label="Sales today" value={inr(data.sales_today)} />
              <Kpi label="Sales this month" value={inr(data.sales_month)} />
              <Kpi label="Collected today" value={inr(data.collected_today)} />
              <Kpi label="Collected this month" value={inr(data.collected_month)} />
              <Kpi label="Total outstanding" value={inr(data.total_outstanding)} danger={Number(data.total_outstanding) > 0} />
            </div>

            {/* 3. Running orders */}
            <Section title="Running orders — supplied vs balance">
              <SimpleTable
                rows={data.running_orders}
                columns={[
                  ["customer_name", "Customer"], ["site_name", "Site"], ["mix_grade_name", "Grade"],
                  [(r) => `${r.order_quantity_m3} m³`, "Ordered"],
                  [(r) => `${r.supplied_qty_m3} m³`, "Supplied"],
                  [(r) => `${r.balance_qty_m3} m³`, "Balance"],
                ]}
                empty="No running orders."
              />
            </Section>

            {/* 4. Upcoming orders */}
            <Section title="Upcoming orders">
              <SimpleTable
                rows={data.upcoming_orders}
                columns={[
                  [(r) => new Date(r.order_date).toLocaleDateString([], { day: "2-digit", month: "short", year: "numeric" }), "Date"],
                  ["customer_name", "Customer"], ["site_name", "Site"],
                  ["mix_grade_name", "Grade"], [(r) => `${r.order_quantity_m3} m³`, "Quantity"],
                ]}
                empty="Nothing scheduled beyond today/tomorrow."
              />
            </Section>

            {/* 5. Outstanding aging */}
            <Section title="Outstanding — aging report (by customer)">
              {data.outstanding_aging.length === 0 ? (
                <div style={{ fontSize: 13, color: "var(--slate)" }}>Nothing outstanding.</div>
              ) : (
                <div style={{ overflowX: "auto" }}>
                <table>
                  <thead>
                    <tr><th>Customer</th><th>0–7 days</th><th>8–14 days</th><th>15–30 days</th><th>30+ days</th><th>Total</th></tr>
                  </thead>
                  <tbody>
                    {data.outstanding_aging.map((r, i) => (
                      <tr key={i}>
                        <td>{r.customer_name}</td>
                        <td>{Number(r.bucket_0_7) > 0 ? inr(r.bucket_0_7) : ""}</td>
                        <td>{Number(r.bucket_8_14) > 0 ? inr(r.bucket_8_14) : ""}</td>
                        <td>{Number(r.bucket_15_30) > 0 ? inr(r.bucket_15_30) : ""}</td>
                        <td style={Number(r.bucket_30_plus) > 0 ? { color: "var(--alert-red)", fontWeight: 600 } : undefined}>{Number(r.bucket_30_plus) > 0 ? inr(r.bucket_30_plus) : ""}</td>
                        <td style={{ fontWeight: 600 }}>{inr(r.total_outstanding)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                </div>
              )}
            </Section>

            {/* 6. Raw material stock */}
            <RawMaterialStockCard />

            {/* On-duty Sales Executives */}
            <OnDutySalesTable salespeople={onDutySales} />

            {data.unbilled_deliveries_month && data.unbilled_deliveries_month.length > 0 && (
              <div className="card" style={{ marginBottom: 20, borderLeft: "3px solid var(--alert-red)", background: "var(--alert-red-bg, #FBEAEA)" }}>
                <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>
                  Unbilled deliveries this month
                  <span className="badge badge-danger" style={{ marginLeft: 8 }}>
                    {data.unbilled_deliveries_month.reduce((s, r) => s + Number(r.qty), 0)} m³
                  </span>
                </div>
                <div style={{ fontSize: 11, color: "var(--slate)", marginBottom: 8 }}>
                  Delivered but never invoiced — usually means no rate is on file for that customer/grade.
                  This is real, uncollected revenue, and it's why "Sales this month" can be lower than actual
                  production — check Concrete grades and rates for these customers.
                </div>
                <SimpleTable
                  rows={data.unbilled_deliveries_month}
                  columns={[
                    ["ticket_number", "DC No."], ["customer_name", "Customer"], ["site_name", "Site"],
                    [(r) => formatDate(r.ticket_date), "Date"], [(r) => `${r.qty} m³`, "Quantity"],
                    ["likely_reason", "Why"],
                  ]}
                  empty=""
                />
              </div>
            )}

            {/* 7. Sales this month by customer */}
            <Section title="Sales this month, by customer">
              <SimpleTable
                rows={data.sales_by_customer_month}
                columns={[["customer_name", "Customer"], [(r) => `${r.total_qty_m3} m³`, "Quantity"], [(r) => inr(r.total), "Sales value"]]}
                empty="No invoiced sales this month yet."
                rowLink={(r) => r.customer_id ? `/production-report?customer_id=${r.customer_id}&from_date=${monthStartStr()}&to_date=${todayStr()}` : null}
              />
            </Section>

            {/* 8. Sales this month by salesman */}
            <Section title="Salesman-wise sales this month">
              <PieChart
                data={data.salesman_monthly.map((r) => ({ label: r.salesman, value: r.total_qty_m3 }))}
                valueLabel={(v) => `${v} m³`}
                monochromeHue={210}
              />
            </Section>

            {/* 9. Pump utilization */}
            <Section title="Pump utilization this month">
              <PieChart
                data={data.pump_utilization_month.map((r) => ({ label: r.pump_type === "none" ? "Without pump" : `${r.pump_code} (${r.pump_type})`, value: r.total_qty_m3 }))}
                valueLabel={(v) => `${v} m³`}
                monochromeHue={165}
              />
            </Section>

            {/* 10. Concrete rejection */}
            <Section title="Concrete rejections this month">
              <SimpleTable
                rows={data.rejections_month}
                columns={[["reason", "Reason"], ["occurrences", "Occurrences"], [(r) => `${r.total_qty_m3} m³`, "Quantity rejected"]]}
                empty="No rejections recorded this month."
              />
            </Section>

            <ComplianceAlertsCard />
          </>
        )}
      </div>
    </>
  );
}

function Kpi({ label, value, danger }) {
  return (
    <div className="kpi">
      <div className="kpi-label">{label}</div>
      <div className={`kpi-value ${danger ? "danger" : ""}`} style={{ fontSize: 18 }}>{value}</div>
    </div>
  );
}

function Section({ title, children }) {
  return (
    <div className="card" style={{ marginBottom: 20 }}>
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>{title}</div>
      {children}
    </div>
  );
}

function SimpleTable({ rows, columns, empty, rowLink }) {
  if (!rows || rows.length === 0) {
    return <div style={{ fontSize: 13, color: "var(--slate)" }}>{empty}</div>;
  }
  return (
    <div style={{ overflowX: "auto" }}>
      <table>
        <thead>
          <tr>{columns.map(([, label], i) => <th key={i}>{label}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>
              {columns.map(([key], j) => {
                const content = typeof key === "function" ? key(row) : row[key] ?? "–";
                return (
                  <td key={j}>
                    {rowLink && j === 0 && rowLink(row) ? <Link to={rowLink(row)}>{content}</Link> : content}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function monthStartStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function formatDate(d) {
  if (!d) return "–";
  return new Date(d).toLocaleDateString([], { day: "2-digit", month: "short", year: "numeric" });
}

function inr(value) {
  const n = Number(value || 0);
  return `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
}

function minutesAgo(isoTime) {
  const mins = Math.max(0, Math.round((Date.now() - new Date(isoTime).getTime()) / 60000));
  return mins < 1 ? "just now" : `${mins} min ago`;
}
function formatTime(isoTime) {
  if (!isoTime) return "–";
  return new Date(isoTime).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function OnDutySalesTable({ salespeople }) {
  return (
    <div className="card" style={{ marginBottom: 20 }}>
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>On-duty Sales Executives</div>
      {salespeople.length === 0 ? (
        <div style={{ fontSize: 13, color: "var(--slate)" }}>No Sales Executives currently on duty.</div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table>
            <thead>
              <tr><th>Sales Executive</th><th>On duty since</th><th>Last location</th></tr>
            </thead>
            <tbody>
              {salespeople.map((s) => (
                <tr key={s.salesperson_user_id}>
                  <td>{s.salesperson_name}</td>
                  <td>{formatTime(s.duty_since)}</td>
                  <td>
                    {s.latitude ? (
                      <a href={`https://maps.google.com/?q=${s.latitude},${s.longitude}`} target="_blank" rel="noreferrer">
                        View location ({minutesAgo(s.recorded_at)})
                      </a>
                    ) : (
                      <span style={{ color: "var(--slate)" }}>No GPS yet</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
