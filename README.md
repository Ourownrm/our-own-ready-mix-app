# Our Own Ready Mix — App

Real, running codebase (not a mockup). This is phase 1 of the actual build.

## What's working right now
- **Database schema** (`backend/schema.sql`) — every table for all 7 roles, including
  Pump, Fuel, Reports data, and audit trail (the gaps we flagged, already designed in,
  even though their screens aren't built yet).
- **Backend API** (`backend/`) — sign-in, Order creation, Delivery Ticket creation with
  full Trip Status Timeline logging, Driver duty toggle + GPS ping ingestion, trip
  allowance auto-payout on completed delivery only, breakdown/fuel reporting, Plant QC,
  Site QC with reject-concrete flow, invoicing based on rate master, and payments
  supporting multiple receipts per invoice.
- **Frontend** (`frontend/`) — installable Progressive Web App (PWA), works offline for
  the Driver and Site Supervisor screens (queues actions locally, syncs automatically
  once back online), sign-in page, role-based routing for all 7 roles.
- **All 7 roles fully wired end-to-end**: Driver, Manager, Site Supervisor, Plant
  Operator/QC, Accountant, and Administrator (user management + master data: customers,
  sites, trucks, rates). Each was tested against a real database with full pipeline
  tests before being handed over, including role-security checks (e.g. confirming a
  Driver account cannot reach Administrator or Accountant routes).

## What's not built yet
Pump module, Fuel module, and the 12 Reports — schema is ready (see `schema.sql`),
screens are not. These were flagged in the original requirements gap analysis and
intentionally deferred.

A few smaller items also noted during the build, worth knowing about:
- Manager "approve rejected concrete" step isn't wired (rejections currently just notify
  the Manager, without a formal approval action)
- Site temperature isn't captured at the Site Supervisor step (only slump is)
- No audit-trail UI yet, though the underlying `audit_log` table exists in the schema
- Disabling a user takes effect on their next login; a currently-logged-in session
  isn't force-ended immediately (their token remains valid until it expires, up to 30 days)

## How to run this yourself

You'll need:
1. A PostgreSQL database. Any cloud provider works — Render, Railway, Supabase, or a
   Google Cloud / AWS managed database all offer free or low-cost starter tiers.
2. Node.js installed on whatever machine you're developing from (v18 or newer).

### Backend
```
cd backend
npm install
cp .env.example .env        # then fill in your real DATABASE_URL and a random JWT_SECRET
psql "$DATABASE_URL" -f schema.sql     # creates all the tables
node src/seed.js            # creates your first Administrator login
npm start
```
The seed script prints a phone number and password you can use to sign in immediately —
change that password as soon as you're in.

### Frontend
```
cd frontend
npm install
cp .env.example .env        # point VITE_API_URL at your backend's address
npm run dev                 # for local testing
npm run build                # for deploying the real, installable app
```

### Deploying for real use
The `frontend/dist` folder (after `npm run build`) can be hosted on any static hosting
service (Netlify, Vercel, Cloudflare Pages — many have free tiers). The `backend` folder
needs a Node.js hosting service (Render, Railway, Fly.io are common, simple choices).
None of this requires an Apple/Google developer account — it's a website your team opens
in their phone browser and adds to their home screen.
