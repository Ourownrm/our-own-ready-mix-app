import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { apiRequest } from "../lib/api.js";
import { TopBar } from "../lib/TopBar.jsx";
import { useAuth } from "../lib/AuthContext.jsx";
import ProductionChart from "../lib/ProductionChart.jsx";
import RawMaterialStockCard from "../lib/RawMaterialStockCard.jsx";

export default function Reports() {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const { user } = useAuth();

  async function load() {
    try {
      setData(await apiRequest("/reports/director-dashboard"));
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
          <div style={{ marginBottom: 16, display: "flex", gap: 8, flexWrap: "wrap" }}>
            <Link to="/administrator"><button type="button">Manage users, customers, sites, fleet, rates...</button></Link>
            <Link to="/production-report"><button type="button">Production report</button></Link>
            <Link to="/manager"><button type="button">View Manager Dashboard</button></Link>
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
                        <td>{inr(r.bucket_0_7)}</td>
                        <td>{inr(r.bucket_8_14)}</td>
                        <td>{inr(r.bucket_15_30)}</td>
                        <td style={Number(r.bucket_30_plus) > 0 ? { color: "var(--alert-red)", fontWeight: 600 } : undefined}>{inr(r.bucket_30_plus)}</td>
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

            {/* 7. Sales this month by customer */}
            <Section title="Sales this month, by customer">
              <SimpleTable
                rows={data.sales_by_customer_month}
                columns={[["customer_name", "Customer"], [(r) => `${r.total_qty_m3} m³`, "Quantity"], [(r) => inr(r.total), "Sales value"]]}
                empty="No invoiced sales this month yet."
              />
            </Section>

            {/* 8. Sales this month by salesman */}
            <Section title="Salesman-wise sales this month">
              <SimpleTable
                rows={data.salesman_monthly}
                columns={[["salesman", "Salesman"], [(r) => `${r.total_qty_m3} m³`, "Quantity"], [(r) => inr(r.total), "Sales value"]]}
                empty="No sales recorded this month."
              />
            </Section>

            {/* 9. Pump utilization */}
            <Section title="Pump utilization this month">
              <SimpleTable
                rows={data.pump_utilization_month}
                columns={[
                  ["pump_code", "Pump"], ["pump_type", "Type"],
                  ["deliveries", "Deliveries"], [(r) => `${r.total_qty_m3} m³`, "Total quantity"],
                ]}
                empty="No pump-assisted deliveries completed this month."
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

function SimpleTable({ rows, columns, empty }) {
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
              {columns.map(([key], j) => (
                <td key={j}>{typeof key === "function" ? key(row) : row[key] ?? "–"}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function inr(value) {
  const n = Number(value || 0);
  return `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
}
