import { fileURLToPath } from "node:url";
import path from "node:path";
import { createServer } from "vite";

const root = fileURLToPath(new URL("../../", import.meta.url));

export async function createSettingsUiPreview(port = 0, { configureDelayMs = 0, agentKind } = {}) {
  const ids = ["ai-chat", "file-transfer", "lightos-port-forward", "pomodoro", "public-tunnel", "terminal-mcp", "terminal-transfer", "white-noise"];
  const plugins = ids.map((id) => ({ id, displayName: id, kind: id === "ai-chat" ? "ai" : "productivity", scopes: ["terminal"], enabled: id !== "terminal-mcp", metadata: {} }));
  let settings = { locale: "en" };
  const agentUpdateCalls = [];
  const mock = {
    name: "settings-ui-isolated-api",
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const pathname = (request.url ?? "").split("?")[0];
        if (!pathname.startsWith("/api/") && !pathname.startsWith("/lazycat.webshell.v1.CapabilityService/")) return next();
        let text = "";
        for await (const chunk of request) text += chunk;
        let body = {};
        try { body = JSON.parse(text || "{}"); } catch { /* Some plugin requests contain raw payloads. */ }
        let result = {};
        if (pathname === "/api/runtime") result = { mode: agentKind ? "lightos" : "generic", lightosFeaturesEnabled: Boolean(agentKind), revision: "settings-ui-preview" };
        else if (pathname === "/api/agent/update") {
          if (request.method === "POST") { agentUpdateCalls.push(body); agentKind = body.optional ? "pending_restart" : "ready"; }
          result = { selector: "preview@owner", kind: agentKind, currentVersion: agentKind === "ready" ? 17 : 16,
            latestVersion: 17, minimumVersion: 11, protocol: "lazycat-neko-webshell-agent-v4", payloadManifest: "sha256:running" };
        }
        else if (pathname === "/api/settings") { if (request.method === "PUT") settings = body; result = settings; }
        else if (pathname === "/api/instances" && agentKind) result = [{ selector: "preview@owner", name: "preview", status: "running", ownerDeployId: "owner", username: "preview" }];
        else if (["/api/instances", "/api/fonts", "/api/terminal-backgrounds", "/api/ssh-profiles", "/api/ssh-config-hosts"].includes(pathname)) result = [];
        else if (pathname === "/api/ssh-config") result = { source: "isolated UI fixture", content: "", hosts: [], document: { globals: [], hosts: [], matches: [], includes: [], warnings: [] } };
        else if (pathname === "/api/sounds") result = { rootPath: "", exists: true, files: [] };
        else if (pathname.endsWith("/ListPlugins")) result = { plugins };
        else if (pathname.endsWith("/ConfigurePlugin")) {
          if (configureDelayMs) await new Promise((resolve) => setTimeout(resolve, configureDelayMs));
          const plugin = plugins.find((item) => item.id === body.pluginId);
          if (plugin) { plugin.enabled = body.enabled; plugin.metadata = body.metadata ?? {}; }
          result = { plugin };
        } else if (pathname.endsWith("/ListInstances")) result = { instances: [] };
        else if (pathname.endsWith("/ListSessions")) result = { sessions: [] };
        else if (pathname.endsWith("/InvokePlugin")) result = { metadata: {}, payload: "" };
        else if (pathname.includes("workspace")) result = { tabs: [], panes: [], revision: 0 };
        response.setHeader("content-type", "application/json");
        response.statusCode = 200;
        response.end(JSON.stringify(result));
      });
    },
  };
  const server = await createServer({ configFile: path.join(root, "vite.config.ts"), plugins: [mock], server: { host: "127.0.0.1", port, strictPort: true } });
  await server.listen();
  server.agentUpdateCalls = agentUpdateCalls;
  server.setAgentKind = (kind) => { agentKind = kind; };
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const server = await createSettingsUiPreview(Number(process.argv[2] ?? 18574));
  console.log(`Isolated settings preview: http://127.0.0.1:${server.httpServer.address().port}`);
}
