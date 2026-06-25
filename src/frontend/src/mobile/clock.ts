export type MobileClockFormatOptions = {
  locale: string;
  hour12: boolean;
  showPeriod: boolean;
  showSeconds: boolean;
};

export function formatMobileClockTime(date: Date, options: MobileClockFormatOptions): string {
  const formatOptions: Intl.DateTimeFormatOptions = {
    hour: "2-digit",
    minute: "2-digit",
    second: options.showSeconds ? "2-digit" : undefined,
    hour12: options.hour12,
  };
  const formatter = new Intl.DateTimeFormat(options.locale === "auto" ? undefined : options.locale, formatOptions);
  if (!options.hour12 || options.showPeriod) {
    return formatter.format(date);
  }
  return formatter.formatToParts(date)
    .filter((part) => part.type !== "dayPeriod")
    .map((part) => part.value)
    .join("")
    .trim();
}

export function renderMobileClockContent(container: HTMLElement, timeText: string) {
  const text = document.createElement("span");
  text.className = "mobile-clock-text";
  text.textContent = timeText;
  container.replaceChildren(text);
}
