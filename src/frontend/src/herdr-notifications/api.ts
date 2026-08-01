export type HerdrLazycatNotificationPayload = {
  title: string;
  body: string;
};

export async function postHerdrLazycatNotification(
  payload: HerdrLazycatNotificationPayload,
): Promise<void> {
  const response = await fetch(
    new URL("./api/herdr/lazycat-notification", window.location.href),
    {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    },
  );
  if (response.ok) return;
  const detail = (await response.text()).trim();
  throw new Error(detail || `LazyCat notification request failed (${response.status})`);
}
