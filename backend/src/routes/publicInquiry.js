import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import { query } from "../db.js";
import { pushToRole } from "../lib/push.js";

// Round 119 — the public, no-login "Request a quote / Get in touch" page
// (frontend/src/pages/PublicInquiry.jsx, /inquiry) for potential customers
// arriving from outside the app (website, social media, a shared link) who
// have no existing account or order history. Deliberately NOT the customer
// portal (routes/customerPortal.js) — that's for an existing customer with
// an issued access code to see THEIR OWN orders/QC reports; this is a
// one-way "hey, we're interested" form with no reply channel back through
// the app. The submission lands in the existing Sales leads pipeline
// (leads.source = 'public_inquiry', assigned_to left NULL) rather than a
// separate inbox — Manager/Admin already has "Browse Leads" reachable from
// every dashboard, and a parallel inquiry list would just be the same data
// twice (see the app's own recurring-bug-pattern notes on this).
const router = Router();

// No CAPTCHA/verification infra exists anywhere in this app yet, so this is
// the only spam defense available for a public unauthenticated POST: a
// modest per-IP cap. Worth revisiting (e.g. a real CAPTCHA) if this becomes
// a real spam vector in practice.
const submitLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 8,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many submissions from this connection — please try again later." },
});

// Round 119, post-ship — expanded per the business's own mockup (RequestQuote
// screen): a contact's own name is now required (previously "company name"
// doubled as the required field), company/site name is optional, and
// quantity/grade/mix-requirement/timeline fields were added.
// mix_grade_interest and estimated_qty_m3 reuse leads' own existing columns
// (already there for staff-created leads); mix requirement and "anything
// else" are free text with nowhere structured to go, so the frontend
// combines them into one string and it lands in leads.notes.
router.post("/", submitLimiter, async (req, res) => {
  const { contact_name, contact_number, company_name, site_project, estimated_qty_m3, mix_grade_interest, notes } = req.body;
  const contactName = (contact_name || "").trim();
  const contactNumber = (contact_number || "").trim();
  const companyName = (company_name || "").trim();
  if (!contactName || !contactNumber) {
    return res.status(400).json({ error: "Your name and a mobile number are required." });
  }
  if (contactName.length > 150 || contactNumber.length > 20 || companyName.length > 150) {
    return res.status(400).json({ error: "That doesn't look right — please check the fields and try again." });
  }

  const { rows } = await query(
    `INSERT INTO leads (prospect_name, contact_person, contact_phone, site_location, mix_grade_interest, estimated_qty_m3, notes, source, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'public_inquiry','new') RETURNING id`,
    [
      companyName || contactName, contactName, contactNumber, (site_project || "").trim() || null,
      (mix_grade_interest || "").trim() || null, estimated_qty_m3 || null, (notes || "").trim() || null,
    ]
  );

  const pushPayload = {
    title: "New public inquiry",
    body: `${companyName || contactName}${site_project ? ` — ${site_project}` : ""}`,
    url: "/leads",
  };
  await Promise.all([pushToRole("manager", pushPayload), pushToRole("administrator", pushPayload)]);

  res.status(201).json({ ok: true, id: rows[0].id });
});

// Round 119, post-ship — the mockup's "Free Technical Assistance" callback
// form: same public, no-login intake as the quote form above, landing in
// the same leads pipeline (source = 'public_inquiry') so Manager/Admin sees
// it in the one place they already check, rather than a second inbox. What
// makes it a "technical assistance" request rather than a quote request is
// just the topic tag prefixed onto notes — see schema.sql's comment on
// leads.notes for why that's a tag in text rather than another column.
router.post("/technical-assistance", submitLimiter, async (req, res) => {
  const { name, phone, topic, project_description } = req.body;
  const contactName = (name || "").trim();
  const contactNumber = (phone || "").trim();
  if (!contactName || !contactNumber) {
    return res.status(400).json({ error: "Your name and a mobile number are required." });
  }
  if (contactName.length > 150 || contactNumber.length > 20) {
    return res.status(400).json({ error: "That doesn't look right — please check the fields and try again." });
  }
  const topicTag = (topic || "Something else").trim();
  const description = (project_description || "").trim();
  const notes = `[Free Technical Assistance — ${topicTag}]${description ? ` ${description}` : ""}`;

  const { rows } = await query(
    `INSERT INTO leads (prospect_name, contact_person, contact_phone, notes, source, status)
     VALUES ($1,$2,$3,$4,'public_inquiry','new') RETURNING id`,
    [contactName, contactName, contactNumber, notes]
  );

  const pushPayload = {
    title: "New technical assistance request",
    body: `${contactName} — ${topicTag}`,
    url: "/leads",
  };
  await Promise.all([pushToRole("manager", pushPayload), pushToRole("administrator", pushPayload)]);

  res.status(201).json({ ok: true, id: rows[0].id });
});

export default router;
