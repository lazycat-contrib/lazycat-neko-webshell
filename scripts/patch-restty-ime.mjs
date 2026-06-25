import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const resttyEntryPath = require.resolve("restty");
const resttyRoot = dirname(dirname(resttyEntryPath));
const packageJsonPath = join(resttyRoot, "package.json");
const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));

if (packageJson.version !== "0.1.35") {
  throw new Error(`Unsupported restty version for IME patch: ${packageJson.version}`);
}

const chunkPath = join(resttyRoot, "dist", "chunk-zqscavsh.js");
const source = readFileSync(chunkPath, "utf8");

const marker = "const isImeProcessKeyEvent = (event) => event.key === \"Process\" || event.keyCode === 229 || event.which === 229;";
if (source.includes(marker)) {
  process.exit(0);
}

const search = `    const isMacInputSourceShortcut = (event) => isMacPlatform && event.ctrlKey && !event.metaKey && (event.code === "Space" || event.key === " " || event.key === "Spacebar");
    const shouldSkipKeyEvent = (event) => {
      const imeActive = typeof document !== "undefined" && imeInput ? document.activeElement === imeInput : false;
      const target = event.target;
      if (target && target !== imeInput && ["BUTTON", "SELECT", "INPUT", "TEXTAREA"].includes(target.tagName)) {
        return true;
      }
      if (target === imeInput) {
        if (interaction.imeState.composing || event.isComposing)
          return true;
        if (!event.ctrlKey && !event.metaKey && event.key.length === 1 && !event.repeat)
          return true;
      }
      if (imeInput && imeActive && !event.ctrlKey && !event.metaKey && !event.altKey && event.key.length === 1 && !event.repeat && !event.isComposing && !interaction.imeState.composing) {
        return true;
      }
      return false;
    };
    const onKeyDown = (event) => {
      if (isMacInputSourceShortcut(event)) {
        if (hasInputFocus())
          ensureImeInputFocus();
        return;
      }
      if (shouldSkipKeyEvent(event))
        return;
`;

const replacement = `    const isMacInputSourceShortcut = (event) => isMacPlatform && event.ctrlKey && !event.metaKey && (event.code === "Space" || event.key === " " || event.key === "Spacebar");
    const isImeProcessKeyEvent = (event) => event.key === "Process" || event.keyCode === 229 || event.which === 229;
    const shouldSkipKeyEvent = (event) => {
      const imeActive = typeof document !== "undefined" && imeInput ? document.activeElement === imeInput : false;
      const target = event.target;
      if (target && target !== imeInput && ["BUTTON", "SELECT", "INPUT", "TEXTAREA"].includes(target.tagName)) {
        return true;
      }
      if (isImeProcessKeyEvent(event)) {
        return true;
      }
      if (target === imeInput) {
        if (interaction.imeState.composing || event.isComposing)
          return true;
        if (!event.ctrlKey && !event.metaKey && event.key.length === 1 && !event.repeat)
          return true;
      }
      if (imeInput && imeActive && !event.ctrlKey && !event.metaKey && !event.altKey && event.key.length === 1 && !event.repeat && !event.isComposing && !interaction.imeState.composing) {
        return true;
      }
      return false;
    };
    const onKeyDown = (event) => {
      if (isMacInputSourceShortcut(event)) {
        if (hasInputFocus())
          ensureImeInputFocus();
        return;
      }
      if (isImeProcessKeyEvent(event)) {
        if (hasInputFocus())
          ensureImeInputFocus();
        return;
      }
      if (shouldSkipKeyEvent(event))
        return;
`;

if (!source.includes(search)) {
  throw new Error("Unable to apply restty IME patch: target code was not found");
}

writeFileSync(chunkPath, source.replace(search, replacement));
console.log("Applied restty IME keydown patch");
