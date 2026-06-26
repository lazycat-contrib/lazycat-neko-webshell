import type { PluginDescriptor } from "../../gen/lazycat/webshell/v1/capability_pb";
import type { MessageKey } from "../../i18n";
import { WHITE_NOISE_PLUGIN_ID } from "../../plugin-utils";
import type { createWhiteNoiseController } from "./controller";
import { renderWhiteNoiseFloatingControls } from "./floating-view";
import { whiteNoiseFloatingControlsEnabled } from "./settings-view";
import { renderWhiteNoiseToolView } from "./tool-view";

type Translate = (key: MessageKey, values?: Record<string, string | number>) => string;
type WhiteNoiseController = ReturnType<typeof createWhiteNoiseController>;

export function findWhiteNoisePlugin(plugins: PluginDescriptor[]): PluginDescriptor | undefined {
  return plugins.find((plugin) => plugin.id === WHITE_NOISE_PLUGIN_ID);
}

export function renderWhiteNoiseToolSurface(
  plugin: PluginDescriptor,
  controller: WhiteNoiseController,
  disabled: boolean,
  tr: Translate,
): string {
  return renderWhiteNoiseToolView({
    disabled,
    ...controller.viewState(),
    tr,
  });
}

export function renderWhiteNoiseFloatingSurfaceView(options: {
  container: HTMLElement;
  plugin: PluginDescriptor | undefined;
  controller: WhiteNoiseController;
  disabled: boolean;
  tr: Translate;
  updateIcons: () => void;
}): boolean {
  const playback = options.controller.viewState();
  const visible = Boolean(
    options.plugin?.enabled
      && whiteNoiseFloatingControlsEnabled(options.plugin.metadata)
      && playback.playing,
  );
  options.container.innerHTML = renderWhiteNoiseFloatingControls({
    visible,
    disabled: options.disabled,
    playback,
    tr: options.tr,
  });
  options.container.hidden = !visible;
  options.updateIcons();
  return visible && !playback.loading && !playback.tracks.length && !playback.error;
}

export async function runWhiteNoiseAction(
  controller: WhiteNoiseController,
  action: string,
): Promise<void> {
  if (action === "toggle") {
    await controller.togglePlayback();
  } else if (action === "stop") {
    controller.stop();
  } else if (action === "refresh") {
    await controller.refresh();
  } else if (action === "install") {
    await controller.installPackage();
  }
}

export async function runWhiteNoiseFloatingAction(
  controller: WhiteNoiseController,
  action: string,
): Promise<void> {
  if (action === "collapse") {
    controller.setFloatingCollapsed(true);
  } else if (action === "expand") {
    controller.setFloatingCollapsed(false);
  } else if (action === "toggle") {
    await controller.togglePlayback();
  } else if (action === "volume-up") {
    controller.stepMasterVolume("up");
  } else if (action === "volume-down") {
    controller.stepMasterVolume("down");
  }
}
