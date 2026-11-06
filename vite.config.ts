import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // When running the frontend alone (npm run dev:web) against the local test API server.
    proxy: process.env.API_PROXY ? { "/api": process.env.API_PROXY } : undefined,
  },
});
