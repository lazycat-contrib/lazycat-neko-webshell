export function isSshSelector(selector: string): boolean {
  const [id, owner] = selector.trim().split("@");
  return owner === "ssh" && Boolean(id) && /^[A-Za-z0-9_.-]+$/.test(id);
}
