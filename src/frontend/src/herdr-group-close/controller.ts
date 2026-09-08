import type { MessageKey } from "../i18n.ts";
import type { HerdrBridgeState, HerdrSocketEnvelope, JsonRecord } from "../types.ts";
import { normalizeSelector } from "../workspace-selection.ts";

export type HerdrGroupCloseTarget = {
  selector: string;
  generation: number;
  workspaceId: string;
};

export type HerdrWorkspaceGroupMember = {
  workspaceId: string;
  label: string;
  repoKey: string;
  linked: boolean;
};

export type HerdrWorkspaceGroup = {
  parent: HerdrWorkspaceGroupMember;
  members: HerdrWorkspaceGroupMember[];
  signature: string;
};

type Translate = (key: MessageKey, values?: Record<string, string | number>) => string;

type HerdrGroupCloseControllerDeps = {
  target: () => HerdrGroupCloseTarget | undefined;
  isCurrent: (target: HerdrGroupCloseTarget) => boolean;
  canMutate: (target: HerdrGroupCloseTarget) => boolean;
  request: (
    method: "workspace.list" | "workspace.close",
    params: JsonRecord,
    target: HerdrGroupCloseTarget,
  ) => Promise<HerdrSocketEnvelope>;
  runExclusive: <T>(task: () => Promise<T>) => Promise<T>;
  confirm: (options: {
    title: string;
    message: string;
    confirmLabel: string;
    cancelLabel: string;
    danger: true;
  }) => Promise<boolean>;
  afterClose: (target: HerdrGroupCloseTarget) => Promise<void> | void;
  setGroupActionVisible: (visible: boolean) => void;
  onStatus: (message: string, tone: "ok" | "error" | "neutral") => void;
  tr: Translate;
};

const MAX_WORKSPACES = 128;
const MAX_CONFIRM_NAMES = 10;
const MAX_LABEL_LENGTH = 160;
const MAX_REPO_KEY_LENGTH = 4096;
const GROUP_CLOSE_REQUIRED = "workspace_group_close_required";

class HerdrGroupChangedError extends Error {}
class HerdrGroupTargetChangedError extends Error {}

export function herdrGroupCloseTarget(
  state: HerdrBridgeState | undefined,
  selectedSelector: string,
  generation: number,
): HerdrGroupCloseTarget | undefined {
  const selector = normalizeSelector(selectedSelector);
  if (!selector || !state?.available || normalizeSelector(state.selector) !== selector) return undefined;
  const workspace = state.workspaces.find((item) => item.workspace_id === state.focused_workspace_id)
    ?? state.workspaces.find((item) => item.focused)
    ?? state.workspaces[0];
  return workspace?.workspace_id
    ? { selector, generation, workspaceId: workspace.workspace_id }
    : undefined;
}

