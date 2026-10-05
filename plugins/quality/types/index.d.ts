export type Progress = { reviewed: number; total: number }

declare module 'claude-code' {
  interface PluginState {
    'quality': { url: string | null; progress: Progress | null }
  }
}
