import type { HerdrJumpDevice } from "./herdr-jump-model.ts";

export type HerdrJumpPlatform = {
  device: () => HerdrJumpDevice;
  isMobile: () => boolean;
  onOpen: () => void;
  onClose: (fromHistory: boolean) => void;
  onDeviceChange: (handler: () => void) => void;
  destroy: () => void;
};

export type HerdrJumpPlatformFactory = (
  onRequestClose: (fromHistory: boolean) => void,
) => HerdrJumpPlatform;
