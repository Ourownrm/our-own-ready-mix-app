import { useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import { TopBar } from "../lib/TopBar.jsx";
import QrScanner from "../lib/QrScanner.jsx";

export default function StoreHome() {
  const [scanning, setScanning] = useState(false);
  const [manualToken, setManualToken] = useState("");
  const navigate = useNavigate();

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
        <Link to="/fuel-report"><button type="button" style={{ width: "100%", marginTop: 20 }}>Fuel and lubricant report</button></Link>
      </div>
    </>
  );
}
