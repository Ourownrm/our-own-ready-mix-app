import { useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import { TopBar } from "../lib/TopBar.jsx";
import QrScanner from "../lib/QrScanner.jsx";
import { usePermissions } from "../lib/PermissionContext.jsx";

export default function StoreHome() {
  const [scanning, setScanning] = useState(false);
  const [manualToken, setManualToken] = useState("");
  const navigate = useNavigate();
  // Round 164 — the links here are permission-driven now, so a grant made on
  // the Super Admin screen actually appears (and a revoke removes it). Before
  // this the three links were hardcoded, so Store having material.weighbridge
  // access in the catalogue showed up nowhere — the exact gap reported.
  const { can, ready } = usePermissions();

  function handleDecode(token) {
    setScanning(false);
    navigate(`/store/scan/${token}`);
  }

  function goManual(e) {
    e.preventDefault();
    if (manualToken.trim()) navigate(`/store/scan/${manualToken.trim()}`);
  }

  return (
    <>
      <TopBar title="Store" />
      <div style={{ maxWidth: 380, margin: "0 auto", padding: "0 16px 32px", textAlign: "center" }}>
        {scanning ? (
          <div style={{ marginTop: 20 }}>
            <QrScanner onDecode={handleDecode} onCancel={() => setScanning(false)} />
          </div>
        ) : (
          <>
            <div style={{ marginTop: 40, marginBottom: 24 }}>
              <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 8 }}>Scan a request to issue it</div>
              <div style={{ fontSize: 13, color: "var(--slate)" }}>
                Tap below and point your camera at the QR code shown on the requester's screen.
              </div>
            </div>

            <button onClick={() => setScanning(true)} style={{ width: "100%", padding: 14, fontSize: 15, fontWeight: 600, marginBottom: 20 }}>
              Tap to scan
            </button>

            <form onSubmit={goManual} style={{ textAlign: "left" }}>
              <div style={{ fontSize: 12, color: "var(--slate)", marginBottom: 4 }}>Or enter the code if scanning isn't working</div>
              <input type="text" value={manualToken} onChange={(e) => setManualToken(e.target.value)} placeholder="Paste the code" style={{ width: "100%", marginBottom: 8 }} />
              <button type="submit" style={{ width: "100%" }}>Go</button>
            </form>
          </>
        )}
        {/* Round 164 — each link shows only when the person's permissions
            include it, so what Super Admin grants is what Store sees. Store's
            own consumables (store-stock) are always theirs; the rest follow
            the catalogue. The Weighbridge link is new here — Store had
            weighbridge access in the catalogue but no way to reach it. */}
        {ready && (
          <>
            {/* Round 199 — diesel has its own module; Store Stock keeps lubricants. */}
            {can("module.fuel", "view") &&
              <Link to="/fuel-module"><button type="button" className="btn-primary" style={{ width: "100%", marginTop: 20 }}>Fuel — tank, issues &amp; purchases</button></Link>}
            <Link to="/store-stock"><button type="button" style={{ width: "100%", marginTop: can("module.fuel", "view") ? 10 : 20 }}>Lubricant stock &amp; purchases</button></Link>
            {can("material.module", "view") &&
              <Link to="/material-module"><button type="button" style={{ width: "100%", marginTop: 10 }}>Material Module</button></Link>}
            {can("module.weighbridge", "view") &&
              <Link to="/weighbridge"><button type="button" style={{ width: "100%", marginTop: 10 }}>Weighbridge</button></Link>}
            {can("reports.fuel", "view") &&
              <Link to="/fuel-report"><button type="button" style={{ width: "100%", marginTop: 10 }}>Fuel and lubricant report</button></Link>}
            {/* Round 172 — plant production & consumption, once the plant-data permission is granted. */}
            {can("module.plant-production", "view") &&
              <Link to="/plant-production"><button type="button" style={{ width: "100%", marginTop: 10 }}>Plant Production &amp; Consumption</button></Link>}
          </>
        )}
      </div>
    </>
  );
}
