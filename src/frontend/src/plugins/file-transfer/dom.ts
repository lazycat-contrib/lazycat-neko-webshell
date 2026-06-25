import type { Tone } from "../../types";

export function setFileTransferOutput(message: string, tone: Tone = "neutral") {
  const output = document.querySelector<HTMLElement>("#fileTransferOutput");
  if (!output) return;
  output.textContent = message;
  output.dataset.tone = tone;
}
