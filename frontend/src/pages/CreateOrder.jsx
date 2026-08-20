import { useEffect, useState } from "react";
import { apiRequest } from "../lib/api.js";

const initialForm = {
  order_date: new Date().toISOString().slice(0, 10),
  scheduled_batching_time: "08:00",
  truck_dispatch_interval_minutes: 20,
  customer_id: "",
  site_id: "",
  mix_grade_id: "",
  pump_requirement: "without_pump",
  pump_id: "",
  site_technician_required: false,
  cube_samples_required: 3,
  assigned_pump_crew: "",
  assigned_site_supervisor_id: "",
  site_contact_number: "",
  order_quantity_m3: "",
  sales_representative_id: "",
  casting_location: "",
  specified_slump_mm: "",
  pump_departure_time: "",
  remarks: "",
};

export default function CreateOrder({ onDone }) {
  const [form, setForm] = useState(initialForm);
  const [customers, setCustomers] = useState([]);
  const [sites, setSites] = useState([]);
  const [mixGrades, setMixGrades] = useState([]);
  const [supervisors, setSupervisors] = useState([]);
  const [pumps, setPumps] = useState([]);
  const [salespersons, setSalespersons] = useState([]);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [rateInfo, setRateInfo] = useState(null);
  const [pumpChargeDecision, setPumpChargeDecision] = useState(null); // null | true | false
  const [partLoadDecision, setPartLoadDecision] = useState(null);

  // Site Contacts directory (round 96, item 7) — autofills from any contact
  // already on file for this exact customer+site, and saves a newly-typed
  // one so the next order for the same site has it available too.
  const [siteContacts, setSiteContacts] = useState([]);
  const [contactChoice, setContactChoice] = useState(""); // "" | a site_contacts id | "__new__"
  const [newContactName, setNewContactName] = useState("");

  useEffect(() => {
    Promise.all([
      apiRequest("/master/customers"),
      apiRequest("/master/sites"),
      apiRequest("/master/mix-grades"),
      apiRequest("/master/site-supervisors"),
      apiRequest("/master/pumps"),
      apiRequest("/master/salespersons"),
    ]).then(([c, s, m, sup, p, sp]) => {
      setCustomers(c); setSites(s); setMixGrades(m); setSupervisors(sup); setPumps(p); setSalespersons(sp);
    }).catch((err) => setError(err.message));
  }, []);

  // Loads full pricing info (rate, pump charges by type, part load) before
  // the order is even placed, rather than only discovering a gap after a
  // delivery completes with no invoice generated. Resets both confirmations
  // whenever the inputs that determine them change, so a stale decision
  // can't silently carry over onto a different customer/site/grade/qty.
  useEffect(() => {
    setPumpChargeDecision(null); setPartLoadDecision(null);
    if (!form.customer_id || !form.mix_grade_id || !form.site_id) { setRateInfo(null); return; }
    apiRequest(`/master/rate-check?customer_id=${form.customer_id}&mix_grade_id=${form.mix_grade_id}&site_id=${form.site_id}&date=${form.order_date}`)
      .then(setRateInfo)
      .catch(() => setRateInfo(null));
  }, [form.customer_id, form.mix_grade_id, form.site_id, form.order_date]);

  // Reload the contact list whenever customer+site changes, and reset the
  // in-progress selection — a contact picked for a different site shouldn't
  // silently carry over.
  useEffect(() => {
    setContactChoice(""); setNewContactName(""); set("site_contact_number", "");
    if (!form.customer_id || !form.site_id) { setSiteContacts([]); return; }
    apiRequest(`/master/site-contacts?customer_id=${form.customer_id}&site_id=${form.site_id}`)
      .then(setSiteContacts)
      .catch(() => setSiteContacts([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.customer_id, form.site_id]);

  function set(field, value) {
    setForm((f) => ({ ...f, [field]: value }));
  }

  function chooseContact(value) {
    setContactChoice(value);
    if (value === "__new__" || value === "") {
      set("site_contact_number", "");
      setNewContactName("");
    } else {
      const c = siteContacts.find((sc) => String(sc.id) === String(value));
      set("site_contact_number", c?.phone_number || "");
    }
  }

  const pumpChargeAmount = form.pump_requirement === "boom_pump" ? Number(rateInfo?.boom_pump_charge || 0) || null : form.pump_requirement === "line_pump" ? Number(rateInfo?.line_pump_charge || 0) || null : null;
  const pumpMinQty = form.pump_requirement === "boom_pump" ? rateInfo?.boom_pump_min_qty_m3 : rateInfo?.line_pump_min_qty_m3;
  const needsPumpDecision = form.pump_requirement !== "without_pump" && rateInfo;
  const partLoadThreshold = Number(rateInfo?.part_load_min_qty_m3 ?? 5);
  const partLoadShortfall = form.order_quantity_m3 ? partLoadThreshold - Number(form.order_quantity_m3) : 0;
  const needsPartLoadDecision = rateInfo && form.order_quantity_m3 && partLoadShortfall > 0;
  const partLoadAmount = needsPartLoadDecision && rateInfo?.part_load_charge_per_m3
    ? partLoadShortfall * Number(rateInfo.part_load_charge_per_m3) : 0;

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");
    if (!form.site_contact_number) {
      setError("Select a site contact on file, or add a new one.");
      return;
    }
    if (needsPumpDecision && pumpChargeDecision === null) {
      setError("Confirm whether the pump mobilization charge applies to this order.");
      return;
    }
    if (needsPartLoadDecision && partLoadDecision === null) {
      setError(`Confirm whether the part load charge applies — this order is below the ${partLoadThreshold} m³ minimum.`);
      return;
    }
    setSaving(true);
    try {
      await apiRequest("/orders", {
        method: "POST",
        body: {
          ...form,
          pump_charge_applicable: needsPumpDecision ? pumpChargeDecision : undefined,
          pump_charge_amount: needsPumpDecision && pumpChargeDecision ? pumpChargeAmount : 0,
          part_load_applicable: needsPartLoadDecision ? partLoadDecision : undefined,
          part_load_charge_amount: needsPartLoadDecision && partLoadDecision ? partLoadAmount : 0,
        },
      });
      // Save a newly-typed site contact to the directory so it's already on
      // file for the next order to this same customer+site — best-effort,
      // never blocks placing the order if it fails.
      if (contactChoice === "__new__" && form.site_contact_number) {
        apiRequest("/master/site-contacts", {
          method: "POST",
          body: {
            customer_id: form.customer_id, site_id: form.site_id,
            contact_name: newContactName.trim() || undefined,
            phone_number: form.site_contact_number,
          },
        }).catch(() => {});
      }
      onDone();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  const selectedSite = sites.find((s) => String(s.id) === String(form.site_id));

  return (
    <div className="card" style={{ maxWidth: 640, margin: "0 auto" }}>
      <div style={{ fontSize: 16, fontWeight: 500, marginBottom: 12 }}>Create customer order</div>
      <form onSubmit={handleSubmit} style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, fontSize: 13 }}>
        <Field label="Order date">
          <input type="date" value={form.order_date} onChange={(e) => set("order_date", e.target.value)} required />
        </Field>
        <Field label="Scheduled batching time">
          <input type="time" value={form.scheduled_batching_time} onChange={(e) => set("scheduled_batching_time", e.target.value)} required />
        </Field>
        <Field label="Truck dispatch interval (min)">
          <input type="number" value={form.truck_dispatch_interval_minutes} onChange={(e) => set("truck_dispatch_interval_minutes", e.target.value)} required />
        </Field>
        <Field label="Customer">
          <select value={form.customer_id} onChange={(e) => { set("customer_id", e.target.value); set("site_id", ""); }} required>
            <option value="">Select</option>
            {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </Field>
        <Field label="Project / site">
          <select value={form.site_id} onChange={(e) => set("site_id", e.target.value)} required disabled={!form.customer_id}>
            <option value="">{form.customer_id ? "Select" : "Select a customer first"}</option>
            {sites.filter((s) => String(s.customer_id) === String(form.customer_id)).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </Field>
        <Field label="Mix grade">
          <select value={form.mix_grade_id} onChange={(e) => set("mix_grade_id", e.target.value)} required>
            <option value="">Select</option>
            {mixGrades.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
        </Field>
        <Field label="Pump requirement">
          <select value={form.pump_requirement} onChange={(e) => set("pump_requirement", e.target.value)}>
            <option value="boom_pump">Boom pump</option>
            <option value="line_pump">Line pump</option>
            <option value="without_pump">Without pump</option>
          </select>
        </Field>
        {form.pump_requirement !== "without_pump" && (
          <Field label="Which pump">
            <select value={form.pump_id} onChange={(e) => set("pump_id", e.target.value)}>
              <option value="">Select</option>
              {pumps.filter((p) => p.pump_type === form.pump_requirement).map((p) => (
                <option key={p.id} value={p.id}>{p.pump_code}</option>
              ))}
            </select>
          </Field>
        )}
        <Field label="Site technician required">
          <select value={form.site_technician_required} onChange={(e) => set("site_technician_required", e.target.value === "true")}>
            <option value="false">No</option>
            <option value="true">Yes</option>
          </select>
        </Field>
        <Field label="Cube samples required">
          <input type="number" value={form.cube_samples_required} onChange={(e) => set("cube_samples_required", e.target.value)} />
        </Field>
        <Field label="Assigned pump crew">
          <input type="text" value={form.assigned_pump_crew} onChange={(e) => set("assigned_pump_crew", e.target.value)} />
        </Field>
        <Field label="Assigned site supervisor">
          <select value={form.assigned_site_supervisor_id} onChange={(e) => set("assigned_site_supervisor_id", e.target.value)}>
            <option value="">Select</option>
            {supervisors.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </Field>
        <Field label="Site contact">
          {siteContacts.length > 0 && (
            <select value={contactChoice} onChange={(e) => chooseContact(e.target.value)} style={{ marginBottom: contactChoice === "__new__" || contactChoice === "" ? 6 : 0 }}>
              <option value="">Select a contact on file</option>
              {siteContacts.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.contact_name}{c.role_label ? ` — ${c.role_label}` : ""} — {c.phone_number}
                </option>
              ))}
              <option value="__new__">+ Add a new contact</option>
            </select>
          )}
          {(siteContacts.length === 0 || contactChoice === "__new__") && (
            <div style={{ display: "flex", gap: 6 }}>
              <input
                type="text" placeholder="Name (optional)" value={newContactName}
                onChange={(e) => { setNewContactName(e.target.value); if (contactChoice !== "__new__") setContactChoice("__new__"); }}
                style={{ flex: 1 }}
              />
              <input
                type="tel" placeholder="Phone number" value={form.site_contact_number}
                onChange={(e) => { set("site_contact_number", e.target.value); if (contactChoice !== "__new__") setContactChoice("__new__"); }}
                required style={{ flex: 1 }}
              />
            </div>
          )}
        </Field>
        <Field label="Order quantity (m³)">
          <input type="number" value={form.order_quantity_m3} onChange={(e) => set("order_quantity_m3", e.target.value)} required />
        </Field>
        <Field label="Sales representative">
          <select
            value={form.sales_representative_id}
            onChange={async (e) => {
              if (e.target.value === "__add_new__") {
                const name = window.prompt("New salesperson's name:");
                if (name && name.trim()) {
                  try {
                    const sp = await apiRequest("/administrator/salespersons", { method: "POST", body: { name: name.trim() } });
                    setSalespersons((list) => [...list, sp].sort((a, b) => a.name.localeCompare(b.name)));
                    set("sales_representative_id", sp.id);
                  } catch (err) {
                    setError(err.message);
                  }
                }
                return;
              }
              set("sales_representative_id", e.target.value);
            }}
          >
            <option value="">Select</option>
            {salespersons.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            <option value="__add_new__">+ Add new salesperson...</option>
          </select>
        </Field>
        <Field label="Structure / casting location">
          <input type="text" value={form.casting_location} onChange={(e) => set("casting_location", e.target.value)} />
        </Field>
        <Field label="Specified Slump (mm)">
          <input type="number" min="0" step="1" value={form.specified_slump_mm} onChange={(e) => set("specified_slump_mm", e.target.value)} />
        </Field>
        <Field label="Pump departure time">
          <input type="time" value={form.pump_departure_time} onChange={(e) => set("pump_departure_time", e.target.value)} />
        </Field>

        <div style={{ gridColumn: "1 / -1" }}>
          <Field label="Remarks">
            <textarea rows={2} value={form.remarks} onChange={(e) => set("remarks", e.target.value)} />
          </Field>
        </div>

        {selectedSite?.trip_allowance_label && (
          <div style={{ gridColumn: "1 / -1", fontSize: 12, color: "var(--slate)" }}>
            Driver trip allowance for this site: {selectedSite.trip_allowance_label}
          </div>
        )}

        {rateInfo && !rateInfo.rate_exists && (
          <div style={{ gridColumn: "1 / -1", color: "var(--amber)", background: "var(--amber-bg)", padding: 10, borderRadius: 8, fontSize: 12 }}>
            No rate is on file for this customer, site, and grade combination as of this order date — deliveries won't generate invoices until one is added (Administrator/Manager → Concrete grades and rates).
          </div>
        )}

        {needsPumpDecision && (
          <div style={{ gridColumn: "1 / -1", background: "var(--amber-bg)", border: "1px solid var(--amber)", borderRadius: 8, padding: 10 }}>
            <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>Pump mobilization charge (required)</div>
            <div style={{ fontSize: 11, color: "var(--slate)", marginBottom: 8 }}>
              {form.pump_requirement === "boom_pump" ? "Boom" : "Line"} pump rate on file: {pumpChargeAmount ? `₹${pumpChargeAmount}` : "not set"}
              {pumpMinQty ? ` (usually applies below ${pumpMinQty} m³)` : ""}. Confirm whether it applies to this order.
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button type="button" onClick={() => setPumpChargeDecision(true)} style={pumpChargeDecision === true ? { background: "var(--rebar)", color: "#fff" } : undefined}>
                Applicable{pumpChargeAmount ? ` — ₹${pumpChargeAmount}` : ""}
              </button>
              <button type="button" onClick={() => setPumpChargeDecision(false)} style={pumpChargeDecision === false ? { background: "var(--rebar)", color: "#fff" } : undefined}>
                Not applicable
              </button>
            </div>
          </div>
        )}

        {needsPartLoadDecision && (
          <div style={{ gridColumn: "1 / -1", background: "var(--concrete)", border: "1px solid var(--border-strong, #ccc)", borderRadius: 8, padding: 10 }}>
            <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>Part load charge (required)</div>
            <div style={{ fontSize: 11, color: "var(--slate)", marginBottom: 8 }}>
              Minimum load is {partLoadThreshold} m³. This order is {form.order_quantity_m3} m³ — short by {partLoadShortfall.toFixed(2)} m³
              {rateInfo?.part_load_charge_per_m3 ? ` × ₹${rateInfo.part_load_charge_per_m3} = ₹${partLoadAmount.toFixed(2)}` : " (no part-load rate on file)"}.
              Confirm whether it applies — sometimes sending a part load is the company's own call.
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button type="button" onClick={() => setPartLoadDecision(true)} style={partLoadDecision === true ? { background: "var(--rebar)", color: "#fff" } : undefined}>
                Applicable{rateInfo?.part_load_charge_per_m3 ? ` — ₹${partLoadAmount.toFixed(2)}` : ""}
              </button>
              <button type="button" onClick={() => setPartLoadDecision(false)} style={partLoadDecision === false ? { background: "var(--rebar)", color: "#fff" } : undefined}>
                Not applicable
              </button>
            </div>
          </div>
        )}

        {rateInfo?.rate_exists && form.order_quantity_m3 && (
          <div style={{ gridColumn: "1 / -1", fontSize: 12, borderTop: "1px solid var(--concrete)", paddingTop: 8 }}>
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <span style={{ color: "var(--slate)" }}>Concrete ({form.order_quantity_m3} m³ × ₹{rateInfo.rate_per_m3})</span>
              <span>₹{(Number(form.order_quantity_m3) * Number(rateInfo.rate_per_m3)).toFixed(2)}</span>
            </div>
            {pumpChargeDecision === true && (
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span style={{ color: "var(--slate)" }}>Pump mobilization</span><span>₹{pumpChargeAmount}</span>
              </div>
            )}
            {partLoadDecision === true && (
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span style={{ color: "var(--slate)" }}>Part load charge</span><span>₹{partLoadAmount.toFixed(2)}</span>
              </div>
            )}
            <div style={{ display: "flex", justifyContent: "space-between", fontWeight: 600, borderTop: "1px solid var(--concrete)", marginTop: 4, paddingTop: 4 }}>
              <span>Estimated total</span>
              <span>
                ₹{(
                  Number(form.order_quantity_m3) * Number(rateInfo.rate_per_m3)
                  + (pumpChargeDecision === true ? Number(pumpChargeAmount || 0) : 0)
                  + (partLoadDecision === true ? partLoadAmount : 0)
                ).toFixed(2)}
              </span>
            </div>
          </div>
        )}

        {error && <div style={{ gridColumn: "1 / -1", color: "var(--alert-red)" }}>{error}</div>}

        <div style={{ gridColumn: "1 / -1", display: "flex", gap: 8 }}>
          <button type="submit" disabled={saving}>{saving ? "Saving..." : "Save order"}</button>
          <button type="button" onClick={onDone}>Cancel</button>
        </div>
      </form>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <div>
      <div style={{ color: "var(--slate)", marginBottom: 4 }}>{label}</div>
      <div className="field-input">{children}</div>
    </div>
  );
}
