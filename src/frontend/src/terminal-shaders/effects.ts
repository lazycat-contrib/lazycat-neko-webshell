import type { ResttyShaderStage } from "restty";

import type { TerminalShaderEffect } from "../types";

export function terminalShaderStageFor(effect: Exclude<TerminalShaderEffect, "off">): ResttyShaderStage {
  if (effect === "soft-vignette") return softVignetteStage();
  if (effect === "scanline") return scanlineStage();
  return interactiveGlowStage();
}

function interactiveGlowStage(): ResttyShaderStage {
  return {
    id: "interactive-glow",
    mode: "after-main",
    backend: "both",
    uniforms: [0.5, 0.5, 0, 0, 1, 1, 1, 1],
    shader: {
      wgsl: `
fn resttyStage(color: vec4f, uv: vec2f, time: f32, params0: vec4f, params1: vec4f) -> vec4f {
  let pointer = clamp(params0.xy, vec2f(0.0), vec2f(1.0));
  let pointerPower = clamp(params0.z, 0.0, 1.0);
  let keyPower = clamp(params0.w, 0.0, 1.0);
  let accent = clamp(params1.rgb, vec3f(0.0), vec3f(1.0));
  let pointerDist = distance(uv, pointer);
  let pointerGlow = exp(-pointerDist * pointerDist * 54.0) * pointerPower * 0.22;
  let centerDist = distance(uv, vec2f(0.5, 0.5));
  let keyGlow = max(0.0, 1.0 - centerDist * 1.45) * keyPower * 0.05;
  let lift = accent * (pointerGlow + keyGlow);
  return vec4f(min(vec3f(1.0), color.rgb + lift), color.a);
}
`,
      glsl: `
vec4 resttyStage(vec4 color, vec2 uv, float time, vec4 params0, vec4 params1) {
  vec2 pointer = clamp(params0.xy, vec2(0.0), vec2(1.0));
  float pointerPower = clamp(params0.z, 0.0, 1.0);
  float keyPower = clamp(params0.w, 0.0, 1.0);
  vec3 accent = clamp(params1.rgb, vec3(0.0), vec3(1.0));
  float pointerDist = distance(uv, pointer);
  float pointerGlow = exp(-pointerDist * pointerDist * 54.0) * pointerPower * 0.22;
  float centerDist = distance(uv, vec2(0.5, 0.5));
  float keyGlow = max(0.0, 1.0 - centerDist * 1.45) * keyPower * 0.05;
  vec3 lift = accent * (pointerGlow + keyGlow);
  return vec4(min(vec3(1.0), color.rgb + lift), color.a);
}
`,
    },
  };
}

function softVignetteStage(): ResttyShaderStage {
  return {
    id: "soft-vignette",
    mode: "after-main",
    backend: "both",
    uniforms: [0.22],
    shader: {
      wgsl: `
fn resttyStage(color: vec4f, uv: vec2f, time: f32, params0: vec4f, params1: vec4f) -> vec4f {
  let strength = clamp(params0.x, 0.0, 0.6);
  let centered = (uv - vec2f(0.5, 0.5)) * 2.0;
  let vignette = max(0.0, 1.0 - strength * dot(centered, centered));
  return vec4f(color.rgb * vignette, color.a);
}
`,
      glsl: `
vec4 resttyStage(vec4 color, vec2 uv, float time, vec4 params0, vec4 params1) {
  float strength = clamp(params0.x, 0.0, 0.6);
  vec2 centered = (uv - vec2(0.5, 0.5)) * 2.0;
  float vignette = max(0.0, 1.0 - strength * dot(centered, centered));
  return vec4(color.rgb * vignette, color.a);
}
`,
    },
  };
}

function scanlineStage(): ResttyShaderStage {
  return {
    id: "scanline",
    mode: "after-main",
    backend: "both",
    uniforms: [0.045],
    shader: {
      wgsl: `
fn resttyStage(color: vec4f, uv: vec2f, time: f32, params0: vec4f, params1: vec4f) -> vec4f {
  let strength = clamp(params0.x, 0.0, 0.16);
  let line = 0.5 + 0.5 * sin(uv.y * stageUniforms.resolution.y * 3.14159265);
  let shade = 1.0 - line * strength;
  return vec4f(color.rgb * shade, color.a);
}
`,
      glsl: `
vec4 resttyStage(vec4 color, vec2 uv, float time, vec4 params0, vec4 params1) {
  float strength = clamp(params0.x, 0.0, 0.16);
  float line = 0.5 + 0.5 * sin(uv.y * u_resolution.y * 3.14159265);
  float shade = 1.0 - line * strength;
  return vec4(color.rgb * shade, color.a);
}
`,
    },
  };
}
