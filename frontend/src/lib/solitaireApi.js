// Solitaire's own tiny fetch client — deliberately NOT the main app's
// apiRequest() (lib/api.js), which attaches the main app's own auth token.
// Solitaire authenticates with its own HttpOnly session + device cookies
// (see backend/lib/solitaireAuth.js), so every call here just needs
// credentials: "include" and the right base path.
//
// Round 149 — API_BASE was a bare relative "/api/solitaire", which would have
// worked only if the frontend and backend were one origin. They are not: on
// Render the frontend is a static site and the backend a separate web service,
// so a relative path resolves against the STATIC SITE and every Solitaire call
// would 404 against index.html. It now derives from the same VITE_API_URL the
// rest of the app uses (lib/api.js), so there is one place that knows where
// the backend is.
//
// The cookies this client relies on are therefore cross-site, which is why the
// backend sets SameSite=None on them and allows credentialed CORS from the
// frontend origin only — see backend lib/solitaireAuth.js and index.js. If
// Solitaire logs in and then immediately reports "not signed in", that pair of
// settings is the first place to look.
const API_ROOT = import.meta.env.VITE_API_URL || "http://localhost:4000/api";
const API_BASE = `${API_ROOT.replace(/\/$/, "")}/solitaire`;

class SolitaireApiError extends Error {
  constructor(message, status, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function request(path, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  let body = null;
  try { body = await res.json(); } catch { /* no body, e.g. a PDF stream */ }
  if (!res.ok) {
    throw new SolitaireApiError(body?.error || `Request failed (${res.status})`, res.status, body?.code);
  }
  return body;
}

export const solitaireApi = {
  login: (username, password) => request("/login", { method: "POST", body: JSON.stringify({ username, password }) }),
  logout: () => request("/logout", { method: "POST" }),
  me: () => request("/me"),

  devices: () => request("/devices"),
  registerDevice: (label) => request("/devices", { method: "POST", body: JSON.stringify({ label }) }),
  revokeDevice: (id) => request(`/devices/${id}`, { method: "DELETE" }),

  getSettings: () => request("/settings"),
  saveSettings: (patch) => request("/settings", { method: "PATCH", body: JSON.stringify(patch) }),

  customers: () => request("/customers"),
  createCustomer: (data) => request("/customers", { method: "POST", body: JSON.stringify(data) }),
  updateCustomer: (id, data) => request(`/customers/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
  deleteCustomer: (id) => request(`/customers/${id}`, { method: "DELETE" }),
  createSite: (customerId, name) => request(`/customers/${customerId}/sites`, { method: "POST", body: JSON.stringify({ name }) }),
  updateSite: (id, data) => request(`/sites/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
  deleteSite: (id) => request(`/sites/${id}`, { method: "DELETE" }),

  trucks: () => request("/trucks"),
  createTruck: (data) => request("/trucks", { method: "POST", body: JSON.stringify(data) }),
  updateTruck: (id, data) => request(`/trucks/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
  deleteTruck: (id) => request(`/trucks/${id}`, { method: "DELETE" }),

  mixDesigns: () => request("/mix-designs"),
  createMixDesign: (data) => request("/mix-designs", { method: "POST", body: JSON.stringify(data) }),
  updateMixDesign: (id, data) => request(`/mix-designs/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
  deleteMixDesign: (id) => request(`/mix-designs/${id}`, { method: "DELETE" }),

  nextBatchNumber: () => request("/next-batch-number"),
  previewDocket: (data) => request("/dockets/preview", { method: "POST", body: JSON.stringify(data) }),
  createDocket: (data) => request("/dockets", { method: "POST", body: JSON.stringify(data) }),
  searchDockets: (q) => request(`/dockets?q=${encodeURIComponent(q || "")}`),
  docketPdfUrl: (id) => `${API_BASE}/dockets/${id}/pdf`,
};

export { SolitaireApiError };
