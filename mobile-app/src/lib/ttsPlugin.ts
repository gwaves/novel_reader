import { registerPlugin, type PluginListenerHandle } from '@capacitor/core'

export type TtsVoice = {
  id: string
  name: string
  locale: string
  quality?: number
  latency?: number
  requiresNetwork?: boolean
}

export type TtsAvailability = {
  available: boolean
  languageAvailable: boolean
  engine: string | null
  voices: TtsVoice[]
  error?: string
}

export type SpeakRequest = {
  text: string
  utteranceId: string
  locale: string
  voiceId?: string | null
  rate: number
  pitch: number
}

export type TtsUtteranceEvent = {
  utteranceId: string
  error?: string
}

export interface NovelReaderTtsPlugin {
  getAvailability(options: { locale: string }): Promise<TtsAvailability>
  speak(request: SpeakRequest): Promise<void>
  stop(): Promise<void>
  setRate(options: { rate: number }): Promise<void>
  setPitch(options: { pitch: number }): Promise<void>
  addListener(
    eventName: 'utteranceStart' | 'utteranceDone' | 'utteranceError',
    listener: (event: TtsUtteranceEvent) => void,
  ): Promise<PluginListenerHandle>
}

export const NovelReaderTts = registerPlugin<NovelReaderTtsPlugin>('NovelReaderTts')

