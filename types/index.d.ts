export type Lang = 'fr' | 'en'

export type RepoConf = {
  path: string
  name: string
  isIncluded: boolean
  keepsLocal: boolean
  detectedBranch: string
  detectSource: 'server' | 'local' | 'unknown'
  manualBranch: string
}

export type Config = {
  root: string
  lang: Lang
  repos: RepoConf[]
  scannedAt: string
}

export type Row = {
  name: string
  path: string
  text: string
  isOk: boolean
  note: string
  isDiverged: boolean
}

export type Cleanup = {
  name: string
  path: string
  base: string
  branches: string[]
}

export type Run = {
  action: string
  status: 'idle' | 'running' | 'done' | 'error'
  finishedAt: string
  message: string
  rows: Row[]
  cleanup: Cleanup[]
}

export type View = {
  screen: 'actions' | 'settings'
  isHelpShown: boolean
  editing: string
  isAlignAsked: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'git-mod2': { config: Shaped<Config>; run: Shaped<Run>; view: Shaped<View> }
  }
}