export function createHerdrGroupCloseController(deps: HerdrGroupCloseControllerDeps) {
  let observedKey = "";
  let observationVersion = 0;
  let groupActionVisible = false;

  function observe(target: HerdrGroupCloseTarget | undefined, workspaceFingerprint = "") {
    const key = target
      ? `${target.selector}\u0000${target.generation}\u0000${target.workspaceId}\u0000${workspaceFingerprint}`
      : "";
    if (key === observedKey) return;
    observedKey = key;
    const version = ++observationVersion;
    setGroupActionVisible(false);
    if (!target) return;
    void readGroup(target).then((group) => {
      if (version !== observationVersion || !targetMatches(target)) return;
      setGroupActionVisible(Boolean(group));
    }).catch(() => {
      if (version === observationVersion) setGroupActionVisible(false);
    });
  }

  async function closeWorkspace() {
    const target = deps.target();
    if (!target || !targetMatches(target)) return;
    try {
      await runSingleClose(target);
      await finishClose(target, false);
    } catch (error) {
      if (error instanceof HerdrGroupTargetChangedError) {
        deps.onStatus(deps.tr("status.herdrTargetChanged"), "neutral");
      } else if (herdrErrorCode(error) === GROUP_CLOSE_REQUIRED) {
        await confirmAndCloseGroup(target);
      } else {
        reportError(error, target);
      }
    }
  }

  async function closeWorkspaceGroup() {
    const target = deps.target();
    if (!target || !targetMatches(target)) return;
    await confirmAndCloseGroup(target);
  }

  async function runSingleClose(target: HerdrGroupCloseTarget) {
    await deps.runExclusive(async () => {
      assertTargetCurrent(target);
      await deps.request("workspace.close", { workspace_id: target.workspaceId }, target);
    });
  }

  async function confirmAndCloseGroup(target: HerdrGroupCloseTarget) {
    try {
      assertTargetCurrent(target);
      const before = await readGroup(target);
      if (!targetMatches(target)) throw new HerdrGroupTargetChangedError();
      if (!before) {
        setGroupActionVisible(false);
        deps.onStatus(deps.tr("status.herdrSpaceGroupUnavailable"), "neutral");
        return;
      }
      const confirmed = await deps.confirm(groupConfirmation(before, deps.tr));
      if (!confirmed) return;
      if (!targetMatches(target)) throw new HerdrGroupTargetChangedError();
      const after = await readGroup(target);
      if (!targetMatches(target)) throw new HerdrGroupTargetChangedError();
      if (!sameGroup(before, after)) throw new HerdrGroupChangedError();
      await deps.runExclusive(async () => {
        assertTargetCurrent(target);
        const latest = await readGroup(target);
        assertTargetCurrent(target);
        if (!sameGroup(before, latest)) throw new HerdrGroupChangedError();
        await deps.request("workspace.close", {
          workspace_id: target.workspaceId,
          close_group: true,
        }, target);
      });
      await finishClose(target, true);
    } catch (error) {
      if (error instanceof HerdrGroupTargetChangedError) {
        deps.onStatus(deps.tr("status.herdrTargetChanged"), "neutral");
      } else if (error instanceof HerdrGroupChangedError) {
        observe(deps.target(), "group-changed");
        deps.onStatus(deps.tr("status.herdrSpaceGroupChanged"), "neutral");
      } else {
        reportError(error, target);
      }
    }
  }

  async function readGroup(target: HerdrGroupCloseTarget): Promise<HerdrWorkspaceGroup | undefined> {
    const envelope = await deps.request("workspace.list", {}, target);
    return herdrWorkspaceGroup(envelope, target.workspaceId);
  }

  async function finishClose(target: HerdrGroupCloseTarget, grouped: boolean) {
    clear();
    await deps.afterClose(target);
    deps.onStatus(
      deps.tr(grouped ? "status.herdrSpaceGroupClosed" : "status.herdrSpaceClosed"),
      "ok",
    );
  }

  function targetMatches(expected: HerdrGroupCloseTarget): boolean {
    const current = deps.target();
    return Boolean(current)
      && current?.selector === expected.selector
      && current.generation === expected.generation
      && current.workspaceId === expected.workspaceId
      && deps.isCurrent(expected)
      && deps.canMutate(expected);
  }

  function assertTargetCurrent(target: HerdrGroupCloseTarget) {
    if (!targetMatches(target)) throw new HerdrGroupTargetChangedError();
  }

  function reportError(error: unknown, target: HerdrGroupCloseTarget) {
    if (!deps.isCurrent(target)) return;
    deps.onStatus(
      deps.tr("status.herdrActionFailed", {
        message: error instanceof Error ? error.message : String(error),
      }),
      "error",
    );
  }

  function setGroupActionVisible(visible: boolean) {
    if (groupActionVisible === visible) return;
    groupActionVisible = visible;
    deps.setGroupActionVisible(visible);
  }

  function clear() {
    observedKey = "";
    observationVersion += 1;
    setGroupActionVisible(false);
  }

  return {
    observe,
    closeWorkspace,
    closeWorkspaceGroup,
    clear,
    groupActionVisible: () => groupActionVisible,
  };
}

