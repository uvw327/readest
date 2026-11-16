import type { CustomTTSService } from '@/types/customTTS';

/**
 * A speech service compiled into this fork: the local Mac Qwen3-TTS server.
 * It is merged into every voice list, so it needs no settings entry, no API
 * key and no sign-in. Keep it in sync with ~/workspace/qwen3-tts-openai on the
 * host (config.toml + voices/girl2).
 */
export const BUILTIN_CUSTOM_TTS_SERVICES: readonly CustomTTSService[] = [
  {
    id: 'builtin-local-tts',
    name: '自定义 TTS',
    baseUrl: 'http://192.168.6.3:8100/v1',
    model: 'qwen3-tts-base',
    voices: 'girl2',
    voiceLabels: { girl2: '女生2' },
    voiceLangs: { girl2: 'zh-CN' },
    responseFormat: 'mp3',
    addedAt: 0,
    updatedAt: 0,
  },
];
