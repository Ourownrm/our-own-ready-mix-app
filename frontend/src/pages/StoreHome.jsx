import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { TopBar } from "../lib/TopBar.jsx";

export default function StoreHome() {
  const [manualUrl, setManualUrl] = useState("");
  const navigate = useNavigate();

  function goManual(e) {
    e.preventDefault();
    const match = manualUrl.match(/\/store\/scan\/([a-f0-9]+)/);
    if (match) navigate(`/store/scan/${match[1]}`);
  }

  return (
    <>
      <TopBar title="Store" />
      <div style={{ maxWidth: 380, margin: "0 auto", padding: "0 16px 32px", textAlign: "center" }}>
        <div style={{ marginTop: 40, marginBottom: 24 }}>
          <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 8 }}>Scan a request to issue it</div>
          <div style={{ fontSize: 13, color: "var(--slate)" }}>
            Use your phone's own camera app on the QR code shown on the requester's screen —
            it opens straight to the request details here.
          </div>
        </div>

        <form onSubmit={goManual} style={{ textAlign: "left" }}>
          <div style={{ fontSize: 12, color: "var(--slate)", marginBottom: 4 }}>Or paste the link if scanning isn't working</div>
          <input type="text" value={manualUrl} onChange={(e) => setManualUrl(e.target.value)} placeholder="https://.../store/scan/..." style={{ width: "100%", marginBottom: 8 }} />
          <button type="submit" style={{ width: "100%" }}>Go</button>
        </form>
      </div>
    </>
  );
}
