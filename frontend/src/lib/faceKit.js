// Round 202 — face check for attendance on the phone, using face-api
// (@vladmandic/face-api) in the browser. Loaded only when the Mark attendance
// or face-enrolment screen opens: the library and its models (~7 MB, served
// from /face-models) are never part of the normal app download.
//
// What runs here: find the face, read its 68 landmarks, turn it into a
// 128-number descriptor, and watch the eyes for a blink. The match itself is
// decided on the server against the descriptor HR enrolled.
let apiPromise = null;

export function loadFaceApi() {
  if (!apiPromise) {
    apiPromise = (async () => {
      const faceapi = await import("@vladmandic/face-api");
      await faceapi.tf.ready();
      const url = "/face-models";
      await Promise.all([
        faceapi.nets.tinyFaceDetector.loadFromUri(url),
        faceapi.nets.faceLandmark68Net.loadFromUri(url),
        faceapi.nets.faceRecognitionNet.loadFromUri(url),
      ]);
      return faceapi;
    })().catch((e) => { apiPromise = null; throw e; });
  }
  return apiPromise;
}

export async function startCamera(video) {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error("This phone's browser can't open the camera.");
  const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } }, audio: false });
  video.srcObject = stream;
  video.setAttribute("playsinline", "true");
  video.muted = true;
  await video.play();
  return stream;
}
export function stopCamera(stream) {
  stream?.getTracks().forEach((t) => t.stop());
}

// Eye aspect ratio — falls sharply when the eye closes.
function ear(p) {
  const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  return (d(p[1], p[5]) + d(p[2], p[4])) / (2 * d(p[0], p[3]));
}
export function eyesOpenness(landmarks) {
  return (ear(landmarks.getLeftEye()) + ear(landmarks.getRightEye())) / 2;
}

// One look at the picture: the face (largest), its landmarks and descriptor.
export async function readFace(faceapi, input) {
  const opts = new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.5 });
  const r = await faceapi.detectSingleFace(input, opts).withFaceLandmarks().withFaceDescriptor();
  if (!r) return null;
  return { descriptor: Array.from(r.descriptor), landmarks: r.landmarks, box: r.detection.box, score: r.detection.score };
}

// Watch the camera until a blink is seen (eyes open → closed → open), or time
// runs out. Returns the descriptor taken with the eyes open, and whether a
// blink was seen. `onTick` gets a short status line for the screen.
export async function watchForBlink(faceapi, video, { timeoutMs = 7000, onTick } = {}) {
  const t0 = Date.now();
  let best = null, maxE = 0, closedSeen = false, blink = false;
  while (Date.now() - t0 < timeoutMs) {
    const f = await readFace(faceapi, video);
    if (!f) { onTick?.("Looking for your face…"); await new Promise((r) => setTimeout(r, 120)); continue; }
    const e = eyesOpenness(f.landmarks);
    if (e > maxE) maxE = e;
    // eyes open: keep the clearest picture; closed: well below the widest seen
    if (e >= maxE * 0.85 && (!best || f.score >= best.score)) best = f;
    if (maxE > 0.2 && e < maxE * 0.7) closedSeen = true;
    else if (closedSeen && e >= maxE * 0.85) blink = true;
    onTick?.(blink ? "Blink seen" : "Face found — blink once");
    if (blink && best) break;
    await new Promise((r) => setTimeout(r, 40));
  }
  return { face: best, live: blink };
}

// A small JPEG of the frame, for the punch record (about 15–30 KB).
export function snapshot(video, maxW = 320) {
  const w = Math.min(maxW, video.videoWidth || maxW);
  const h = Math.round(w * ((video.videoHeight || 240) / (video.videoWidth || 320)));
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  c.getContext("2d").drawImage(video, 0, 0, w, h);
  return c.toDataURL("image/jpeg", 0.7);
}

// This phone's own id, kept in the app's storage; the first phone a person
// marks attendance from becomes their registered phone.
export function deviceId() {
  try {
    let id = localStorage.getItem("oorm_device_id");
    if (!id) {
      id = (crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`);
      localStorage.setItem("oorm_device_id", id);
    }
    return id;
  } catch {
    return null;
  }
}

export function currentPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error("This phone's browser can't read the location."));
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy }),
      (e) => reject(new Error(e.code === 1 ? "Location is blocked. Allow location for this app in the phone's settings." : "Couldn't read the location. Step outside and try again.")),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 });
  });
}
