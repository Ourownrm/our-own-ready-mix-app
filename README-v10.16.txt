OORM v10.16 (Round 187)
=======================
REPLACE these 7 files in the GitHub repo (same paths), let Render redeploy,
then visit /setup?key=... ONCE (cleans up duplicate manual-production rows and
adds a one-per-day rule for them).

  backend/schema.sql
  backend/src/routes/setup.js
  backend/src/routes/plant.js
  backend/src/routes/materialModule.js
  frontend/src/pages/PlantProduction.jsx
  frontend/src/pages/MaterialModule.jsx
  frontend/src/lib/version.js        (footer shows v10.16)

1. Plant Production > Manual entry rebuilt: type, then press "Save <day>";
   "Discard changes"; changing the day never carries figures over; a
   "Saved manual entries" list with Edit; consumption entered in tonnes or kg;
   any material can be added (works on a day the plant was down).
   Also fixed: each save of manual m3 used to ADD a new row for the day.
2. Material Module > Receipts > Edit (admin): silo assignment can be changed;
   the receipt's silo fill is rebuilt (silo, qty, date). Deleting a receipt now
   removes its silo fill too.
4. Plant vs billed hidden from Plant Operator (and refused by the server).
