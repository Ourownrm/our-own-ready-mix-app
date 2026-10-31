import { useEffect, useState } from "react";
import { PumpGangField } from "../lib/PumpGangPicker.jsx";
import { apiRequest } from "../lib/api.js";
import { estimateTravelMinutes, suggestBatchingTime } from "../lib/travelEstimate.js";
import { todayStr, daysAgoStr, monthStartStr, istMonth, istDay } from "../lib/istDate.js";

const initialForm = {
  order_date: todayStr(),
  scheduled_batching_time: "08:00",
  required_at_site_time: "",
  truck_dispatch_interval_minutes: 20,
  customer_id: "",
  site_id: "",
  mix_grade_id: "",
  pump_requirement: "without_pump",
  pump_id: "",
  site_technician_required: false,
  // Round 120, item 4c — was hardcoded to 3, so nearly every order kept
  // whatever the form pre-filled instead of an actual decision, and every
  // delivery note under it inherited that same "3" by default. Left blank so
  // sales/admin has to actively enter a count for each order (based on the
  // pour quantity, per the applicable testing standard) rather than silently
  // carrying over a number that was never really chosen.
  cube_samples_required: "",
  assigned_pump_crew: "",
  pump_gang_id: "",
  assigned_site_supervisor_id: "",
  site_contact_number: "",
  order_quantity_m3: "",
  sales_representative_id: "",
  casting_location: "",
  specified_slump_mm: "",
  pump_departure_time: "",
  remarks: "",
  // Round 121, item 3 — which billing entity to invoice this order under, if
  // the customer has more than one on file. Blank means "use whichever the
  // customer has marked default" (resolved server-side) — most customers
  // never touch this at all.
  billing_address_id: "",
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
  const [mixDesignInfo, setMixDesignInfo] = useState(null);
  const [pumpChargeDecision, setPumpChargeDecision] = useState(null); // null | true | false
  const [partLoadDecision, setPartLoadDecision] = useState(null);
  // Round 204 — leaving a charge out needs a reason; the Administrator is told.
  const [pumpWaiverReason, setPumpWaiverReason] = useState("");
  const [partLoadWaiverReason, setPartLoadWaiverReason] = useState("");
  // Round 205 — two prices for the grade at this site (OPC / OPC + fly ash):
  // which one this order is.
  const [priceOption, setPriceOption] = useState("");
  // Round 209 — the site's approved mixes (grade + mix design ref / rev, no
  // price): only these can be ordered once the site has a price list.
  const [siteMixes, setSiteMixes] = useState(null);
  const [mixKey, setMixKey] = useState("");
  const [mixDesignId, setMixDesignId] = useState("");
  useEffect(() => {
    setSiteMixes(null); setMixKey(""); setMixDesignId("");
    if (!form.customer_id || !form.site_id) return;
    apiRequest(`/master/site-mixes?customer_id=${form.customer_id}&site_id=${form.site_id}&date=${form.order_date}`)
      .then(setSiteMixes).catch(() => setSiteMixes(null));
  }, [form.customer_id, form.site_id, form.order_date]);
  const mixMode = siteMixes && siteMixes.source !== "none" && siteMixes.mixes.length > 0;
  const mixKeyOf = (m) => `${m.mix_grade_id}|${m.price_option || ""}|${m.mix_design_id || ""}`;
  function chooseMix(key) {
    setMixKey(key);
    const m = siteMixes.mixes.find((x) => mixKeyOf(x) === key);
    setForm((f) => ({ ...f, mix_grade_id: m ? String(m.mix_grade_id) : "" }));
    setPriceOption(m?.price_option || "");
    setMixDesignId(m?.mix_design_id ? String(m.mix_design_id) : "");
  }
  const mixGradesOfSite = mixMode
    ? [...new Map(siteMixes.mixes.map((m) => [String(m.mix_grade_id), { id: String(m.mix_grade_id), name: m.grade_name }])).values()]
    : [];
  const gradeMixes = mixMode ? siteMixes.mixes.filter((m) => String(m.mix_grade_id) === String(form.mix_grade_id)) : [];
  const gradeHasDesign = gradeMixes.some((m) => m.mix_design_id);
  function chooseGrade(gid) {
    const list = mixMode ? siteMixes.mixes.filter((m) => String(m.mix_grade_id) === String(gid)) : [];
    if (list.length === 1) return chooseMix(mixKeyOf(list[0]));
    setMixKey(""); setPriceOption(""); setMixDesignId("");
    setForm((f) => ({ ...f, mix_grade_id: gid }));
  }
  useEffect(() => { if (!mixMode) setPriceOption(""); }, [form.site_id, form.mix_grade_id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Site Contacts directory (round 96, item 7) — autofills from any contact
  // already on file for this exact customer+site, and saves a newly-typed
  // one so the next order for the same site has it available too.
  const [siteContacts, setSiteContacts] = useState([]);
  const [contactChoice, setContactChoice] = useState(""); // "" | a site_contacts id | "__new__"
  const [newContactName, setNewContactName] = useState("");

  // Round 121, item 3 — this customer's billing profiles, if any. Empty for
  // the vast majority of customers, in which case the field stays hidden.
  const [billingAddresses, setBillingAddresses] = useState([]);

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
    apiRequest(`/master/rate-check?customer_id=${form.customer_id}&mix_grade_id=${form.mix_grade_id}&site_id=${form.site_id}&date=${form.order_date}${priceOption ? `&price_option=${encodeURIComponent(priceOption)}` : ""}`)
      .then(setRateInfo)
      .catch(() => setRateInfo(null));
  }, [form.customer_id, form.mix_grade_id, form.site_id, form.order_date, priceOption]);

  // Purely informational (round 118) — shows which mix design this
  // customer+grade will actually resolve to (a customer-specific assignment,
  // or the grade's standard design, or none on file yet), same resolution
  // orders.js applies server-side when the order is placed. Never blocks
  // submission — it's just so the person placing the order can see it.
  useEffect(() => {
    if (!form.customer_id || !form.mix_grade_id) { setMixDesignInfo(null); return; }
    apiRequest(`/master/resolve-mix-design?customer_id=${form.customer_id}&mix_grade_id=${form.mix_grade_id}`)
      .then((r) => setMixDesignInfo(r.design || null))
      .catch(() => setMixDesignInfo(null));
  }, [form.customer_id, form.mix_grade_id]);

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

  // Round 121, item 3 — reload the customer's billing profiles whenever the
  // customer changes, and pre-select whichever one is marked default (the
  // person placing the order can still change it before submitting).
  useEffect(() => {
    set("billing_address_id", "");
    if (!form.customer_id) { setBillingAddresses([]); return; }
    apiRequest(`/administrator/customers/${form.customer_id}/billing-addresses`)
      .then((rows) => {
        const active = rows.filter((r) => r.is_active);
        setBillingAddresses(active);
        const def = active.find((r) => r.is_default);
        if (def) set("billing_address_id", def.id);
      })
      .catch(() => setBillingAddresses([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.customer_id]);

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

  // Round 204 (owner, 11 Oct 2026) — the price list carries the pump rule;
  // the Manager decides on every order. Part load is asked on every order:
  // "if a load goes out below the minimum, charge part load?" — when yes,
  // each such delivery's invoice carries it. No estimate and no GST choice
  // here: GST applies by default and the Accountant can switch it off.
  const pumpChargeAmount = form.pump_requirement === "boom_pump" ? Number(rateInfo?.boom_pump_charge || 0) || null : form.pump_requirement === "line_pump" ? Number(rateInfo?.line_pump_charge || 0) || null : null;
  const pumpMinQty = form.pump_requirement === "boom_pump" ? rateInfo?.boom_pump_min_qty_m3 : rateInfo?.line_pump_min_qty_m3;
  // Round 217 (owner, 20 Oct 2026) — a line pump order at or above the line
  // pump minimum (20 m³ unless the price list says otherwise) can never carry
  // the mobilization charge, so the question is not asked at all.
  const linePumpAboveMin = form.pump_requirement === "line_pump" && Number(form.order_quantity_m3 || 0) > 0
    && Number(form.order_quantity_m3 || 0) >= Number(rateInfo?.line_pump_min_qty_m3 ?? 20);
  const needsPumpDecision = form.pump_requirement !== "without_pump" && !linePumpAboveMin;
  const pumpRuleApplies = !!pumpChargeAmount && Number(form.order_quantity_m3 || 0) < Number(pumpMinQty || 0);
  const partLoadThreshold = Number(rateInfo?.part_load_min_qty_m3 ?? 5);
  const partLoadRate = rateInfo?.part_load_charge_per_m3 ? Number(rateInfo.part_load_charge_per_m3) : null;

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");
    if (!form.site_contact_number) {
      setError("Select a site contact on file, or add a new one.");
      return;
    }
    if (form.pump_requirement !== "without_pump" && !form.pump_id) {
      setError("Select which pump will be used for this order.");
      return;
    }
    if (rateInfo?.options?.length > 1 && !priceOption) {
      setError("This site has two prices for the grade — choose which one this order is.");
      return;
    }
    if (needsPumpDecision && pumpChargeDecision === null) {
      setError("Confirm whether the pump mobilization charge applies to this order.");
      return;
    }
    if (needsPumpDecision && pumpChargeDecision === false && pumpRuleApplies && !pumpWaiverReason.trim()) {
      setError("Give the reason for not charging the pump mobilization — the Administrator is notified.");
      return;
    }
    if (partLoadDecision === null) {
      setError(`Confirm whether the part load charge applies if a load goes out below ${partLoadThreshold} m³.`);
      return;
    }
    if (partLoadDecision === false && !partLoadWaiverReason.trim()) {
      setError("Give the reason for not charging part load — the Administrator is notified.");
      return;
    }
    setSaving(true);
    try {
      await apiRequest("/orders", {
        method: "POST",
        body: {
          ...form,
          pump_charge_applicable: needsPumpDecision ? pumpChargeDecision : linePumpAboveMin ? false : undefined,
          pump_charge_amount: needsPumpDecision && pumpChargeDecision ? pumpChargeAmount : 0,
          price_option: priceOption || undefined,
          mix_design_id: mixMode && mixDesignId ? Number(mixDesignId) : undefined,
          pump_charge_waiver_reason: needsPumpDecision && pumpChargeDecision === false ? pumpWaiverReason.trim() || undefined : undefined,
          part_load_applicable: partLoadDecision,
          part_load_waiver_reason: partLoadDecision === false ? partLoadWaiverReason.trim() : undefined,
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
  const travelMinutes = selectedSite ? estimateTravelMinutes(selectedSite.distance_from_plant_km) : null;
  const batchingSuggestion = selectedSite && form.required_at_site_time
    ? suggestBatchingTime(form.required_at_site_time, selectedSite.distance_from_plant_km)
    : null;

  return (
    <div className="card" style={{ maxWidth: 640, margin: "0 auto" }}>
      <div style={{ fontSize: 16, fontWeight: 500, marginBottom: 12 }}>Create customer order</div>
      <form onSubmit={handleSubmit} style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, fontSize: 13 }}>
        <Field label="Order date">
          <input type="date" value={form.order_date} onChange={(e) => set("order_date", e.target.value)} required />
        </Field>
        <Field label="Required at site (customer needs it by)">
          <input type="time" value={form.required_at_site_time} onChange={(e) => set("required_at_site_time", e.target.value)} required />
        </Field>
        <Field label="Scheduled batching time">
          <input type="time" value={form.scheduled_batching_time} onChange={(e) => set("scheduled_batching_time", e.target.value)} required />
          {batchingSuggestion && (
            <div style={{ fontSize: 11, color: "var(--slate)", marginTop: 4 }}>
              Suggested {batchingSuggestion} — {selectedSite.distance_from_plant_km} km, ~{travelMinutes} min travel + 15 min prep.{" "}
              <button type="button" onClick={() => set("scheduled_batching_time", batchingSuggestion)} style={{ fontSize: 11, padding: "2px 8px" }}>Use</button>
            </div>
          )}
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
        {billingAddresses.length > 0 && (
          <Field label="Bill to">
            <select value={form.billing_address_id} onChange={(e) => set("billing_address_id", e.target.value)}>
              {billingAddresses.map((b) => <option key={b.id} value={b.id}>{b.name}{b.is_default ? " (default)" : ""}</option>)}
            </select>
          </Field>
        )}
        {mixMode ? (
          <>
            {/* Round 254 — grade first, then the quotation's mix design for
                that grade (only that grade's mixes). Required when the
                quotation names mix designs; skipped when it does not. */}
            <Field label={siteMixes.source === "quotation" ? `Mix grade (quotation ${siteMixes.quote_no})` : "Mix grade (approved for this site)"}>
              <select value={form.mix_grade_id} onChange={(e) => chooseGrade(e.target.value)} required>
                <option value="">Select</option>
                {mixGradesOfSite.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
              </select>
            </Field>
            {form.mix_grade_id && (gradeMixes.length > 1 || gradeHasDesign) && (
              <Field label={gradeHasDesign ? "Mix design (from quotation) — required" : "Price option — required"}>
                <select value={mixKey} onChange={(e) => chooseMix(e.target.value)} required>
                  <option value="">Choose…</option>
                  {gradeMixes.map((m) => (
                    <option key={mixKeyOf(m)} value={mixKeyOf(m)}>
                      {m.design_ref ? `${m.design_ref}${gradeMixes.filter((x) => x.design_ref === m.design_ref).length > 1 && m.price_option ? ` · ${m.price_option}` : ""}` : (m.price_option || m.label)}
                    </option>
                  ))}
                </select>
              </Field>
            )}
          </>
        ) : (
          <Field label="Mix grade">
            <select value={form.mix_grade_id} onChange={(e) => set("mix_grade_id", e.target.value)} required>
              <option value="">Select</option>
              {mixGrades.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
          </Field>
        )}
        {form.customer_id && form.mix_grade_id && !mixMode && (
          <div style={{ gridColumn: "1 / -1", fontSize: 12, color: "var(--slate)", background: "var(--concrete)", borderRadius: 8, padding: "6px 10px", marginTop: -4 }}>
            {mixDesignInfo
              ? `Mix design on file: ${mixDesignInfo.design_ref_code}${mixDesignInfo.is_customer_specific ? " (assigned to this customer)" : " (standard for this grade)"}.`
              : "No approved mix design on file yet for this customer/grade — the order will still go through."}
          </div>
        )}
        <Field label="Pump requirement">
          <select value={form.pump_requirement} onChange={(e) => set("pump_requirement", e.target.value)}>
            <option value="boom_pump">Boom pump</option>
            <option value="line_pump">Line pump</option>
            <option value="without_pump">Without pump</option>
          </select>
        </Field>
        {form.pump_requirement !== "without_pump" && (
          <Field label="Which pump">
            <select value={form.pump_id} onChange={(e) => set("pump_id", e.target.value)} required>
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
          <input type="number" min="0" placeholder="e.g. based on pour quantity" value={form.cube_samples_required} onChange={(e) => set("cube_samples_required", e.target.value)} />
        </Field>
        <Field label="Pump gang">
          <PumpGangField gangId={form.pump_gang_id} crewText={form.assigned_pump_crew} onGang={(v) => set("pump_gang_id", v)} onText={(v) => set("assigned_pump_crew", v)} />
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

        {rateInfo?.rate_exists && (
          <div style={{ gridColumn: "1 / -1", fontSize: 12, background: "var(--signal-green-bg)", color: "var(--signal-green)", padding: 10, borderRadius: 8 }}>
            Price on the site's price list{" "}
            {rateInfo.quote_no ? <>— quotation <b>{rateInfo.quote_no}</b></> : rateInfo.rate_source === "rate_file" ? "— from the rate file" : ""}
            {rateInfo.effective_from ? ` (from ${rateInfo.effective_from})` : ""}{!rateInfo.is_site_specific ? " · customer-wide rate" : ""}
            {rateInfo.pending_quotation && <div style={{ color: "var(--slate)", marginTop: 2 }}>{rateInfo.pending_quotation.quote_no} is with the customer — not in force until they accept it.</div>}
          </div>
        )}
        {rateInfo?.options?.length > 1 && !mixMode && (
          <div style={{ gridColumn: "1 / -1", fontSize: 12, background: "var(--info-bg)", color: "var(--info)", padding: 10, borderRadius: 8 }}>
            <div style={{ fontWeight: 600, marginBottom: 6 }}>This site has {rateInfo.options.length} prices for this grade — which one is this order? (required)</div>
            <select value={priceOption} onChange={(e) => setPriceOption(e.target.value)} style={{ width: "100%" }}>
              <option value="">Choose…</option>
              {rateInfo.options.map((o) => (
                <option key={o.price_option} value={o.price_option}>{o.price_option}</option>
              ))}
            </select>
          </div>
        )}
        {rateInfo && !rateInfo.rate_exists && !rateInfo.needs_option && (
          rateInfo.not_approved ? (
            <div style={{ gridColumn: "1 / -1", color: "var(--alert-red)", background: "var(--alert-red-bg, #fdecec)", padding: 10, borderRadius: 8, fontSize: 12 }}>
              This grade / mix is not approved by the customer for this site, so it cannot be ordered. The Administrator can enable it in Accounts → Price lists.
            </div>
          ) : rateInfo.pending_quotation && rateInfo.pending_quotation.revision === 0 ? (
            <div style={{ gridColumn: "1 / -1", fontSize: 12, background: "var(--info-bg)", color: "var(--info)", padding: 10, borderRadius: 8 }}>
              New site: this order accepts quotation <b>{rateInfo.pending_quotation.quote_no}</b> and sets the site's price list from the order date.
            </div>
          ) : (
            <div style={{ gridColumn: "1 / -1", color: "var(--amber)", background: "var(--amber-bg)", padding: 10, borderRadius: 8, fontSize: 12 }}>
              No price for this customer, site and grade on this date. Deliveries will be held from invoicing until a quotation for the site is accepted (Accounts → Quotations).
            </div>
          )
        )}

        {linePumpAboveMin && (
          <div style={{ gridColumn: "1 / -1", fontSize: 12, color: "var(--slate)", background: "var(--concrete)", borderRadius: 8, padding: "8px 10px" }}>
            Line pump: no mobilization charge — the order is {Number(rateInfo?.line_pump_min_qty_m3 ?? 20)} m³ or more.
          </div>
        )}
        {needsPumpDecision && (
          <div style={{ gridColumn: "1 / -1", background: "var(--amber-bg)", border: "1px solid var(--amber)", borderRadius: 8, padding: 10 }}>
            <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>Pump mobilization charge (required)</div>
            <div style={{ fontSize: 11, color: "var(--slate)", marginBottom: 8 }}>
              {form.pump_requirement === "boom_pump" ? "Boom" : "Line"} pump charge in the price list: {pumpChargeAmount ? `₹${pumpChargeAmount.toLocaleString("en-IN")}` : "not set"}
              {pumpMinQty ? ` (applies below ${pumpMinQty} m³)` : ""}.
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button type="button" onClick={() => setPumpChargeDecision(true)} style={pumpChargeDecision === true ? { background: "var(--rebar)", color: "#fff" } : undefined}>
                Applicable{pumpChargeAmount ? ` — ₹${pumpChargeAmount.toLocaleString("en-IN")}` : ""}
              </button>
              <button type="button" onClick={() => setPumpChargeDecision(false)} style={pumpChargeDecision === false ? { background: "var(--rebar)", color: "#fff" } : undefined}>
                Not applicable
              </button>
            </div>
            {pumpChargeDecision === false && (
              <div className="field-input" style={{ marginTop: 8 }}>
                <input value={pumpWaiverReason} onChange={(e) => setPumpWaiverReason(e.target.value)}
                  placeholder={pumpRuleApplies ? "Reason (required — the Administrator is notified)" : "Reason (optional)"} />
              </div>
            )}
          </div>
        )}

        <div style={{ gridColumn: "1 / -1", background: "var(--concrete)", border: "1px solid var(--border-strong, #ccc)", borderRadius: 8, padding: 10 }}>
          <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>Part load charge (required)</div>
          <div style={{ fontSize: 11, color: "var(--slate)", marginBottom: 8 }}>
            If a load goes out below {partLoadThreshold} m³, charge part load{partLoadRate ? ` at ₹${partLoadRate.toLocaleString("en-IN")} per m³ short` : " (no part load rate in the price list)"}? It is added to that delivery's invoice.
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" onClick={() => setPartLoadDecision(true)} style={partLoadDecision === true ? { background: "var(--rebar)", color: "#fff" } : undefined}>Applicable</button>
            <button type="button" onClick={() => setPartLoadDecision(false)} style={partLoadDecision === false ? { background: "var(--rebar)", color: "#fff" } : undefined}>Not applicable</button>
          </div>
          {partLoadDecision === false && (
            <div className="field-input" style={{ marginTop: 8 }}>
              <input value={partLoadWaiverReason} onChange={(e) => setPartLoadWaiverReason(e.target.value)} placeholder="Reason (required — the Administrator is notified)" />
            </div>
          )}
        </div>

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
