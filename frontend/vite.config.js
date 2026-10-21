import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  // Round 226 — the PDF reader's worker ships as .mjs; a static host may serve
  // .mjs with a type the browser refuses for a worker, so it goes out as .js.
  build: {
    rollupOptions: {
      output: {
        assetFileNames: (info) => (/\.mjs$/.test(info.name || (info.names && info.names[0]) || "") ? "assets/[name]-[hash].js" : "assets/[name]-[hash][extname]"),
      },
    },
  },
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
        // Round 202 — the face-check library (~1.3 MB) and its models are only
        // for the Mark attendance / face enrolment screens: fetched when those
        // open, never pushed to every phone with the app.
        globIgnores: ["**/face-api*.js", "**/face-models/**",
          // Round 223 — the PDF reader for bank statements (~1 MB, plus its
          // worker): only fetched when a statement is uploaded.
          "**/pdf-*.js", "**/pdf.worker*"],
        // Round 203 — the main app bundle reached 2.09 MB in v10.32, a few KB
        // under the plugin's 2 MiB default, and any growth past it made the
        // whole build FAIL (and so the Render deploy). 4 MiB keeps the app
        // shell precached so the PWA still opens offline. Splitting the bundle
        // into lazily-loaded routes is the longer-term fix.
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
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
