import { useEffect, useRef, useState } from "react";
import jsQR from "jsqr";

// Scans QR codes using the device camera, entirely within the app's own
// authenticated session — this is what avoids the native-camera-app flow
// bouncing through a logged-out browser tab and losing the token.
//
// jsQR is imported statically (not dynamically) — a dynamic import failing
// silently on some mobile browsers was the leading suspect for "camera
// shows but nothing happens": the video renders fine either way since
// that's just getUserMedia, but if the import never resolves, the scan
// loop that depends on it never starts, with no visible sign anything's
// wrong. A static import removes that failure mode entirely.
export default function QrScanner({ onDecode, onCancel }) {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const streamRef = useRef(null);
  const frameRef = useRef(null);
  const [error, setError] = useState("");
  const [slow, setSlow] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function start() {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
        if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return; }
        streamRef.current = stream;
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
        scanLoop();
      } catch (err) {
        setError("Couldn't access the camera — check camera permission for this app in Settings.");
      }
    }

    function scanLoop() {
      if (cancelled) return;
      const video = videoRef.current;
      const canvas = canvasRef.current;
      // videoWidth > 0 is the reliable, permissive signal that a real frame
      // is available — readyState reporting is inconsistent enough across
      // mobile browsers that requiring HAVE_ENOUGH_DATA specifically can
      // stall forever even while the video is visibly playing.
      if (!video || !canvas || !video.videoWidth) {
        frameRef.current = requestAnimationFrame(scanLoop);
        return;
      }
      try {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const code = jsQR(imageData.data, imageData.width, imageData.height);
        if (code && code.data) {
          onDecode(code.data);
          return; // stop the loop — cleanup below stops the camera
        }
      } catch {
        // A transient frame-read error — try the next frame rather than
        // dying silently on it.
      }
      frameRef.current = requestAnimationFrame(scanLoop);
    }

    start();
    const slowTimer = setTimeout(() => setSlow(true), 8000);
    return () => {
      cancelled = true;
      clearTimeout(slowTimer);
      if (frameRef.current) cancelAnimationFrame(frameRef.current);
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, [onDecode]);

  return (
    <div style={{ textAlign: "center" }}>
      {error ? (
        <div style={{ color: "var(--alert-red)", fontSize: 13, marginBottom: 12 }}>{error}</div>
      ) : (
        <div style={{ position: "relative", width: "100%", maxWidth: 320, margin: "0 auto 12px", borderRadius: 12, overflow: "hidden" }}>
          <video ref={videoRef} playsInline muted autoPlay style={{ width: "100%", display: "block" }} />
          <div style={{ position: "absolute", inset: 0, border: "2px solid var(--rebar)", borderRadius: 12, pointerEvents: "none" }} />
        </div>
      )}
      <canvas ref={canvasRef} style={{ display: "none" }} />
      <div style={{ fontSize: 12, color: "var(--slate)", marginBottom: 6 }}>Point the camera at the QR code.</div>
      {slow && !error && (
        <div style={{ fontSize: 12, color: "var(--amber)", marginBottom: 10 }}>
          Still looking — hold steady and make sure the whole code is in view. If it keeps not finding it, cancel and enter the code manually instead.
        </div>
      )}
      <button onClick={onCancel} style={{ padding: "6px 16px" }}>Cancel</button>
    </div>
  );
}
