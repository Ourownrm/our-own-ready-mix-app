Round 149 — TWO IMAGE FILES ARE STILL MISSING FROM THIS FOLDER.

The Solitaire (Delivery Challan) screens were built as an overlay on
photographs of the real Schwing Stetter MCI370 control panel. The code
references these two files by exact name:

  login-bg.jpg          — the login screen background (pages/Solitaire/solitaire.css)
  screen-reference.png  — the data-entry panel  (pages/Solitaire/SolitaireApp.jsx)

They were never delivered with the module's code, and cannot be recreated
from it. Until you drop them in here, both screens render with the plain
fallback background in solitaire.css instead of the panel artwork — every
control still works, it just doesn't look like the MCI370 yet.

Drop the two files in with exactly those names and redeploy. No code change
is needed.
