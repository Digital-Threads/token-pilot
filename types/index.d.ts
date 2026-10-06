/** The savings line the band above the prompt draws; null until the first refresh. */
export type BandLine = string | null

declare module 'claude-code' {
  interface PluginState {
    'token-pilot': { band: BandLine }
  }
}
