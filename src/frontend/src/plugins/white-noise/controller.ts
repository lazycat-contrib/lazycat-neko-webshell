import type { MessageKey } from "../../i18n";
import {
  DEFAULT_SOUND_PACKAGE_URL,
  fetchSoundCatalog,
  installSoundPackage,
  type SoundCatalog,
  type SoundPackageInstallProgress,
  type SoundFile,
} from "./api";

type Translate = (key: MessageKey, values?: Record<string, string | number>) => string;

export type WhiteNoiseTrackState = {
  track: SoundFile;
  enabled: boolean;
  volume: number;
};

export type WhiteNoiseViewState = {
  catalog: SoundCatalog;
  loading: boolean;
  error: string;
  installError: string;
  installProgress: SoundPackageInstallProgress | undefined;
  installing: boolean;
  floatingCollapsed: boolean;
  playing: boolean;
  previewTrackId: string;
  helpOpen: boolean;
  masterVolume: number;
  packageUrl: string;
  tracks: WhiteNoiseTrackState[];
};

export type WhiteNoiseControllerOptions = {
  isEnabled: () => boolean;
  autoPlayOnSelect: () => boolean;
  tr: Translate;
  onRender: () => void;
  onStatus: (message: string, tone?: "neutral" | "ok" | "error") => void;
};

type StoredWhiteNoiseState = {
  floatingCollapsed?: boolean;
  masterVolume?: number;
  packageUrl?: string;
  tracks?: Record<string, {
    enabled?: boolean;
    volume?: number;
  }>;
};

const STORAGE_KEY = "lazycat-neko-webshell.white-noise.v2";
const DEFAULT_MASTER_VOLUME = 0.6;
const DEFAULT_TRACK_VOLUME = 0.72;
const VOLUME_STEP = 0.08;

const EMPTY_CATALOG: SoundCatalog = {
  rootPath: "/lzcapp/var/sounds",
  exists: false,
  files: [],
};

