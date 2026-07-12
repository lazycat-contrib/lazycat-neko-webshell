import assert from "node:assert/strict";
import test from "node:test";

import {
  activeAiProviderProfile,
  normalizeAiProviderValue,
  sanitizeAiProviderProfile,
  syncActiveAiProviderProfile,
  upsertAiProviderProfile,
} from "./provider-profile-state.ts";
import {
  normalizeAIConfigDialogType,
  normalizeAISettingsTab,
} from "./dialog-state.ts";

function settings(overrides = {}) {
  return {
    aiProvider: "openai-compatible",
    aiBaseUrl: "",
    aiApiKey: "",
    aiModel: "",
    aiProviderProfiles: [],
    aiActiveProviderProfileId: "",
    ...overrides,
  };
}

function profile(index, overrides = {}) {
  return {
    id: `provider-${index}`,
    name: `Provider ${index}`,
    provider: "openai-compatible",
    baseUrl: `https://example.com/${index}`,
    apiKey: `key-${index}`,
    model: `model-${index}`,
    ...overrides,
  };
}

test("normalizes supported AI providers and falls back for unknown values", () => {
  assert.equal(normalizeAiProviderValue("openai-responses"), "openai-responses");
  assert.equal(normalizeAiProviderValue("anthropic"), "anthropic");
  assert.equal(normalizeAiProviderValue("unknown"), "openai-compatible");
});

test("sanitizes provider profile identity and user-editable fields", () => {
  assert.deepEqual(
    sanitizeAiProviderProfile({
      id: "  ",
      name: `  ${"Long".repeat(20)}  `,
      provider: "invalid",
      baseUrl: "  https://example.com/v1  ",
      apiKey: "  secret  ",
      model: "  gpt-test  ",
    }, 1),
    {
      id: "provider-2",
      name: "Long".repeat(12),
      provider: "openai-compatible",
      baseUrl: "https://example.com/v1",
      apiKey: "  secret  ",
      model: "gpt-test",
    },
  );
});

test("falls back to the first profile and mirrors it into legacy settings", () => {
  const current = settings({
    aiProviderProfiles: [profile(1), profile(2)],
    aiActiveProviderProfileId: "missing",
  });

  syncActiveAiProviderProfile(current);

  assert.equal(activeAiProviderProfile(current)?.id, "provider-1");
  assert.equal(current.aiActiveProviderProfileId, "provider-1");
  assert.equal(current.aiBaseUrl, "https://example.com/1");
  assert.equal(current.aiApiKey, "key-1");
  assert.equal(current.aiModel, "model-1");
});

test("trims provider profiles to the supported maximum", () => {
  const current = settings({
    aiProviderProfiles: Array.from({ length: 12 }, (_, index) => profile(index + 1)),
    aiActiveProviderProfileId: "provider-1",
  });

  upsertAiProviderProfile(current, profile(13));

  assert.equal(current.aiProviderProfiles.length, 12);
  assert.equal(current.aiProviderProfiles.at(-1)?.id, "provider-12");
  assert.equal(current.aiActiveProviderProfileId, "provider-1");
});

test("normalizes AI settings tabs and dialog types", () => {
  assert.equal(normalizeAISettingsTab("mcp"), "mcp");
  assert.equal(normalizeAISettingsTab("voice"), "voice");
  assert.equal(normalizeAISettingsTab("unknown"), "ai");
  assert.equal(normalizeAIConfigDialogType("voice-reply"), "voice-reply");
  assert.equal(normalizeAIConfigDialogType("unknown"), "ai");
});
