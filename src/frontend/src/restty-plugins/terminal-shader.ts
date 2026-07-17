import {
  RESTTY_PLUGIN_API_VERSION,
  type ResttyPlugin,
  type ResttyPluginContext,
  type ResttyRenderStageHandle,
} from "restty";

import { terminalShaderStageFor } from "../terminal-shaders/effects";
import type { TerminalShaderEffect } from "../types";

export const TERMINAL_SHADER_PLUGIN_ID = "lazycat/terminal-shader";

export type TerminalShaderPluginOptions = {
  effect: Exclude<TerminalShaderEffect, "off">;
  canvas: () => HTMLCanvasElement | null;
};

type InteractiveUniforms = {
  x: number;
  y: number;
  pointer: number;
  key: number;
  color: [number, number, number];
};

export function createTerminalShaderPlugin(options: TerminalShaderPluginOptions): ResttyPlugin {
  return {
    id: TERMINAL_SHADER_PLUGIN_ID,
    version: "1.0.0",
    apiVersion: RESTTY_PLUGIN_API_VERSION,
    requires: {
      pluginApi: {
        min: RESTTY_PLUGIN_API_VERSION,
        max: RESTTY_PLUGIN_API_VERSION,
      },
    },
    activate(ctx: ResttyPluginContext) {
      const stage = ctx.addRenderStage(terminalShaderStageFor(options.effect));
      if (options.effect !== "interactive-glow") {
        return () => stage.dispose();
      }
      return activateInteractiveGlow(ctx, stage, options.canvas);
    },
  };
}

function activateInteractiveGlow(
  ctx: ResttyPluginContext,
  stage: ResttyRenderStageHandle,
  canvasForPane: () => HTMLCanvasElement | null,
): () => void {
  const uniforms: InteractiveUniforms = {
    x: 0.5,
    y: 0.5,
    pointer: 0,
    key: 0,
    color: [1, 1, 1],
  };
  let frame = 0;
  const cleanups: Array<() => void> = [];

  const update = () => {
    stage.setUniforms([
      uniforms.x,
      uniforms.y,
      uniforms.pointer,
      uniforms.key,
      uniforms.color[0],
      uniforms.color[1],
      uniforms.color[2],
      1,
    ]);
  };

  const startDecay = () => {
    if (frame) return;
    const tick = () => {
      uniforms.pointer *= 0.86;
      uniforms.key *= 0.82;
      update();
      if (uniforms.pointer > 0.01 || uniforms.key > 0.01) {
        frame = window.requestAnimationFrame(tick);
      } else {
        uniforms.pointer = 0;
        uniforms.key = 0;
        update();
        frame = 0;
      }
    };
    frame = window.requestAnimationFrame(tick);
  };

  const attachPointer = () => {
    const canvas = canvasForPane();
    if (!canvas) return;
    const updateColor = () => {
      uniforms.color = readTerminalAccentColor(canvas);
    };
    const onPointerMove = (event: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      updateColor();
      uniforms.x = clamp01((event.clientX - rect.left) / rect.width);
      uniforms.y = clamp01((event.clientY - rect.top) / rect.height);
      uniforms.pointer = 0.9;
      update();
      startDecay();
    };
    canvas.addEventListener("pointermove", onPointerMove, { passive: true });
    cleanups.push(() => canvas.removeEventListener("pointermove", onPointerMove));
  };

  attachPointer();
  const input = ctx.addInputInterceptor(({ source }) => {
    if (source !== "pty" && source !== "program") {
      const canvas = canvasForPane();
      if (canvas) uniforms.color = readTerminalAccentColor(canvas);
      uniforms.key = 1;
      update();
      startDecay();
    }
    return undefined;
  });

  return () => {
    input.dispose();
    stage.dispose();
    if (frame) {
      window.cancelAnimationFrame(frame);
      frame = 0;
    }
    for (const cleanup of cleanups.splice(0)) {
      cleanup();
    }
  };
}

function readTerminalAccentColor(target: HTMLElement): [number, number, number] {
  const style = window.getComputedStyle(target);
  return parseCssColor(style.getPropertyValue("--term-cursor"))
    ?? parseCssColor(style.getPropertyValue("--term-fg"))
    ?? [1, 1, 1];
}

function parseCssColor(value: string): [number, number, number] | undefined {
  const trimmed = value.trim();
  const hex = /^#?([0-9a-f]{6})$/i.exec(trimmed);
  if (hex) {
    const raw = hex[1];
    return [
      Number.parseInt(raw.slice(0, 2), 16) / 255,
      Number.parseInt(raw.slice(2, 4), 16) / 255,
      Number.parseInt(raw.slice(4, 6), 16) / 255,
    ];
  }
  const rgb = /^rgba?\(([^)]+)\)$/i.exec(trimmed);
  if (!rgb) return undefined;
  const parts = rgb[1].split(",").map((part) => Number.parseFloat(part.trim()));
  if (parts.length < 3 || parts.slice(0, 3).some((part) => !Number.isFinite(part))) return undefined;
  return [clamp01(parts[0] / 255), clamp01(parts[1] / 255), clamp01(parts[2] / 255)];
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}
