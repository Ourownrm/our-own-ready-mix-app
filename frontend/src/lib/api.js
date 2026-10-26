export const BASE_URL = import.meta.env.VITE_API_URL || "http://localhost:4000/api";

function getToken() {
  return localStorage.getItem("oorm_token");
}

export async function apiRequest(path, { method = "GET", body } = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(getToken() ? { Authorization: `Bearer ${getToken()}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || "Something went wrong. Please try again.");
    err.data = data;
    err.status = res.status;
    // Round 242 — the emergency lock: tell the app shell at once.
    if (typeof window !== "undefined") {
      if (res.status === 503 && data.code === "lockdown") window.dispatchEvent(new CustomEvent("oorm-lockdown", { detail: data }));
      if (res.status === 401 && data.code === "signed_out") window.dispatchEvent(new CustomEvent("oorm-signed-out"));
    }
    throw err;
  }
  return data;
}