export function createWhiteNoiseController(options: WhiteNoiseControllerOptions) {
  const stored = loadStoredState();
  const players = new Map<string, HTMLAudioElement>();
  let catalog: SoundCatalog = EMPTY_CATALOG;
  let loading = false;
  let loaded = false;
  let error = "";
  let installError = "";
  let installProgress: SoundPackageInstallProgress | undefined;
  let installing = false;
  let floatingCollapsed = stored.floatingCollapsed === true;
  let masterVolume = normalizeVolume(stored.masterVolume, DEFAULT_MASTER_VOLUME);
  let packageUrl = stringOrDefault(stored.packageUrl, DEFAULT_SOUND_PACKAGE_URL);
  let playing = false;
  let previewPlayer: HTMLAudioElement | undefined;
  let previewTrackId = "";
  let helpOpen = false;
  let tracks: WhiteNoiseTrackState[] = [];

  function viewState(): WhiteNoiseViewState {
    return {
      catalog,
      loading,
      error,
      installError,
      installProgress,
      installing,
      floatingCollapsed,
      playing,
      previewTrackId,
      helpOpen,
      masterVolume,
      packageUrl,
      tracks: tracks.map((item) => ({ ...item })),
    };
  }

  async function ensureLoaded() {
    if (loaded || loading) return;
    await refresh(false);
  }

  async function refresh(showStatus = true) {
    if (loading) return;
    loading = true;
    error = "";
    options.onRender();
    try {
      catalog = await fetchSoundCatalog();
      loaded = true;
      reconcileTracks();
      saveState();
      if (showStatus) {
        options.onStatus(
          options.tr("status.whiteNoiseLoaded", { count: tracks.length }),
          "ok",
        );
      }
    } catch (loadError) {
      error = loadError instanceof Error ? loadError.message : String(loadError);
      if (showStatus) {
        options.onStatus(
          options.tr("status.whiteNoiseLoadFailed", { message: error }),
          "error",
        );
      }
    } finally {
      loading = false;
      options.onRender();
    }
  }

  function toggleHelp() {
    helpOpen = !helpOpen;
    options.onRender();
  }

  function setPackageUrl(value: string) {
    packageUrl = value;
    saveState();
  }

  function setFloatingCollapsed(value: boolean) {
    floatingCollapsed = value;
    saveState();
    options.onRender();
  }

  async function installPackage() {
    if (installing) return;
    const url = packageUrl.trim();
    if (!url) {
      installError = options.tr("validation.whiteNoisePackageUrl");
      options.onStatus(installError, "error");
      options.onRender();
      return;
    }
    installing = true;
    installError = "";
    installProgress = undefined;
    error = "";
    options.onRender();
    options.onStatus(options.tr("status.whiteNoiseInstalling"), "neutral");
    try {
      const result = await installSoundPackage(url, (progress) => {
        installProgress = progress;
        options.onRender();
      });
      catalog = result.catalog;
      loaded = true;
      installProgress = {
        phase: "complete",
        downloadedBytes: result.downloadedBytes,
        totalBytes: result.downloadedBytes,
        extractedBytes: result.extractedBytes,
        extractedFiles: result.extractedFiles,
        totalFiles: result.extractedFiles,
        skippedFiles: result.skippedFiles,
      };
      reconcileTracks();
      saveState();
      options.onStatus(
        options.tr("status.whiteNoiseInstallDone", { count: result.extractedFiles }),
        "ok",
      );
    } catch (installPackageError) {
      installError = installPackageError instanceof Error
        ? installPackageError.message
        : String(installPackageError);
      options.onStatus(
        options.tr("status.whiteNoiseInstallFailed", { message: installError }),
        "error",
      );
    } finally {
      installing = false;
      options.onRender();
    }
  }

  async function togglePlayback() {
    if (playing) {
      pause();
      return;
    }
    await play();
  }

  async function play() {
    if (!options.isEnabled()) return;
    await ensureLoaded();
    if (!tracks.length) {
      helpOpen = true;
      options.onStatus(options.tr("status.whiteNoiseNoSounds"), "error");
      options.onRender();
      return;
    }
    if (!enabledTracks().length) {
      options.onStatus(options.tr("status.whiteNoiseNoSelection"), "error");
      options.onRender();
      return;
    }
    stopPreview();
    try {
      await Promise.all(enabledTracks().map((item) => {
        const player = audioForTrack(item.track);
        player.loop = true;
        player.volume = mixedVolume(item.volume);
        return player.play();
      }));
      playing = true;
      options.onStatus(options.tr("status.whiteNoisePlaying"), "ok");
    } catch (playError) {
      playing = false;
      options.onStatus(
        options.tr("status.whiteNoisePlayFailed", {
          message: playError instanceof Error ? playError.message : String(playError),
        }),
        "error",
      );
    } finally {
      pauseDisabledTracks();
      options.onRender();
    }
  }

  function pause() {
    for (const player of players.values()) {
      player.pause();
    }
    stopPreview();
    playing = false;
    options.onRender();
  }

  function stop() {
    for (const player of players.values()) {
      player.pause();
      player.currentTime = 0;
    }
    stopPreview();
    playing = false;
    options.onStatus(options.tr("status.whiteNoiseStopped"), "neutral");
    options.onRender();
  }

  function setMasterVolume(value: unknown) {
    masterVolume = normalizeVolumeFromInput(value, masterVolume);
    applyVolumes();
    saveState();
    options.onRender();
  }

  function stepMasterVolume(direction: "up" | "down") {
    masterVolume = clampVolume(masterVolume + (direction === "up" ? VOLUME_STEP : -VOLUME_STEP));
    applyVolumes();
    saveState();
    options.onRender();
  }

  function setTrackVolume(trackId: string, value: unknown) {
    tracks = tracks.map((item) => item.track.id === trackId
      ? { ...item, volume: normalizeVolumeFromInput(value, item.volume) }
      : item);
    applyVolumes();
    saveState();
    options.onRender();
  }

  async function toggleTrack(trackId: string) {
    tracks = tracks.map((item) => item.track.id === trackId
      ? { ...item, enabled: !item.enabled }
      : item);
    saveState();
    if (!enabledTracks().length) {
      stop();
      return;
    }
    if (playing || options.autoPlayOnSelect()) {
      await play();
      return;
    }
    pauseDisabledTracks();
    options.onRender();
  }

  async function previewTrack(trackId: string) {
    const item = tracks.find((track) => track.track.id === trackId);
    if (!item || !options.isEnabled()) return;
    if (previewTrackId === trackId && previewPlayer && !previewPlayer.paused) {
      stopPreview();
      options.onRender();
      return;
    }
    stopPreview();
    const audio = new Audio(new URL(item.track.url, window.location.href).toString());
    previewPlayer = audio;
    previewTrackId = trackId;
    audio.preload = "auto";
    audio.loop = false;
    audio.volume = mixedVolume(item.volume);
    audio.addEventListener("ended", () => {
      if (previewPlayer === audio) {
        previewPlayer = undefined;
        previewTrackId = "";
        options.onRender();
      }
    });
    audio.addEventListener("error", () => {
      if (previewPlayer === audio) {
        previewPlayer = undefined;
        previewTrackId = "";
        options.onStatus(options.tr("status.whiteNoisePreviewFailed", { name: item.track.name }), "error");
        options.onRender();
      }
    });
    try {
      await audio.play();
      options.onRender();
    } catch (error) {
      if (previewPlayer === audio) {
        previewPlayer = undefined;
        previewTrackId = "";
      }
      options.onStatus(
        options.tr("status.whiteNoisePlayFailed", {
          message: error instanceof Error ? error.message : String(error),
        }),
        "error",
      );
      options.onRender();
    }
  }

  function applyVolumes() {
    for (const item of tracks) {
      const player = players.get(item.track.id);
      if (player) {
        player.volume = mixedVolume(item.volume);
      }
    }
    if (previewTrackId) {
      const item = tracks.find((track) => track.track.id === previewTrackId);
      if (item && previewPlayer) {
        previewPlayer.volume = mixedVolume(item.volume);
      }
    }
  }

  function pauseDisabledTracks() {
    for (const item of tracks) {
      if (!item.enabled) {
        players.get(item.track.id)?.pause();
      }
    }
  }

  function enabledTracks() {
    return tracks.filter((item) => item.enabled);
  }

  function reconcileTracks() {
    const previous = new Map(tracks.map((item) => [item.track.id, item]));
    tracks = catalog.files.map((track, index) => {
      const persisted = stored.tracks?.[track.id];
      const current = previous.get(track.id);
      return {
        track,
        enabled: current?.enabled ?? persisted?.enabled ?? index === 0,
        volume: normalizeVolume(current?.volume ?? persisted?.volume, DEFAULT_TRACK_VOLUME),
      };
    });
    for (const id of Array.from(players.keys())) {
      if (!tracks.some((item) => item.track.id === id)) {
        const player = players.get(id);
        player?.pause();
        players.delete(id);
      }
    }
    if (previewTrackId && !tracks.some((item) => item.track.id === previewTrackId)) {
      stopPreview();
    }
    if (!tracks.length) {
      playing = false;
    }
  }

  function audioForTrack(track: SoundFile): HTMLAudioElement {
    const existing = players.get(track.id);
    if (existing) return existing;
    const audio = new Audio(new URL(track.url, window.location.href).toString());
    audio.preload = "auto";
    audio.loop = true;
    audio.addEventListener("error", () => {
      options.onStatus(options.tr("status.whiteNoiseAudioError", {
        name: track.name,
      }), "error");
    });
    players.set(track.id, audio);
    return audio;
  }

  function mixedVolume(trackVolume: number): number {
    return clampVolume(masterVolume * trackVolume);
  }

  function stopPreview() {
    if (previewPlayer) {
      previewPlayer.pause();
      previewPlayer.currentTime = 0;
    }
    previewPlayer = undefined;
    previewTrackId = "";
  }

  function saveState() {
    const payload: StoredWhiteNoiseState = {
      floatingCollapsed,
      masterVolume,
      packageUrl,
      tracks: Object.fromEntries(tracks.map((item) => [
        item.track.id,
        {
          enabled: item.enabled,
          volume: item.volume,
        },
      ])),
    };
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    } catch {
      // Playback preferences are best-effort browser state.
    }
  }

  return {
    viewState,
    ensureLoaded,
    refresh,
    toggleHelp,
    setPackageUrl,
    setFloatingCollapsed,
    installPackage,
    togglePlayback,
    play,
    pause,
    stop,
    setMasterVolume,
    stepMasterVolume,
    setTrackVolume,
    toggleTrack,
    previewTrack,
  };
}

function loadStoredState(): StoredWhiteNoiseState {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) as StoredWhiteNoiseState : {};
  } catch {
    return {};
  }
}

function stringOrDefault(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function normalizeVolumeFromInput(value: unknown, fallback: number): number {
  const number = typeof value === "string" || typeof value === "number"
    ? Number(value)
    : Number.NaN;
  return normalizeVolume(Number.isFinite(number) ? number / 100 : number, fallback);
}

function normalizeVolume(value: unknown, fallback: number): number {
  const number = typeof value === "number" ? value : Number.NaN;
  return Number.isFinite(number) ? clampVolume(number) : fallback;
}

function clampVolume(value: number): number {
  return Math.min(1, Math.max(0, value));
}
