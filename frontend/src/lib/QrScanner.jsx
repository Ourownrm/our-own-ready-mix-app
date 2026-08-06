import { useEffect, useRef, useState } from "react";

// Scans QR codes using the device camera, entirely within the app's own
// authenticated session — this is what avoids the native-camera-app flow
// bouncing through a logged-out browser tab and losing the token.
export default function QrScanner({ onDecode, onCancel }) {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const streamRef = useRef(null);
  const frameRef = useRef(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;

    async function start() {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
        if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return; }
        streamRef.current = stream;
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
        const jsQR = (await import("jsqr")).default;
        scanLoop(jsQR);
      } catch (err) {
        setError("Couldn't access the camera — check camera permission for this app.");
      }
    }

    function scanLoop(jsQR) {
      const video = videoRef.current;
      const canvas = canvasRef.current;
      if (!video || !canvas || video.readyState !== video.HAVE_ENOUGH_DATA) {
        frameRef.current = requestAnimationFrame(() => scanLoop(jsQR));
        return;
      }
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
      frameRef.current = requestAnimationFrame(() => scanLoop(jsQR));
    }

    start();
    return () => {
      cancelled = true;
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
          <video ref={videoRef} playsInline muted style={{ width: "100%", display: "block" }} />
          <div style={{ position: "absolute", inset: 0, border: "2px solid var(--rebar)", borderRadius: 12, pointerEvents: "none" }} />
        </div>
      )}
      <canvas ref={canvasRef} style={{ display: "none" }} />
      <div style={{ fontSize: 12, color: "var(--slate)", marginBottom: 10 }}>Point the camera at the QR code.</div>
      <button onClick={onCancel} style={{ padding: "6px 16px" }}>Cancel</button>
    </div>
  );
}
