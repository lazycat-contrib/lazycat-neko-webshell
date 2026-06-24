import { readFileSync } from "node:fs";

import { defineConfig } from "vite";

const packageJson = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version?: string };

export default defineConfig({
  root: "src/frontend",
  base: "./",
  define: {
    "import.meta.env.VITE_APP_VERSION": JSON.stringify(packageJson.version ?? ""),
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: true,
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/lazycat.webshell.v1.CapabilityService": "http://127.0.0.1:8080",
      "/ws": {
        target: "ws://127.0.0.1:8080",
        ws: true,
      },
    },
  },
});
