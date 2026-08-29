import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { apiRequest } from "./api.js";
import { estimateTravelMinutes, suggestBatchingTime } from "./travelEstimate.js";

export function CreateLeadForm({ setError, onDone }) {
  const [salesExecs, setSalesExecs] = useState([]);
  const [form, setForm] = useState({
    prospect_name: "", contact_person: "", contact_phone: "",
    site_location: "", mix_grade_interest: "", estimated_qty_m3: "", assigned_to: "",
    site_latitude: "", site_longitude: "",
  });
  const [saving, setSaving] = useState(false);
  const [locating, setLocating] = useState(false);

  useEffect(() => {
    apiRequest("/master/sales-executives").then(setSalesExecs).catch((err) => setError(err.message));
  }, []);

  function useCurrentLocation() {
    setLocating(true);
    navigator.geolocation?.getCurrentPosition(
      (pos) => {
        setForm((f) => ({ ...f, site_latitude: pos.coords.latitude.toFixed(7), site_longitude: pos.coords.longitude.toFixed(7) }));
        setLocating(false);
      },
      () => { setError("Couldn't get current location — enter coordinates manually, or paste from Google Maps."); setLocating(false); }
    );
  }

  async function submit(e) {
    e.preventDefault();
    setSaving(true); setError("");
    try {
      await apiRequest("/sales/leads", { method: "POST", body: form });
      setForm({ prospect_name: "", contact_person: "", contact_phone: "", site_location: "", mix_grade_interest: "", estimated_qty_m3: "", assigned_to: "", site_latitude: "", site_longitude: "" });
      if (onDone) onDone();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="field-input card" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, fontSize: 13 }}>
      <div><div style={{ color: "var(--slate)" }}>Prospect name</div><input value={form.prospect_name} onChange={(e) => setForm({ ...form, prospect_name: e.target.value })} required /></div>
      <div>
        <div style={{ color: "var(--slate)" }}>Assign to</div>
        <select value={form.assigned_to} onChange={(e) => setForm({ ...form, assigned_to: e.target.value })} required>
          <option value="">Select salesperson</option>
          {salesExecs.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      </div>
      <div><div style={{ color: "var(--slate)" }}>Contact person</div><input value={form.contact_person} onChange={(e) => setForm({ ...form, contact_person: e.target.value })} /></div>
      <div><div style={{ color: "var(--slate)" }}>Contact phone</div><input value={form.contact_phone} onChange={(e) => setForm({ ...form, contact_phone: e.target.value })} /></div>
      <div><div style={{ color: "var(--slate)" }}>Site / location (text)</div><input value={form.site_location} onChange={(e) => setForm({ ...form, site_location: e.target.value })} /></div>
      <div><div style={{ color: "var(--slate)" }}>Grade interested in</div><input value={form.mix_grade_interest} onChange={(e) => setForm({ ...form, mix_grade_interest: e.target.value })} placeholder="e.g. M25" /></div>
      <div><div style={{ color: "var(--slate)" }}>Estimated qty (m³)</div><input type="number" value={form.estimated_qty_m3} onChange={(e) => setForm({ ...form, estimated_qty_m3: e.target.value })} /></div>
      <div></div>
      <div><div style={{ color: "var(--slate)" }}>Site latitude</div><input type="number" step="any" value={form.site_latitude} onChange={(e) => setForm({ ...form, site_latitude: e.target.value })} placeholder="e.g. 8.5241" /></div>
      <div><div style={{ color: "var(--slate)" }}>Site longitude</div><input type="number" step="any" value={form.site_longitude} onChange={(e) => setForm({ ...form, site_longitude: e.target.value })} placeholder="e.g. 76.9366" /></div>
      <div style={{ gridColumn: "1 / -1" }}>
        <button type="button" onClick={useCurrentLocation} disabled={locating} style={{ fontSize: 12, padding: "6px 10px" }}>
          {locating ? "Getting location..." : "Use my current location"}
        </button>
        <span style={{ fontSize: 11, color: "var(--slate)", marginLeft: 8 }}>
          Or paste coordinates from Google Maps (long-press the pin on the site → copy the numbers shown)
        </span>
      </div>
      <div style={{ gridColumn: "1 / -1" }}><button type="submit" disabled={saving}>{saving ? "Saving..." : "Assign lead"}</button></div>
    </form>
  );
}

