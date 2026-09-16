import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_COMPOSER_DRAFT_BYTES,
  MobileComposerModel,
  utf8ByteLength,
} from "./model.ts";

test("isolates exact whitespace-preserving drafts by target", () => {
  const model = new MobileComposerModel();
  model.open("pane-a");
  assert.deepEqual(model.update("  first\nsecond\n"), { ok: true, bytes: 15 });
  model.close();

  assert.equal(model.open("pane-b"), "");
  assert.deepEqual(model.update("other"), { ok: true, bytes: 5 });
  assert.equal(model.open("pane-a"), "  first\nsecond\n");
  assert.equal(model.draft("pane-b"), "other");
});

test("enforces the 64 KiB UTF-8 limit without replacing the last valid draft", () => {
  const model = new MobileComposerModel();
  model.open("pane-a");
  const exact = `${"界".repeat(21_845)}a`;
  assert.equal(utf8ByteLength(exact), MAX_COMPOSER_DRAFT_BYTES);
  assert.equal(model.update(exact).ok, true);

  const oversized = `${exact}界`;
  assert.deepEqual(model.update(oversized), {
    ok: false,
    reason: "too-large",
    bytes: MAX_COMPOSER_DRAFT_BYTES + 3,
  });
  assert.equal(model.draft("pane-a"), exact);
});

test("retains a draft after failure and clears it only after success", () => {
  const model = new MobileComposerModel();
  model.open("pane-a");
  model.update("echo one\necho two");

  const failed = model.beginSubmission();
  assert.ok(failed);
  assert.deepEqual(model.completeSubmission(failed, false), { ownsView: true, cleared: false });
  assert.equal(model.draft("pane-a"), "echo one\necho two");

  const succeeded = model.beginSubmission();
  assert.ok(succeeded);
  assert.deepEqual(model.completeSubmission(succeeded, true), { ownsView: true, cleared: true });
  assert.equal(model.draft("pane-a"), "");
});

test("a stale pending completion cannot own or overwrite a newly opened target", () => {
  const model = new MobileComposerModel();
  model.open("pane-a");
  model.update("old target");
  const pending = model.beginSubmission();
  assert.ok(pending);

  model.close();
  model.open("pane-b");
  model.update("new target\ncontinues");
  assert.deepEqual(model.completeSubmission(pending, true), { ownsView: false, cleared: true });
  assert.equal(model.draft("pane-a"), "");
  assert.equal(model.draft("pane-b"), "new target\ncontinues");
});

test("a stale success does not clear edits made after its snapshot", () => {
  const model = new MobileComposerModel();
  model.open("pane-a");
  model.update("submitted");
  const pending = model.beginSubmission();
  assert.ok(pending);

  model.update("submitted\nnew work");
  assert.deepEqual(model.completeSubmission(pending, true), { ownsView: true, cleared: false });
  assert.equal(model.draft("pane-a"), "submitted\nnew work");
});

test("bounds retained targets without silently evicting existing drafts", () => {
  const model = new MobileComposerModel(2);
  model.open("pane-a");
  model.update("alpha");
  model.open("pane-b");
  model.update("beta");
  model.open("pane-c");

  assert.deepEqual(model.update("gamma"), { ok: false, reason: "capacity", bytes: 5 });
  assert.equal(model.draft("pane-a"), "alpha");
  assert.equal(model.draft("pane-b"), "beta");
  model.discard();
  model.open("pane-a");
  model.discard();
  model.open("pane-c");
  assert.equal(model.update("gamma").ok, true);
});
