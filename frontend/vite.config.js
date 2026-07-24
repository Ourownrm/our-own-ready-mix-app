import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      strategies: "injectManifest",
      srcDir: "src",
      filename: "sw.js",
      injectManifest: {
        // Keep the precache manifest from growing to include every build
        // artifact indiscriminately — same effective scope as the previous
        // auto-generated config.
        globPatterns: ["**/*.{js,css,html,png,svg,ico}"],
      },
      manifest: {
        name: "Our Own Ready Mix",
        short_name: "OORM",
        description: "Ready mix concrete logistics management",
        theme_color: "#C75B12",
        background_color: "#F3F1EC",
        display: "standalone",
        start_url: "/",
        icons: [
          { src: "icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "icon-512.png", sizes: "512x512", type: "image/png" },
        ],
      },
    }),
  ],
});