const PUMP_LABELS = { boom_pump: "Boom pump", line_pump: "Line pump", without_pump: "Without pump" };

export function BookingsQueue({ setError }) {
  const [bookings, setBookings] = useState([]);
  const [converting, setConverting] = useState(null);

  async function load() {
    try {
      setBookings(await apiRequest("/sales/bookings"));
    } catch (err) {
      setError(err.message);
    }
  }
  useEffect(() => { load(); }, []);

  async function decline(id) {
    const reason = window.prompt("Reason for declining this booking (optional):");
    if (reason === null) return;
    setError("");
    try {
      await apiRequest(`/sales/bookings/${id}/decline`, { method: "POST", body: { declined_reason: reason } });
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  if (converting) {
    return (
      <ConvertBookingForm
        booking={converting}
        setError={setError}
        onDone={() => { setConverting(null); load(); }}
        onCancel={() => setConverting(null)}
      />
    );
  }

  const pending = bookings.filter((b) => b.status === "pending");

  return (
    <div className="card" style={{ marginBottom: 20 }}>
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>
        Pending bookings
        {pending.length > 0 && <span className="badge badge-warning" style={{ marginLeft: 8 }}>{pending.length}</span>}
      </div>
      {pending.length === 0 ? (
        <div style={{ fontSize: 13, color: "var(--slate)" }}>No bookings waiting on you.</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {pending.map((b) => (
            <div key={b.id} style={{ background: "var(--concrete)", borderRadius: 8, padding: 10, fontSize: 13 }}>
              <div style={{ fontWeight: 600, display: "flex", alignItems: "center", gap: 6 }}>
                {b.customer_name}
                {b.booking_link_id && (
                  <span className="badge" style={{ background: "var(--info-bg)", color: "var(--info)", fontSize: 10 }}>Customer booking</span>
                )}
                {b.submitted_via_portal && (
                  <span className="badge" style={{ background: "var(--violet-bg, #ECE6F3)", color: "var(--violet, #6B4C9A)", fontSize: 10 }}>Order Concrete (portal)</span>
                )}
              </div>
              <div style={{ color: "var(--slate)" }}>
                {b.site_name || "Site TBD"} · {b.mix_grade_name || "Grade TBD"} · {b.estimated_qty_m3 ? `${b.estimated_qty_m3} m³` : "Qty TBD"}
                {b.preferred_date ? ` · Preferred: ${new Date(b.preferred_date).toLocaleDateString([], { day: "2-digit", month: "short" })}${b.preferred_time ? ` ${b.preferred_time.slice(0, 5)}` : ""}` : ""}
              </div>
              {b.pump_requirement && (
                <div style={{ color: "var(--slate)" }}>
                  Pump: {PUMP_LABELS[b.pump_requirement] || b.pump_requirement}
                  {b.casting_location ? ` · Casting location: ${b.casting_location}` : ""}
                </div>
              )}
              {(b.site_contact_name || b.site_contact_number) && (
                <div style={{ color: "var(--slate)" }}>
                  Site contact: {b.site_contact_name || "—"}{b.site_contact_number ? ` · ${b.site_contact_number}` : ""}
                </div>
              )}
              {(b.notes || b.remarks) && <div style={{ color: "var(--slate)", fontStyle: "italic" }}>"{b.notes || b.remarks}"</div>}
              {(b.site_latitude && b.site_longitude) && (
                <a href={`https://maps.google.com/?q=${b.site_latitude},${b.site_longitude}`} target="_blank" rel="noreferrer" style={{ fontSize: 12 }}>
                  View site location
                </a>
              )}
              <div style={{ color: "var(--slate)", fontSize: 11 }}>
                {b.submitted_via_portal
                  ? "Submitted directly by the customer — \"Order Concrete\" in the customer portal"
                  : b.booking_link_id
                    ? "Submitted directly by the customer via their booking link"
                    : `From ${b.requested_by_name}`}
              </div>
              <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                <button className="btn-primary" style={{ flex: 1, fontSize: 12 }} onClick={() => setConverting(b)}>Convert to order</button>
                <button className="btn-danger" style={{ flex: 1, fontSize: 12 }} onClick={() => decline(b.id)}>Decline</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ConvertBookingForm({ booking, setError, onDone, onCancel }) {
  const [sites, setSites] = useState([]);
  const [mixGrades, setMixGrades] = useState([]);
  const [supervisors, setSupervisors] = useState([]);
  const [pumps, setPumps] = useState([]);
  const [salespersons, setSalespersons] = useState([]);
  const [form, setForm] = useState({
    order_date: booking.preferred_date ? booking.preferred_date.slice(0, 10) : new Date().toISOString().slice(0, 10),
    // Round 119, post-ship again — round 6: this used to be pre-filled
    // straight from booking.preferred_time, which is actually what the
    // CUSTOMER asked for (i.e. required_at_site_time, below) — not
    // necessarily when the plant should start batching. Left as a plain
    // default now; the "Suggested" helper under the field below fills it in
    // once required_at_site_time and a site (with a distance on file) are set.
    scheduled_batching_time: "08:00",
    required_at_site_time: booking.preferred_time ? booking.preferred_time.slice(0, 5) : "",
    truck_dispatch_interval_minutes: 20,
    site_id: booking.site_id || "",
    mix_grade_id: booking.mix_grade_id || "",
    order_quantity_m3: booking.estimated_qty_m3 || "",
    pump_requirement: booking.pump_requirement || "without_pump",
    pump_id: "",
    assigned_pump_crew: "",
    site_technician_required: false,
    // Round 120, item 4c — see the matching comment/fix in CreateOrder.jsx;
    // same hardcoded-3 default, same fix.
    cube_samples_required: "",
    assigned_site_supervisor_id: "",
    site_contact_number: booking.site_contact_number || "",
    sales_representative_id: "",
    casting_location: booking.casting_location || "",
    specified_slump_mm: "",
    pump_departure_time: "",
    remarks: booking.remarks || booking.notes || "",
  });
  const [saving, setSaving] = useState(false);
  const [rateInfo, setRateInfo] = useState(null);
  const [pumpChargeDecision, setPumpChargeDecision] = useState(null);
  const [partLoadDecision, setPartLoadDecision] = useState(null);

  // Round 119, post-ship again, item 2 — this form used to collect only a
  // subset of what Create Order does (missing sales rep, slump, pump
  // departure time entirely; site technician/cube samples were in state but
  // had no input at all, so a Manager could never actually change them here).
  // Same Site Contacts directory pattern as CreateOrder.jsx (round 96, item 7).
  const [siteContacts, setSiteContacts] = useState([]);
  const [contactChoice, setContactChoice] = useState("");
  const [newContactName, setNewContactName] = useState("");

  function set(field, value) {
    setForm((f) => ({ ...f, [field]: value }));
  }

  useEffect(() => {
    Promise.all([apiRequest("/master/sites"), apiRequest("/master/mix-grades"), apiRequest("/master/site-supervisors"), apiRequest("/master/pumps"), apiRequest("/master/salespersons")])
      .then(([s, m, sup, p, sp]) => { setSites(s); setMixGrades(m); setSupervisors(sup); setPumps(p); setSalespersons(sp); })
      .catch((err) => setError(err.message));
  }, []);

  useEffect(() => {
    setPumpChargeDecision(null); setPartLoadDecision(null);
    if (!form.mix_grade_id || !form.site_id) { setRateInfo(null); return; }
    apiRequest(`/master/rate-check?customer_id=${booking.customer_id}&mix_grade_id=${form.mix_grade_id}&site_id=${form.site_id}&date=${form.order_date}`)
      .then(setRateInfo)
      .catch(() => setRateInfo(null));
  }, [form.mix_grade_id, form.site_id, form.order_date]);

  // Same autofill-from-directory behavior as Create Order: reload whenever
  // the site changes, and pre-select the booking's own contact if it's
  // already on file for this customer+site (otherwise it stays as
  // free-typed text, same as before).
  useEffect(() => {
    if (!booking.customer_id || !form.site_id) { setSiteContacts([]); return; }
    apiRequest(`/master/site-contacts?customer_id=${booking.customer_id}&site_id=${form.site_id}`)
      .then((contacts) => {
        setSiteContacts(contacts);
        const match = booking.site_contact_number && contacts.find((c) => c.phone_number === booking.site_contact_number);
        if (match) setContactChoice(String(match.id));
        else if (booking.site_contact_number) { setContactChoice("__new__"); setNewContactName(booking.site_contact_name || ""); }
      })
      .catch(() => setSiteContacts([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.site_id]);

  function chooseContact(value) {
    setContactChoice(value);
    if (value === "__new__" || value === "") {
      if (value === "") set("site_contact_number", "");
      setNewContactName("");
    } else {
      const c = siteContacts.find((sc) => String(sc.id) === String(value));
      set("site_contact_number", c?.phone_number || "");
    }
  }

  const sitesForCustomer = sites.filter((s) => String(s.customer_id) === String(booking.customer_id));
  const selectedSite = sites.find((s) => String(s.id) === String(form.site_id));
  const travelMinutes = selectedSite ? estimateTravelMinutes(selectedSite.distance_from_plant_km) : null;
  const batchingSuggestion = selectedSite && form.required_at_site_time
    ? suggestBatchingTime(form.required_at_site_time, selectedSite.distance_from_plant_km)
    : null;

  const pumpChargeAmount = form.pump_requirement === "boom_pump" ? Number(rateInfo?.boom_pump_charge || 0) || null : form.pump_requirement === "line_pump" ? Number(rateInfo?.line_pump_charge || 0) || null : null;
  const pumpMinQty = form.pump_requirement === "boom_pump" ? rateInfo?.boom_pump_min_qty_m3 : rateInfo?.line_pump_min_qty_m3;
  const needsPumpDecision = form.pump_requirement !== "without_pump" && rateInfo;
  const partLoadThreshold = Number(rateInfo?.part_load_min_qty_m3 ?? 5);
  const partLoadShortfall = form.order_quantity_m3 ? partLoadThreshold - Number(form.order_quantity_m3) : 0;
  const needsPartLoadDecision = rateInfo && form.order_quantity_m3 && partLoadShortfall > 0;
  const partLoadAmount = needsPartLoadDecision && rateInfo?.part_load_charge_per_m3
    ? partLoadShortfall * Number(rateInfo.part_load_charge_per_m3) : 0;

  async function submit(e) {
    e.preventDefault();
    setError("");
    if (form.pump_requirement !== "without_pump" && !form.pump_id) {
      setError("Select which pump will be used for this order.");
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
      await apiRequest(`/sales/bookings/${booking.id}/convert`, {
        method: "POST",
        body: {
          ...form,
          pump_charge_applicable: needsPumpDecision ? pumpChargeDecision : undefined,
          pump_charge_amount: needsPumpDecision && pumpChargeDecision ? pumpChargeAmount : 0,
          part_load_applicable: needsPartLoadDecision ? partLoadDecision : undefined,
          part_load_charge_amount: needsPartLoadDecision && partLoadDecision ? partLoadAmount : 0,
        },
      });
      // Same best-effort directory save as Create Order — never blocks
      // converting the booking if it fails.
      if (contactChoice === "__new__" && form.site_contact_number) {
        apiRequest("/master/site-contacts", {
          method: "POST",
          body: {
            customer_id: booking.customer_id, site_id: form.site_id,
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

  return (
    <div className="card" style={{ marginBottom: 20 }}>
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>Convert booking to order</div>
      <div style={{ fontSize: 12, color: "var(--slate)", marginBottom: 4 }}>{booking.customer_name}</div>
      {booking.submitted_via_portal ? (
        <div style={{ fontSize: 11, color: "var(--slate)", background: "var(--concrete)", borderRadius: 6, padding: "6px 8px", marginBottom: 12 }}>
          Submitted directly by the customer through "Order Concrete" in the customer portal — the fields below are
          pre-filled with what they gave; everything is still yours to adjust before creating the order.
        </div>
      ) : booking.booking_link_id && (
        <div style={{ fontSize: 11, color: "var(--slate)", background: "var(--concrete)", borderRadius: 6, padding: "6px 8px", marginBottom: 12 }}>
          Submitted directly by the customer via their booking link — the fields below are pre-filled with what they
          gave; everything is still yours to adjust before creating the order.
        </div>
      )}
      <form onSubmit={submit} className="field-input" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, fontSize: 13 }}>
        <div><div style={{ color: "var(--slate)" }}>Order date</div><input type="date" value={form.order_date} onChange={(e) => setForm({ ...form, order_date: e.target.value })} required /></div>
        <div><div style={{ color: "var(--slate)" }}>Required at site (customer needs it by)</div><input type="time" value={form.required_at_site_time} onChange={(e) => setForm({ ...form, required_at_site_time: e.target.value })} required /></div>
        <div>
          <div style={{ color: "var(--slate)" }}>Scheduled batching time</div>
          <input type="time" value={form.scheduled_batching_time} onChange={(e) => setForm({ ...form, scheduled_batching_time: e.target.value })} required />
          {batchingSuggestion && (
            <div style={{ fontSize: 11, color: "var(--slate)", marginTop: 4 }}>
              Suggested {batchingSuggestion} — {selectedSite.distance_from_plant_km} km, ~{travelMinutes} min travel + 15 min prep.{" "}
              <button type="button" onClick={() => setForm({ ...form, scheduled_batching_time: batchingSuggestion })} style={{ fontSize: 11, padding: "2px 8px" }}>Use</button>
            </div>
          )}
        </div>
        <div>
          <div style={{ color: "var(--slate)" }}>Site</div>
          <select value={form.site_id} onChange={(e) => setForm({ ...form, site_id: e.target.value })} required>
            <option value="">Select</option>
            {sitesForCustomer.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>
        <div>
          <div style={{ color: "var(--slate)" }}>Grade</div>
          <select value={form.mix_grade_id} onChange={(e) => setForm({ ...form, mix_grade_id: e.target.value })} required>
            <option value="">Select</option>
            {mixGrades.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
        </div>
        <div><div style={{ color: "var(--slate)" }}>Order quantity (m³)</div><input type="number" value={form.order_quantity_m3} onChange={(e) => setForm({ ...form, order_quantity_m3: e.target.value })} required /></div>
        <div><div style={{ color: "var(--slate)" }}>Truck dispatch interval (min)</div><input type="number" value={form.truck_dispatch_interval_minutes} onChange={(e) => setForm({ ...form, truck_dispatch_interval_minutes: e.target.value })} required /></div>
        <div>
          <div style={{ color: "var(--slate)" }}>Pump requirement</div>
          <select value={form.pump_requirement} onChange={(e) => setForm({ ...form, pump_requirement: e.target.value, pump_id: "" })}>
            <option value="without_pump">Without pump</option>
            <option value="boom_pump">Boom pump</option>
            <option value="line_pump">Line pump</option>
          </select>
        </div>
        {form.pump_requirement !== "without_pump" && (
          <div>
            <div style={{ color: "var(--slate)" }}>Which pump</div>
            <select value={form.pump_id} onChange={(e) => setForm({ ...form, pump_id: e.target.value })} required>
              <option value="">Select</option>
              {pumps.filter((p) => p.pump_type === form.pump_requirement).map((p) => <option key={p.id} value={p.id}>{p.pump_code}</option>)}
            </select>
          </div>
        )}
        {form.pump_requirement !== "without_pump" && (
          <div>
            <div style={{ color: "var(--slate)" }}>Assigned pump crew</div>
            <input type="text" value={form.assigned_pump_crew} onChange={(e) => setForm({ ...form, assigned_pump_crew: e.target.value })} />
          </div>
        )}
        {form.pump_requirement !== "without_pump" && (
          <div>
            <div style={{ color: "var(--slate)" }}>Pump departure time</div>
            <input type="time" value={form.pump_departure_time} onChange={(e) => setForm({ ...form, pump_departure_time: e.target.value })} />
          </div>
        )}
        <div>
          <div style={{ color: "var(--slate)" }}>Site technician required</div>
          <select value={form.site_technician_required} onChange={(e) => setForm({ ...form, site_technician_required: e.target.value === "true" })}>
            <option value="false">No</option>
            <option value="true">Yes</option>
          </select>
        </div>
        <div>
          <div style={{ color: "var(--slate)" }}>Cube samples required</div>
          <input type="number" min="0" placeholder="e.g. based on pour quantity" value={form.cube_samples_required} onChange={(e) => setForm({ ...form, cube_samples_required: e.target.value })} />
        </div>
        <div>
          <div style={{ color: "var(--slate)" }}>Site contact</div>
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
        </div>
        <div>
          <div style={{ color: "var(--slate)" }}>Site supervisor</div>
          <select value={form.assigned_site_supervisor_id} onChange={(e) => setForm({ ...form, assigned_site_supervisor_id: e.target.value })}>
            <option value="">None (small site)</option>
            {supervisors.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>
        <div>
          <div style={{ color: "var(--slate)" }}>Sales representative</div>
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
            <option value="">
              {booking.requested_by_name ? `Auto (booked by ${booking.requested_by_name})` : "Select"}
            </option>
            {salespersons.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            <option value="__add_new__">+ Add new salesperson...</option>
          </select>
        </div>
        <div>
          <div style={{ color: "var(--slate)" }}>Structure / casting location</div>
          <input type="text" value={form.casting_location} onChange={(e) => setForm({ ...form, casting_location: e.target.value })} />
        </div>
        <div>
          <div style={{ color: "var(--slate)" }}>Specified slump (mm)</div>
          <input type="number" min="0" step="1" value={form.specified_slump_mm} onChange={(e) => setForm({ ...form, specified_slump_mm: e.target.value })} />
        </div>
        <div style={{ gridColumn: "1 / -1" }}>
          <div style={{ color: "var(--slate)" }}>Remarks</div>
          <textarea rows={2} value={form.remarks} onChange={(e) => setForm({ ...form, remarks: e.target.value })} />
        </div>
        {rateInfo && !rateInfo.rate_exists && (
          <div style={{ gridColumn: "1 / -1", color: "var(--amber)", background: "var(--amber-bg)", padding: 10, borderRadius: 8, fontSize: 12 }}>
            No rate is on file for this customer, site, and grade combination as of this order date — deliveries won't generate invoices until one is added.
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
        <div style={{ gridColumn: "1 / -1", display: "flex", gap: 8 }}>
          <button type="submit" disabled={saving} style={{ flex: 1 }}>{saving ? "Creating..." : "Create order"}</button>
          <button type="button" onClick={onCancel} style={{ flex: 1 }}>Cancel</button>
        </div>
      </form>
    </div>
  );
}

// Round 119, post-ship — business asked that customer leads (which now
// includes the public "Request a quote" inquiries, source = 'public_inquiry')
// actually appear ON the Manager Dashboard, not just be reachable by
// navigating to Sales -> Browse Leads. Reuses the existing GET /sales/leads
// endpoint (same one LeadsBrowser.jsx uses) rather than adding a new
// backend route just for this — same "don't build a second read path for
// data that already has one" instinct as the public-inquiry feature itself
// reusing the leads pipeline.
//
// Round 119, post-ship again, items 7 & 8 — two fixes reported after this
// shipped:
// 1. A lead used to disappear from this card the moment it was assigned —
//    which meant Manager lost track of it entirely unless they went and
//    browsed Leads. It now stays here (as a reminder) until actually closed
//    (won/lost), showing who it's assigned to instead of the Assign
//    control. The "X new" badge now only counts still-unassigned leads,
//    since that's the number actually needing Manager's attention.
// 2. Round 119 post-ship again (round 2) added a "Close" button here that
//    marked the lead lost via POST /sales/leads/:id/lost. Round 3 walked
//    that back: closing a lead is a Leads-page-only action now (see
//    LeadDetailAdmin in LeadsBrowser.jsx). What this widget offers instead
//    is "Hide" — PATCH /sales/leads/:id/dashboard-hide sets
//    leads.dashboard_hidden, which only dismisses the card from this widget
//    and has no bearing on the lead's actual status. It's reversible via the
//    "N hidden — show" toggle below, so a manager who hides one by mistake
//    isn't stuck. "Won" isn't offered here deliberately — that's an
//    Administrator-only action needing customer/order attribution (see
//    LeadsBrowser.jsx), not something this quick card is meant to do.
const ENQUIRY_TYPE = (l) => (l.notes?.startsWith("[Free Technical Assistance") ? "Technical assistance" : "Request for quote");

export function CustomerInquiriesCard({ setError }) {
  const [leads, setLeads] = useState([]);
  const [executives, setExecutives] = useState([]);
  const [assigningId, setAssigningId] = useState(null);
  const [assignTo, setAssignTo] = useState("");
  const [showHidden, setShowHidden] = useState(false);
  const [busy, setBusy] = useState(false);

  async function load() {
    try {
      setLeads(await apiRequest("/sales/leads"));
    } catch (err) {
      setError(err.message);
    }
  }
  useEffect(() => {
    load();
    apiRequest("/sales/executives").then(setExecutives).catch(() => {});
  }, []);

  const open = leads
    .filter((l) => l.source === "public_inquiry" && l.status !== "won" && l.status !== "lost")
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  const inquiries = open.filter((l) => !l.dashboard_hidden);
  const hiddenInquiries = open.filter((l) => l.dashboard_hidden);
  const unassignedCount = inquiries.filter((l) => !l.assigned_to).length;

  async function assign(leadId) {
    if (!assignTo) return;
    setBusy(true); setError("");
    try {
      await apiRequest(`/sales/leads/${leadId}/assign`, { method: "PATCH", body: { assigned_to: assignTo } });
      setAssigningId(null); setAssignTo("");
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function setHidden(leadId, hidden) {
    setBusy(true); setError("");
    try {
      await apiRequest(`/sales/leads/${leadId}/dashboard-hide`, { method: "PATCH", body: { hidden } });
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card" style={{ marginBottom: 20 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
        <div style={{ fontSize: 13, fontWeight: 600 }}>Customer inquiries</div>
        {unassignedCount > 0 && (
          <span className="badge badge-info" style={{ fontSize: 12, padding: "3px 9px" }}>{unassignedCount} new</span>
        )}
      </div>
      {inquiries.length === 0 ? (
        <div style={{ fontSize: 13, color: "var(--slate)" }}>No open customer inquiries.</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {inquiries.slice(0, 5).map((l) => (
            <div key={l.id} style={{ background: "var(--concrete)", borderRadius: 8, padding: 10, fontSize: 13 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
                <div style={{ fontWeight: 600 }}>{l.prospect_name}</div>
                <span className="badge badge-neutral" style={{ fontSize: 10.5, padding: "2px 7px", whiteSpace: "nowrap" }}>{ENQUIRY_TYPE(l)}</span>
              </div>
              <div style={{ color: "var(--slate)", fontSize: 12 }}>
                {l.site_location ? `${l.site_location} · ` : ""}{l.contact_person ? `${l.contact_person} · ` : ""}{l.contact_phone}
              </div>
              <div style={{ color: "var(--slate)", fontSize: 11, marginTop: 2 }}>
                Submitted {new Date(l.created_at).toLocaleDateString([], { day: "2-digit", month: "short" })}
                {l.assigned_to_name && ` · Assigned to ${l.assigned_to_name}`}
              </div>

              {assigningId === l.id ? (
                <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
                  <select value={assignTo} onChange={(e) => setAssignTo(e.target.value)} style={{ flex: 1, fontSize: 12 }}>
                    <option value="">Select salesperson</option>
                    {executives.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                  </select>
                  <button type="button" disabled={busy || !assignTo} onClick={() => assign(l.id)} style={{ fontSize: 11, padding: "3px 8px" }}>
                    {busy ? "..." : "Assign"}
                  </button>
                  <button type="button" onClick={() => { setAssigningId(null); setAssignTo(""); }} style={{ fontSize: 11, padding: "3px 8px" }}>Cancel</button>
                </div>
              ) : (
                <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
                  <button type="button" onClick={() => setAssigningId(l.id)} style={{ fontSize: 11, padding: "3px 8px" }}>
                    {l.assigned_to_name ? "Reassign" : "Assign to a salesperson"}
                  </button>
                  <button type="button" disabled={busy} onClick={() => setHidden(l.id, true)} style={{ fontSize: 11, padding: "3px 8px" }}>
                    Hide
                  </button>
                </div>
              )}
            </div>
          ))}
          {inquiries.length > 5 && (
            <div style={{ fontSize: 11, color: "var(--slate)", textAlign: "center" }}>
              +{inquiries.length - 5} more — see Browse Leads
            </div>
          )}
        </div>
      )}
      {hiddenInquiries.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <button
            type="button"
            onClick={() => setShowHidden((v) => !v)}
            style={{ fontSize: 11, color: "var(--slate)", background: "none", border: "none", padding: 0, cursor: "pointer", textDecoration: "underline" }}
          >
            {hiddenInquiries.length} hidden — {showHidden ? "hide again" : "show"}
          </button>
          {showHidden && (
            <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 8 }}>
              {hiddenInquiries.map((l) => (
                <div key={l.id} style={{ background: "var(--concrete)", borderRadius: 8, padding: 10, fontSize: 13, opacity: 0.75 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
                    <div style={{ fontWeight: 600 }}>{l.prospect_name}</div>
                    <span className="badge badge-neutral" style={{ fontSize: 10.5, padding: "2px 7px", whiteSpace: "nowrap" }}>{ENQUIRY_TYPE(l)}</span>
                  </div>
                  <div style={{ color: "var(--slate)", fontSize: 12 }}>
                    {l.site_location ? `${l.site_location} · ` : ""}{l.contact_person ? `${l.contact_person} · ` : ""}{l.contact_phone}
                    {l.assigned_to_name && ` · Assigned to ${l.assigned_to_name}`}
                  </div>
                  <div style={{ marginTop: 8 }}>
                    <button type="button" disabled={busy} onClick={() => setHidden(l.id, false)} style={{ fontSize: 11, padding: "3px 8px" }}>
                      Unhide
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      <Link to="/leads" style={{ display: "block", textAlign: "center", marginTop: 10, fontSize: 12 }}>Browse all leads →</Link>
    </div>
  );
}
