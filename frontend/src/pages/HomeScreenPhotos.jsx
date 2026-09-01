// Round 131, item 4 — Manager/Admin manage the "From our plant & sites"
// photo gallery shown on the customer portal's Home screen (see
// pages/CustomerPortal.jsx's HomePhotoWidget for the customer-facing
// side). Upload reads the file client-side via FileReader into base64
// rather than a real multipart upload — matches
// routes/homeScreenPhotos.js's header comment: this app has no multipart
// middleware anywhere, and base64-over-JSON is the same convention every
// other upload in this app already uses (technical writings guides).
// Reordering is deliberately move-up/move-down buttons rather than actual
// drag-and-drop — no drag library exists anywhere else in this app, and
// this keeps it reliable on a touch device without adding one.
import { useEffect, useState } from "react";
import { TopBar } from "../lib/TopBar.jsx";
import { apiRequest } from "../lib/api.js";

const MAX_SIZE_BYTES = 5 * 1024 * 1024;

function fileToBase64(f) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",").pop());
    reader.onerror = () => reject(new Error("Couldn't read that file — please try again."));
    reader.readAsDataURL(f);
  });
}

function fmtSize(bytes) {
  if (bytes == null) return "—";
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function HomeScreenPhotos() {
  const [photos, setPhotos] = useState([]);
  const [images, setImages] = useState({}); // id -> data: URL
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const [locationTag, setLocationTag] = useState("plant");
  const [caption, setCaption] = useState("");
  const [file, setFile] = useState(null);
  const [uploading, setUploading] = useState(false);

  async function load() {
    try {
      const rows = await apiRequest("/home-screen-photos");
      setPhotos(rows);
      const entries = await Promise.all(
        rows.map((p) =>
          apiRequest(`/home-screen-photos/${p.id}/image`)
            .then((d) => [p.id, `data:${d.mime_type};base64,${d.data_base64}`])
            .catch(() => [p.id, null])
        )
      );
      setImages(Object.fromEntries(entries));
    } catch (err) {
      setError(err.message);
    }
  }
  useEffect(() => { load(); }, []);

  async function upload(e) {
    e.preventDefault();
    if (!file) return;
    if (file.size > MAX_SIZE_BYTES) {
      setError(`That photo is too large — please keep it under ${MAX_SIZE_BYTES / (1024 * 1024)}MB.`);
      return;
    }
    setError(""); setNotice(""); setUploading(true);
    try {
      const data_base64 = await fileToBase64(file);
      await apiRequest("/home-screen-photos", {
        method: "POST",
        body: { caption, location_tag: locationTag, filename: file.name, mime_type: file.type, data_base64 },
      });
      setCaption(""); setFile(null); setLocationTag("plant");
      const input = document.getElementById("home-photo-file-input");
      if (input) input.value = "";
      setNotice("Photo uploaded.");
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setUploading(false);
    }
  }

  async function saveField(photo, patch) {
    setError("");
    try {
      await apiRequest(`/home-screen-photos/${photo.id}`, { method: "PATCH", body: patch });
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function remove(photo) {
    if (!window.confirm(`Delete this photo${photo.caption ? ` ("${photo.caption}")` : ""}? Customers won't see it any more.`)) return;
    setError("");
    try {
      await apiRequest(`/home-screen-photos/${photo.id}`, { method: "DELETE" });
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function move(photo, direction) {
    const idx = photos.findIndex((p) => p.id === photo.id);
    const swapWith = direction === "up" ? idx - 1 : idx + 1;
    if (swapWith < 0 || swapWith >= photos.length) return;
    const reordered = [...photos];
    [reordered[idx], reordered[swapWith]] = [reordered[swapWith], reordered[idx]];
    setPhotos(reordered); // optimistic — feels instant on a touch device
    setError("");
    try {
      await apiRequest("/home-screen-photos/reorder", { method: "PUT", body: { order: reordered.map((p) => p.id) } });
    } catch (err) {
      setError(err.message);
      load(); // fall back to the real order if the save failed
    }
  }

  return (
    <div>
      <TopBar title="Home Screen Photos" />
      <div style={{ padding: 16, maxWidth: 980, margin: "0 auto" }}>
        {error && <div style={{ color: "var(--alert-red)", fontSize: 13, marginBottom: 12 }}>{error}</div>}
        {notice && <div style={{ color: "var(--signal-green)", fontSize: 13, marginBottom: 12 }}>{notice}</div>}

        <div className="card" style={{ marginBottom: 20, maxWidth: 520 }}>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>Upload a photo</div>
          <div style={{ fontSize: 12, color: "var(--slate)", marginBottom: 12, lineHeight: 1.5 }}>
            Shown in the customer app's "From our plant &amp; sites" widget on Home, in the order below — use the
            ↑/↓ arrows on a card to reorder. Toggle a photo off to hide it without deleting it.
          </div>
          <form onSubmit={upload} style={{ fontSize: 13 }}>
            <label style={{ display: "block", marginBottom: 10 }}>
              <span style={{ fontSize: 12, color: "var(--slate)", display: "block", marginBottom: 4 }}>Tag</span>
              <select value={locationTag} onChange={(e) => setLocationTag(e.target.value)}>
                <option value="plant">Plant</option>
                <option value="site">Site</option>
              </select>
            </label>
            <label style={{ display: "block", marginBottom: 10 }}>
              <span style={{ fontSize: 12, color: "var(--slate)", display: "block", marginBottom: 4 }}>Caption (optional)</span>
              <input type="text" value={caption} onChange={(e) => setCaption(e.target.value)} placeholder="e.g. Batching yard — Kasaragod" />
            </label>
            <label style={{ display: "block", marginBottom: 14 }}>
              <span style={{ fontSize: 12, color: "var(--slate)", display: "block", marginBottom: 4 }}>Photo — JPG, PNG or WEBP, up to 5MB</span>
              <input id="home-photo-file-input" type="file" accept="image/jpeg,image/png,image/webp" onChange={(e) => setFile(e.target.files?.[0] || null)} required />
            </label>
            <button type="submit" className="btn-primary" style={{ width: "100%" }} disabled={uploading || !file}>
              {uploading ? "Uploading..." : "Upload"}
            </button>
          </form>
        </div>

        {photos.length === 0 ? (
          <div className="card" style={{ fontSize: 12.5, color: "var(--slate)" }}>No photos uploaded yet.</div>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 16 }}>
            {photos.map((p, idx) => (
              <div key={p.id} className="card" style={{ padding: 0, overflow: "hidden" }}>
                <div style={{ position: "relative", height: 130, background: "var(--concrete)" }}>
                  {images[p.id] ? (
                    <img src={images[p.id]} alt={p.caption || "Photo"} style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
                  ) : (
                    <div style={{ width: "100%", height: "100%" }} />
                  )}
                  <span
                    style={{
                      position: "absolute", top: 8, left: 8, fontSize: 9.5, fontWeight: 800, letterSpacing: .4,
                      textTransform: "uppercase", color: "#fff", background: "rgba(0,0,0,.45)", padding: "3px 8px", borderRadius: 20,
                    }}
                  >
                    {p.location_tag === "site" ? "Site" : "Plant"}
                  </span>
                  {!p.is_visible && (
                    <span
                      style={{
                        position: "absolute", top: 8, right: 8, fontSize: 9.5, fontWeight: 800, letterSpacing: .4,
                        textTransform: "uppercase", color: "#fff", background: "var(--alert-red)", padding: "3px 8px", borderRadius: 20,
                      }}
                    >
                      Hidden
                    </span>
                  )}
                </div>
                <div style={{ padding: "10px 11px 12px" }}>
                  <div style={{ display: "flex", gap: 6, marginBottom: 7 }}>
                    <select
                      value={p.location_tag}
                      onChange={(e) => saveField(p, { location_tag: e.target.value })}
                      style={{ fontSize: 11 }}
                    >
                      <option value="plant">Plant</option>
                      <option value="site">Site</option>
                    </select>
                    <span style={{ fontSize: 10, color: "var(--border-strong)", alignSelf: "center", marginLeft: "auto" }}>
                      {fmtSize(p.size_bytes)}
                    </span>
                  </div>
                  <input
                    type="text"
                    defaultValue={p.caption || ""}
                    placeholder="Caption (optional)"
                    style={{ width: "100%", fontSize: 12, marginBottom: 8 }}
                    onBlur={(e) => {
                      if ((e.target.value || "") !== (p.caption || "")) saveField(p, { caption: e.target.value });
                    }}
                  />
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "var(--slate)", fontWeight: 600 }}>
                      <input type="checkbox" checked={p.is_visible} onChange={(e) => saveField(p, { is_visible: e.target.checked })} />
                      Visible
                    </label>
                    <div style={{ display: "flex", gap: 4 }}>
                      <button type="button" onClick={() => move(p, "up")} disabled={idx === 0} style={{ fontSize: 11, padding: "3px 7px" }} title="Move up">↑</button>
                      <button type="button" onClick={() => move(p, "down")} disabled={idx === photos.length - 1} style={{ fontSize: 11, padding: "3px 7px" }} title="Move down">↓</button>
                      <button type="button" onClick={() => remove(p)} style={{ fontSize: 11, padding: "3px 7px", color: "var(--alert-red)" }} title="Delete">Delete</button>
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
