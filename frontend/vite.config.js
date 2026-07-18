import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
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
      workbox: {
        // App shell is cached so it opens with no signal.
        // Data mutations made offline are queued (see src/offlineQueue.js)
        // and flushed automatically once connectivity returns.
        runtimeCaching: [
          {
            urlPattern: /\/api\/orders/,
            handler: "NetworkFirst",
            options: { cacheName: "orders-cache", networkTimeoutSeconds: 3 },
          },
        ],
      },
    }),
  ],
});
