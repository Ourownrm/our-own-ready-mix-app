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

router.post("/", submitLimiter, async (req, res) => {
  const { company_name, site_project, contact_name, contact_number } = req.body;
  const companyName = (company_name || "").trim();
  const contactNumber = (contact_number || "").trim();
  if (!companyName || !contactNumber) {
    return res.status(400).json({ error: "Company name and a contact number are required." });
  }
  if (companyName.length > 150 || contactNumber.length > 20) {
    return res.status(400).json({ error: "That doesn't look right — please check the fields and try again." });
  }

  const { rows } = await query(
    `INSERT INTO leads (prospect_name, contact_person, contact_phone, site_location, source, status)
     VALUES ($1,$2,$3,$4,'public_inquiry','new') RETURNING id`,
    [companyName, (contact_name || "").trim() || null, contactNumber, (site_project || "").trim() || null]
  );

  const pushPayload = {
    title: "New public inquiry",
    body: `${companyName}${site_project ? ` — ${site_project}` : ""}`,
    url: "/leads",
  };
  await Promise.all([pushToRole("manager", pushPayload), pushToRole("administrator", pushPayload)]);

  res.status(201).json({ ok: true, id: rows[0].id });
});

export default router;
