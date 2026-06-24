import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { defineConfig, type Plugin } from "vite";

const packageJson = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version?: string };
const appIconPath = fileURLToPath(new URL("./icon.png", import.meta.url));

function appIconPlugin(): Plugin {
  return {
    name: "neko-app-icon",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (request.url?.split("?")[0] !== "/icon.png") {
          next();
          return;
        }
        response.statusCode = 200;
        response.setHeader("Content-Type", "image/png");
        response.setHeader("Cache-Control", "no-cache");
        response.end(readFileSync(appIconPath));
      });
    },
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "icon.png",
        source: readFileSync(appIconPath),
      });
    },
  };
}

export default defineConfig({
  root: "src/frontend",
  base: "./",
  plugins: [appIconPlugin()],
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