export function herdrWorkspaceGroup(
  envelope: HerdrSocketEnvelope,
  workspaceId: string,
): HerdrWorkspaceGroup | undefined {
  const values = envelope.result?.workspaces;
  if (!Array.isArray(values) || values.length > MAX_WORKSPACES) return undefined;
  const members: HerdrWorkspaceGroupMember[] = [];
  for (const value of values) {
    const member = parseWorkspaceGroupMember(value);
    if (member === undefined) return undefined;
    if (member) members.push(member);
  }
  const parent = members.find((member) => member.workspaceId === workspaceId);
  if (!parent || parent.linked || !parent.repoKey) return undefined;
  const group = members
    .filter((member) => member.repoKey === parent.repoKey)
    .sort((left, right) => left.workspaceId.localeCompare(right.workspaceId));
  if (group.length < 2) return undefined;
  return {
    parent,
    members: group,
    signature: JSON.stringify(group.map((member) => [
      member.workspaceId,
      member.label,
      member.repoKey,
      member.linked,
    ])),
  };
}

export function herdrWorkspaceFingerprint(
  workspaces: Array<{ workspace_id: string; label: string; tab_count: number; pane_count: number }>,
): string {
  return JSON.stringify(workspaces.map((workspace) => [
    workspace.workspace_id,
    workspace.label,
    workspace.tab_count,
    workspace.pane_count,
  ]));
}

function parseWorkspaceGroupMember(value: unknown): HerdrWorkspaceGroupMember | null | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const workspace = value as JsonRecord;
  const workspaceId = boundedText(workspace.workspace_id);
  const label = boundedText(workspace.label) || workspaceId;
  const worktree = workspace.worktree;
  if (!workspaceId) return undefined;
  if (worktree === undefined) return null;
  if (!worktree || typeof worktree !== "object" || Array.isArray(worktree)) return undefined;
  const record = worktree as JsonRecord;
  const repoKey = boundedIdentity(record.repo_key, MAX_REPO_KEY_LENGTH);
  if (!repoKey || typeof record.is_linked_worktree !== "boolean") return undefined;
  return { workspaceId, label, repoKey, linked: record.is_linked_worktree };
}

function boundedText(value: unknown): string {
  if (typeof value !== "string") return "";
  const text = value.trim().replace(/\s+/g, " ");
  return text.length <= MAX_LABEL_LENGTH ? text : "";
}

function boundedIdentity(value: unknown, maximum: number): string {
  if (typeof value !== "string") return "";
  const text = value.trim();
  return text.length <= maximum ? text : "";
}

function sameGroup(
  expected: HerdrWorkspaceGroup,
  actual: HerdrWorkspaceGroup | undefined,
): actual is HerdrWorkspaceGroup {
  return actual?.signature === expected.signature;
}

function groupConfirmation(group: HerdrWorkspaceGroup, tr: Translate) {
  const children = group.members.filter((member) => member.workspaceId !== group.parent.workspaceId);
  const visible = children.slice(0, MAX_CONFIRM_NAMES).map((member) => member.label).join(", ");
  const extraCount = Math.max(0, children.length - MAX_CONFIRM_NAMES);
  return {
    title: tr("confirm.closeHerdrSpaceGroupTitle"),
    message: tr("confirm.closeHerdrSpaceGroup", {
      parent: group.parent.label,
      count: children.length,
      children: visible,
      extra: extraCount ? tr("confirm.closeHerdrSpaceGroupExtra", { count: extraCount }) : "",
    }),
    confirmLabel: tr("action.closeHerdrSpaceGroup"),
    cancelLabel: tr("action.cancel"),
    danger: true as const,
  };
}

function herdrErrorCode(error: unknown): string {
  if (!error || typeof error !== "object" || Array.isArray(error)) return "";
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code.trim() : "";
}
