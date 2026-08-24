import { create } from "zustand";
import { DEFAULT_SETTINGS, getSettings, saveSettings, type Settings } from "../services/storage";

interface SettingsStore {
  settings: Settings;
  update: (patch: Partial<Settings>) => void;
  reload: () => void;
}

export const useSettingsStore = create<SettingsStore>((set) => ({
  settings: getSettings(),
  update: (patch) => set({ settings: saveSettings(patch) }),
  reload: () => set({ settings: getSettings() }),
}));

export function getDefaultSettings(): Settings {
  return { ...DEFAULT_SETTINGS };
}
