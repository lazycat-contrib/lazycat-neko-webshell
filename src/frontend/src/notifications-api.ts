export type NotificationPresentationHint = "center" | "toast" | "modal";

export type WebshellNotificationAction = {
  id: string;
  label: string;
  style?: "primary" | "danger";
  payload?: unknown;
};

export type WebshellNotification = {
  id: string;
  sourceKind: string;
  sourceId?: string;
  kind: "message" | "interactive" | "link";
  severity: "info" | "success" | "warning" | "error";
  presentationHint: NotificationPresentationHint;
  title: string;
  body: string;
  url?: string;
  actions: WebshellNotificationAction[];
  state: "unread" | "read" | "dismissed" | "actioned";
  createdAtMs: number;
  updatedAtMs: number;
};

export async function fetchNotifications(): Promise<WebshellNotification[]> {
  const response = await fetch(new URL("./api/notifications", window.location.href), {
    cache: "no-store",
    credentials: "same-origin",
  });
  if (!response.ok) {
    const detail = (await response.text()).trim();
    throw new Error(detail || "failed to load notifications");
  }
  const value = await response.json();
  if (!value || typeof value !== "object") return [];
  const notifications = (value as { notifications?: unknown }).notifications;
  if (!Array.isArray(notifications)) return [];
  return notifications.map(normalizeNotification).filter((notification): notification is WebshellNotification => Boolean(notification));
}

export async function markNotificationRead(id: string): Promise<void> {
  await postNotificationCommand(id, "read");
}

export async function dismissNotification(id: string): Promise<void> {
  await postNotificationCommand(id, "dismiss");
}

export async function runNotificationAction(id: string, actionId: string): Promise<void> {
  const response = await fetch(new URL(
    `./api/notifications/${encodeURIComponent(id)}/actions/${encodeURIComponent(actionId)}`,
    window.location.href,
  ), {
    method: "POST",
    cache: "no-store",
    credentials: "same-origin",
  });
  if (!response.ok) {
    const detail = (await response.text()).trim();
    throw new Error(detail || "failed to run notification action");
  }
}

async function postNotificationCommand(id: string, command: "read" | "dismiss"): Promise<void> {
  const response = await fetch(new URL(
    `./api/notifications/${encodeURIComponent(id)}/${command}`,
    window.location.href,
  ), {
    method: "POST",
    cache: "no-store",
    credentials: "same-origin",
  });
  if (!response.ok) {
    const detail = (await response.text()).trim();
    throw new Error(detail || `failed to ${command} notification`);
  }
}

function normalizeNotification(value: unknown): WebshellNotification | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const id = stringValue(record.id);
  if (!id) return undefined;
  return {
    id,
    sourceKind: stringValue(record.sourceKind) || "system",
    sourceId: optionalString(record.sourceId),
    kind: normalizeKind(record.kind),
    severity: normalizeSeverity(record.severity),
    presentationHint: normalizePresentationHint(record.presentationHint),
    title: stringValue(record.title),
    body: stringValue(record.body),
    url: optionalString(record.url),
    actions: Array.isArray(record.actions)
      ? record.actions.map(normalizeAction).filter((action): action is WebshellNotificationAction => Boolean(action))
      : [],
    state: normalizeState(record.state),
    createdAtMs: finiteTimestamp(record.createdAtMs),
    updatedAtMs: finiteTimestamp(record.updatedAtMs),
  };
}

function normalizeAction(value: unknown): WebshellNotificationAction | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const id = stringValue(record.id);
  const label = stringValue(record.label);
  if (!id || !label) return undefined;
  const style = record.style === "primary" || record.style === "danger" ? record.style : undefined;
  return {
    id,
    label,
    style,
    payload: record.payload,
  };
}

function normalizeKind(value: unknown): WebshellNotification["kind"] {
  return value === "interactive" || value === "link" ? value : "message";
}

function normalizeSeverity(value: unknown): WebshellNotification["severity"] {
  return value === "success" || value === "warning" || value === "error" ? value : "info";
}

function normalizePresentationHint(value: unknown): NotificationPresentationHint {
  return value === "toast" || value === "modal" ? value : "center";
}

function normalizeState(value: unknown): WebshellNotification["state"] {
  return value === "read" || value === "dismissed" || value === "actioned" ? value : "unread";
}

function optionalString(value: unknown): string | undefined {
  const text = stringValue(value);
  return text || undefined;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function finiteTimestamp(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}
