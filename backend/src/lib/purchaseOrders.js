// Round 208 — the material order printed as a purchase order (owner's LPO
// format, 13 Oct 2026). Three things live here:
//   * the PO settings (addresses, contact, our GSTIN, default terms, standard
//     remarks) — one JSON value, edited by Administrator;
//   * the per-order terms (quotation ref, delivery, payment, ...) saved on the
//     order, so a reprint shows exactly what was sent;
//   * the defaults the Print dialog opens with.
// The same CREATE/ALTER statements are at the end of schema.sql.

export const PO_SQL = `
CREATE TABLE IF NOT EXISTS rm_po_settings (
  key        VARCHAR(40) PRIMARY KEY,
  value      JSONB NOT NULL,
  updated_by INTEGER REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE rm_orders ADD COLUMN IF NOT EXISTS po_terms JSONB;
ALTER TABLE rm_orders ADD COLUMN IF NOT EXISTS po_terms_by INTEGER REFERENCES users(id);
ALTER TABLE rm_orders ADD COLUMN IF NOT EXISTS po_terms_at TIMESTAMPTZ;
`;

// What the owner's own LPO format carries today.
export const PO_SETTINGS_DEFAULT = {
  billing_address: "Our Own Ready Mix,\nGround Floor, PPGPW/16/487, Revathi Complex,\nPeriya Bus Stop, Periya, Kanhangad, Kasaragod.\nPost Box - 671316",
  delivery_address: "Our Own Ready Mix,\nPlot No. 3C-2, Ananthapuram Development Plot,\nKasaragod District, Kerala.\nPost Box - 671321",
  contact_person: "",
  contact_phone: "+91 8340074006",
  our_gstin: "32AAGFO7545J1Z2",
  validity_days: null,
  delivery: "Immediate",
  payment: "",
  unloading: "Not in Supplier Scope",
  remarks: "Quote this PO number on every invoice and delivery challan.\nEvery load is weighed at our weighbridge; payment is on the quantity accepted there.",
};

const TEXT_KEYS = ["billing_address", "delivery_address", "contact_person", "contact_phone", "our_gstin",
  "delivery", "payment", "unloading", "remarks"];

export function cleanSettings(body) {
  const out = {};
  for (const k of TEXT_KEYS) {
    const v = body[k];
    if (v === undefined) continue;
    out[k] = String(v ?? "").slice(0, 1000);
  }
  if (out.our_gstin !== undefined) {
    out.our_gstin = out.our_gstin.trim().toUpperCase();
    if (out.our_gstin && !/^[0-9]{2}[A-Z0-9]{13}$/.test(out.our_gstin)) return { error: "Our GST No. should be 15 characters, starting with the 2-digit state code." };
  }
  if (body.validity_days !== undefined) {
    const raw = String(body.validity_days ?? "").trim();
    if (raw === "") out.validity_days = null;
    else {
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1 || n > 730) return { error: "PO valid for: enter whole days between 1 and 730, or leave blank." };
      out.validity_days = n;
    }
  }
  return { value: out };
}

export async function getPoSettings(db) {
  const { rows } = await db.query(`SELECT value, updated_at FROM rm_po_settings WHERE key = 'po'`);
  return { ...PO_SETTINGS_DEFAULT, ...(rows[0]?.value || {}) };
}

// Terms one order prints with. Every value is text the user may change.
export const TERM_KEYS = ["quotation_ref", "quotation_date", "particulars", "delivery", "payment", "unloading",
  "taxes", "freight", "cheque_no", "cheque_amount", "contact_person", "remarks"];

export function cleanTerms(body) {
  const out = {};
  for (const k of TERM_KEYS) out[k] = String(body?.[k] ?? "").slice(0, 1500);
  if (out.quotation_date && !/^\d{4}-\d{2}-\d{2}$/.test(out.quotation_date)) return { error: "Quotation date is not a valid date." };
  if (out.cheque_amount && !(Number(out.cheque_amount.replace(/,/g, "")) > 0)) return { error: "Cheque amount should be a number." };
  return { value: out };
}

export function defaultTerms(order, settings) {
  const materialLine = [order.material_name, order.source_name && order.source_name !== order.material_name && !/^standard$/i.test(order.source_name) ? order.source_name : null]
    .filter(Boolean).join(" — ");
  const credit = order.supplier_credit_days != null ? Number(order.supplier_credit_days) : null;
  return {
    quotation_ref: "",
    quotation_date: "",
    particulars: materialLine,
    delivery: settings.delivery || "",
    payment: credit != null ? (credit === 0 ? "Advance / on delivery" : `${credit} days credit from invoice date`) : (settings.payment || ""),
    unloading: settings.unloading || "",
    taxes: Number(order.tax_pct) > 0
      ? (order.gst_treatment === "included" ? "Rate is inclusive of GST" : "GST extra as shown above")
      : "Inclusive of all taxes & duties",
    freight: order.scope === "delivered" ? "Supplier Scope" : `Our Scope${order.transporter_name ? ` — ${order.transporter_name}` : ""}`,
    cheque_no: "",
    cheque_amount: "",
    contact_person: settings.contact_person || "",
    remarks: settings.remarks || "",
  };
}

export async function migratePurchaseOrders(pool, log) {
  await pool.query(PO_SQL);
  log.push("Schema migration applied (Round 208 — purchase order print: PO settings and per-order PO terms).");
}
