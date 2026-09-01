// Round 119 — a small, deliberately SEPARATE fetch helper for the customer
// portal (/portal), rather than reusing lib/api.js's apiRequest(). That one
// always attaches whatever staff login token (`oorm_token`) happens to be
// sitting in localStorage — fine for every staff screen, but wrong here: on
// a shared/kiosk browser where a staff member is also logged in, or one
// that's ever had a staff login on it, apiRequest would silently send the
// STAFF token instead of the customer's own portal session, and the two
// aren't interchangeable anyway (separate secret, separate expiry, no
// `role` claim — see routes/customerPortal.js). Keeping its own storage key
// and its own header logic means the two sessions can never cross.
const BASE_URL = import.meta.env.VITE_API_URL || "http://localhost:4000/api";
const STORAGE_KEY = "oorm_customer_session";

export function getCustomerSession() {
  return localStorage.getItem(STORAGE_KEY);
}
export function setCustomerSession(token) {
  localStorage.setItem(STORAGE_KEY, token);
}
export function clearCustomerSession() {
  localStorage.removeItem(STORAGE_KEY);
}

export async function customerPortalRequest(path, { method = "GET", body } = {}) {
  const token = getCustomerSession();
  const res = await fetch(`${BASE_URL}/customer-portal${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || "Something went wrong. Please try again.");
    err.status = res.status;
    throw err;
  }
  return data;
}
