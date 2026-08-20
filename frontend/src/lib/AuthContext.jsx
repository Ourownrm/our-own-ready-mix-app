import { createContext, useContext, useState } from "react";
import { apiRequest } from "./api.js";
import { saveTokenToIndexedDb, clearTokenFromIndexedDb } from "./authDb.js";

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(() => {
    const stored = localStorage.getItem("oorm_user");
    return stored ? JSON.parse(stored) : null;
  });

  async function login(phone, password) {
    const data = await apiRequest("/auth/login", { method: "POST", body: { phone, password } });
    localStorage.setItem("oorm_token", data.token);
    localStorage.setItem("oorm_user", JSON.stringify(data.user));
    saveTokenToIndexedDb(data.token); // see authDb.js — lets the service worker act on notification buttons
    setUser(data.user);
    return data.user;
  }

  function logout() {
    localStorage.removeItem("oorm_token");
    localStorage.removeItem("oorm_user");
    clearTokenFromIndexedDb();
    setUser(null);
  }

  // Merges a partial change (e.g. { preferred_language: "ml" }) into the
  // signed-in user, both in memory and in localStorage — so a language
  // change (or any future self-service profile edit) survives a refresh
  // without needing a re-login.
  function updateUser(patch) {
    setUser((prev) => {
      if (!prev) return prev;
      const next = { ...prev, ...patch };
      localStorage.setItem("oorm_user", JSON.stringify(next));
      return next;
    });
  }

  return (
    <AuthContext.Provider value={{ user, login, logout, updateUser }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
