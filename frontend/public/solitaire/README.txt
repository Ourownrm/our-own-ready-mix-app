Panel artwork for the Delivery Challan (Solitaire) module.

  screen-reference.png  (1366x721)  — the MCI370 control panel, supplied by the
                                      user on 22 Sep 2026. The data-entry screen
                                      overlays live fields on this image.

The overlay coordinates in pages/Solitaire/SolitaireApp.jsx were MEASURED from
this exact file: the green dropdowns and white fields were detected in the
image and converted to percentages. If you replace this image, re-measure them
rather than nudging by eye — and keep the 1366x721 aspect ratio, since
.sol-entry-bg sets it explicitly.

login-bg.jpg is optional. Without it the login screen falls back to the solid
green in solitaire.css, which is why that screen looks plain.

If screen-reference.png ever fails to load, the module shows a plain visible
toolbar instead (see `imgFailed` in SolitaireApp.jsx) so the menus stay
reachable. Round 149 shipped without that fallback AND without the image, and
the module was unusable as a result.
