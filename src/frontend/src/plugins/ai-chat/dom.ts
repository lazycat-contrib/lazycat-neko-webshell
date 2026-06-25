export function replaceAIChatHistory(html: string, root: ParentNode = document) {
  const history = root.querySelector<HTMLElement>("#aiChatHistory");
  if (!history) return;
  history.innerHTML = html;
  scrollAIChatToBottom(root);
}

export function scrollAIChatToBottom(root: ParentNode = document) {
  const history = root.querySelector<HTMLElement>("#aiChatHistory");
  if (history) history.scrollTop = history.scrollHeight;
}

export function resizeAIChatInput(input: HTMLTextAreaElement) {
  input.style.height = "auto";
  input.style.height = `${Math.min(Math.max(input.scrollHeight, 40), 140)}px`;
}
