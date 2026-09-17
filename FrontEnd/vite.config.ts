import path from "node:path";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";

// Vite auto-loads .env.local into import.meta.env for CLIENT code, but this
// config file itself runs in Node before that — it needs loadEnv() to read
// VITE_API_PROXY too, otherwise it silently falls back to the hardcoded
// default below regardless of what .env.local says.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");

  return {
    plugins: [
      react(),
      tailwindcss(),
      VitePWA({
        registerType: "autoUpdate",
        includeAssets: ["favicon.svg", "icons/*.png"],
        manifest: {
          name: "DRIG Tech Support",
          short_name: "DRIG",
          description: "Grounded install and wiring support for field technicians.",
          display: "standalone",
          orientation: "portrait",
          background_color: "#ffffff",
          theme_color: "#0b2f5c",
          icons: [
            { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
            { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
            {
              src: "/icons/icon-512-maskable.png",
              sizes: "512x512",
              type: "image/png",
              purpose: "maskable",
            },
          ],
        },
        workbox: {
          navigateFallback: "index.html",
          globPatterns: ["**/*.{js,css,html,svg,png,woff2}"],
          runtimeCaching: [
            {
              // §9: a technician who lost signal after receiving an answer must
              // still be able to read step 4. Conversations are cached, not just the shell.
              urlPattern: /\/api\/(conversations|citations)\//,
              handler: "NetworkFirst",
              options: {
                cacheName: "drig-api",
                networkTimeoutSeconds: 5,
                expiration: { maxEntries: 60, maxAgeSeconds: 60 * 60 * 24 * 7 },
              },
            },
          ],
        },
        devOptions: { enabled: false },
      }),
    ],
    resolve: {
      alias: { "@": path.resolve(import.meta.dirname, "./src") },
    },
    server: {
      proxy: {
        "/api": {
          target: env.VITE_API_PROXY || "http://localhost:8080",
          changeOrigin: true,
        },
      },
    },
  };
});
