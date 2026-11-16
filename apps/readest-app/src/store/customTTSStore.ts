import { create } from 'zustand';
import type { EnvConfigType } from '@/services/environment';
import type { CustomTTSService } from '@/types/customTTS';
import { useSettingsStore } from './settingsStore';
import { getReplicaPersistEnv } from '@/services/sync/replicaPersist';
import { publishReplicaDelete, publishReplicaUpsert } from '@/services/sync/replicaPublish';
import { CUSTOM_TTS_KIND } from '@/services/sync/adapters/customTTS';
import { BUILTIN_CUSTOM_TTS_SERVICES } from '@/services/tts/builtinServices';

type ServiceInput = Omit<CustomTTSService, 'id' | 'addedAt' | 'updatedAt'>;

const replace = (list: CustomTTSService[], service: CustomTTSService) =>
  list.some((s) => s.id === service.id)
    ? list.map((s) => (s.id === service.id ? service : s))
    : [...list, service];

const markDeleted = (list: CustomTTSService[], id: string) =>
  list.map((s) => (s.id === id ? { ...s, deletedAt: Date.now() } : s));

/**
 * A v4 UUID that also works where WebView predates `crypto.randomUUID`
 * (Chrome 92). Android 9 images and some vendor WebViews still ship older
 * engines, and this runs synchronously on the Save path: without a fallback
 * the editor silently fails to save.
 */
const newServiceId = (): string => {
  const webCrypto = globalThis.crypto;
  if (typeof webCrypto?.randomUUID === 'function') {
    return webCrypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  if (typeof webCrypto?.getRandomValues === 'function') {
    webCrypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-');
};

const persist = () => {
  const env = getReplicaPersistEnv();
  if (env) void useCustomTTSStore.getState().saveCustomTTSServices(env);
};

interface CustomTTSState {
  services: CustomTTSService[];
  loaded: boolean;

  addService(input: ServiceInput): CustomTTSService;
  updateService(id: string, patch: Partial<ServiceInput>): void;
  removeService(id: string): void;

  /** Replica pull: apply without republishing. */
  applyRemoteService(service: CustomTTSService): void;
  softDeleteService(id: string): void;

  loadCustomTTSServices(envConfig: EnvConfigType): Promise<void>;
  saveCustomTTSServices(envConfig: EnvConfigType): Promise<void>;
}

export const useCustomTTSStore = create<CustomTTSState>((set, get) => ({
  services: [],
  loaded: false,

  addService: (input) => {
    const now = Date.now();
    const service: CustomTTSService = {
      ...input,
      id: newServiceId(),
      addedAt: now,
      updatedAt: now,
      reincarnation: Math.random().toString(36).slice(2),
    };
    set((state) => ({ services: [...state.services, service] }));
    void publishReplicaUpsert(CUSTOM_TTS_KIND, service, service.id, service.reincarnation);
    return service;
  },

  updateService: (id, patch) => {
    const old = get().services.find((s) => s.id === id && !s.deletedAt);
    if (!old) return;
    const service = { ...old, ...patch, updatedAt: Date.now() };
    set((state) => ({ services: replace(state.services, service) }));
    void publishReplicaUpsert(CUSTOM_TTS_KIND, service, id, service.reincarnation);
  },

  removeService: (id) => {
    set((state) => ({ services: markDeleted(state.services, id) }));
    void publishReplicaDelete(CUSTOM_TTS_KIND, id);
  },

  applyRemoteService: (remote) => {
    const old = get().services.find((s) => s.id === remote.id);
    // A row pushed while the publisher's CryptoSession was locked carries no
    // apiKey; keep the local one instead of wiping it.
    const service: CustomTTSService = {
      ...remote,
      apiKey: remote.apiKey ?? old?.apiKey,
      lastSeenCipher: remote.lastSeenCipher ?? old?.lastSeenCipher,
      deletedAt: undefined,
    };
    set((state) => ({ services: replace(state.services, service) }));
    persist();
  },

  softDeleteService: (id) => {
    if (!get().services.some((s) => s.id === id && !s.deletedAt)) return;
    set((state) => ({ services: markDeleted(state.services, id) }));
    persist();
  },

  loadCustomTTSServices: async () => {
    const { settings } = useSettingsStore.getState();
    set({ services: settings?.customTTSServices ?? [], loaded: true });
  },

  saveCustomTTSServices: async (envConfig) => {
    const { settings, setSettings, saveSettings } = useSettingsStore.getState();
    // Tombstones stay in memory for the pull orchestrator but are not persisted.
    settings.customTTSServices = get().services.filter((s) => !s.deletedAt);
    setSettings(settings);
    await saveSettings(envConfig, settings);
  },
}));

/** Hydrates the store from settings once; later changes flow through the store. */
export const ensureCustomTTSServicesLoaded = (envConfig: EnvConfigType): void => {
  if (!useCustomTTSStore.getState().loaded) {
    void useCustomTTSStore.getState().loadCustomTTSServices(envConfig);
  }
};

/** Pull-side lookup that also checks persisted settings before the store hydrates. */
export const findCustomTTSService = (id: string): CustomTTSService | undefined =>
  useCustomTTSStore.getState().services.find((s) => s.id === id) ??
  useSettingsStore.getState().settings?.customTTSServices?.find((s) => s.id === id);

/** Services whose voices Read Aloud offers. */
export const getEnabledCustomTTSServices = (): CustomTTSService[] => {
  const { loaded, services } = useCustomTTSStore.getState();
  const list = loaded ? services : (useSettingsStore.getState().settings?.customTTSServices ?? []);
  const user = list.filter((s) => !s.deletedAt && !s.disabled);
  const endpoint = (url: string) => url.replace(/\/+$/, '');
  const builtin = BUILTIN_CUSTOM_TTS_SERVICES.filter(
    (b) =>
      !user.some(
        (s) =>
          s.id === b.id ||
          (endpoint(s.baseUrl) === endpoint(b.baseUrl) && s.voices === b.voices),
      ),
  );
  return [...builtin, ...user];
};
