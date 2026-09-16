export const MAX_COMPOSER_DRAFT_BYTES = 64 * 1024;
export const MAX_COMPOSER_DRAFTS = 24;

type Draft = {
  text: string;
};

export type DraftUpdate =
  | { ok: true; bytes: number }
  | { ok: false; reason: "too-large" | "capacity"; bytes: number };

export type ComposerSubmission = {
  readonly key: string;
  readonly text: string;
  readonly view: number;
  readonly draft: object;
};

export type SubmissionCompletion = {
  ownsView: boolean;
  cleared: boolean;
};

export function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

/**
 * Owns the composer's ephemeral drafts and view identity. Draft entries are
 * bounded without evicting user text: once the entry limit is reached, a new
 * target must wait for an explicit discard or a successful send to free room.
 */
export class MobileComposerModel {
  readonly #drafts = new Map<string, Draft>();
  readonly #maxDrafts: number;
  #activeKey: string | undefined;
  #view = 0;

  constructor(maxDrafts = MAX_COMPOSER_DRAFTS) {
    this.#maxDrafts = Math.max(1, maxDrafts);
  }

  open(key: string): string {
    this.#activeKey = key;
    this.#view += 1;
    return this.#drafts.get(key)?.text ?? "";
  }

  close(): void {
    this.#activeKey = undefined;
    this.#view += 1;
  }

  draft(key: string): string {
    return this.#drafts.get(key)?.text ?? "";
  }

  update(text: string): DraftUpdate {
    const key = this.#activeKey;
    if (!key) return { ok: false, reason: "capacity", bytes: 0 };
    const bytes = utf8ByteLength(text);
    if (bytes > MAX_COMPOSER_DRAFT_BYTES) return { ok: false, reason: "too-large", bytes };
    if (!text) {
      this.#drafts.delete(key);
      return { ok: true, bytes };
    }
    if (!this.#drafts.has(key) && this.#drafts.size >= this.#maxDrafts) {
      return { ok: false, reason: "capacity", bytes };
    }
    this.#drafts.set(key, { text });
    return { ok: true, bytes };
  }

  remove(key: string): void { this.#drafts.delete(key); }

  discard(): void {
    if (this.#activeKey) this.#drafts.delete(this.#activeKey);
  }

  beginSubmission(): ComposerSubmission | undefined {
    const key = this.#activeKey;
    if (!key) return undefined;
    const draft = this.#drafts.get(key);
    if (!draft?.text) return undefined;
    return { key, text: draft.text, view: this.#view, draft };
  }

  completeSubmission(submission: ComposerSubmission, succeeded: boolean): SubmissionCompletion {
    let cleared = false;
    if (succeeded && this.#drafts.get(submission.key) === submission.draft) {
      this.#drafts.delete(submission.key);
      cleared = true;
    }
    return {
      ownsView: this.#activeKey === submission.key && this.#view === submission.view,
      cleared,
    };
  }
}
