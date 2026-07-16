import { createContext, useContext, useState } from "react";
import { apiRequest } from "./api.js";

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
    setUser(data.user);
    return data.user;
  }

  function logout() {
    localStorage.removeItem("oorm_token");
    localStorage.removeItem("oorm_user");
    setUser(null);
  }

  return (
    <AuthContext.Provider value={{ user, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
