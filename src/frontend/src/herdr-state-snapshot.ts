import type { HerdrBridgeState } from "./types";

function snapshotValuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => snapshotValuesEqual(value, right[index]));
  }
  if (
    !left
    || !right
    || typeof left !== "object"
    || typeof right !== "object"
  ) {
    return false;
  }

  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).filter((key) => leftRecord[key] !== undefined).sort();
  const rightKeys = Object.keys(rightRecord).filter((key) => rightRecord[key] !== undefined).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => (
      key === rightKeys[index]
      && snapshotValuesEqual(leftRecord[key], rightRecord[key])
    ));
}

export function herdrBridgeStatesEqual(
  left: HerdrBridgeState | undefined,
  right: HerdrBridgeState,
): boolean {
  return left !== undefined && snapshotValuesEqual(left, right);
}
