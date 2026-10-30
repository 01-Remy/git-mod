import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Cleanup, Config, RepoConf, Row, Run, View } from '../types'
import { texts } from './i18n'

const PANE = 'git-mod2'
const STORE_KEY = 'config'
// Pas de « - » en tête (git le lirait comme une option) ni de « .. ».
const BRANCH_NAME = /^(?!-)(?!.*\.\.)[\w./-]+$/
// Branches jamais proposées à la suppression, en plus de la branche par défaut du dépôt.
const PROTECTED = ['develop', 'main', 'master']
// Le serveur git refuse au-delà de quelques connexions simultanées.
const CONCURRENCY = 4

const DEFAULT_CONFIG: Config = { root: '/var/www', lang: 'fr', repos: [], scannedAt: '' }
const IDLE: Run = { action: '', status: 'idle', finishedAt: '', message: '', rows: [], cleanup: [] }
const DEFAULT_VIEW: View = { screen: 'actions', isHelpShown: false, editing: '', isAlignAsked: false }

// Change le tag quand une forme change : l'ancien état stocké est alors ignoré.
const config = atom({ plugin: 'git-mod2', key: 'config' } as const, DEFAULT_CONFIG, { shape: 'config-1' })
const run = atom({ plugin: 'git-mod2', key: 'run' } as const, IDLE, { shape: 'run-1' })
const view = atom({ plugin: 'git-mod2', key: 'view' } as const, DEFAULT_VIEW, { shape: 'view-1' })

const now = () => new Date().toLocaleString('fr-FR')
const stamp = () => new Date().toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-')
const firstLine = (text: string) => text.trim().split('\n')[0] ?? ''
const lines = (text: string) => text.split('\n').map(l => l.trim()).filter(Boolean)
const baseOf = (repo: RepoConf) => repo.manualBranch || repo.detectedBranch

// Au-delà de cette longueur, un chemin de dépôt s'affiche « .../<dossier final> » pour tenir sur une ligne.
const NAME_MAX = 24
// Largeur en dessous de laquelle le nom ne rétrécit plus quand le panneau est étroit.
const NAME_MIN = 12
const displayName = (name: string) =>
  name.length <= NAME_MAX || !name.includes('/') ? name : `.../${name.split('/').at(-1) ?? name}`

const git = ($: EngineInterface, path: string, ...args: string[]) =>
  $.process.run(['git', '-C', path, ...args], { timeoutMs: 120_000 })

// Comme Promise.all, mais au plus `limit` à la fois.
const mapLimit = async <T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>) => {
  const out: R[] = new Array(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i] as T)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

const saveConfig = async ($: EngineInterface, change: (c: Config) => Config) => {
  const saved = await update($, config, change)
  await $.store.set(STORE_KEY, saved)
  return saved
}

const t$ = async ($: EngineInterface) => texts((await read($, config)).lang)

const includedRepos = async ($: EngineInterface) => (await read($, config)).repos.filter(r => r.isIncluded)

// ---- état d'un dépôt ----

const currentBranch = async ($: EngineInterface, path: string) =>
  (await git($, path, 'branch', '--show-current')).stdout.trim()

const dirtyCount = async ($: EngineInterface, path: string) =>
  lines((await git($, path, 'status', '--porcelain', '-uno')).stdout).length

// Retard et avance par rapport à la branche suivie, ou null s'il n'y en a pas.
const aheadBehind = async ($: EngineInterface, path: string) => {
  const res = await git($, path, 'rev-list', '--left-right', '--count', '@{u}...HEAD')
  if (res.exitCode !== 0) return null
  const [behind, ahead] = res.stdout.trim().split(/\s+/).map(Number)
  return { behind: behind ?? 0, ahead: ahead ?? 0 }
}

const statusRow = async ($: EngineInterface, repo: RepoConf, extra = '', expected = baseOf(repo)): Promise<Row> => {
  const t = await t$($)
  const [branch, dirty, sync] = await Promise.all([
    currentBranch($, repo.path),
    dirtyCount($, repo.path),
    aheadBehind($, repo.path),
  ])
  const syncNote = !sync
    ? t.noUpstream
    : [sync.behind && t.behind(sync.behind), sync.ahead && t.ahead(sync.ahead)].filter(Boolean).join(', ')
  const dirtyNote = dirty ? (repo.keepsLocal ? t.localKept(dirty) : t.dirty(dirty)) : ''
  return {
    name: repo.name,
    path: repo.path,
    text: branch,
    isOk:
      !extra && !!expected && branch === expected && !!sync && !sync.behind && !sync.ahead && (!dirty || repo.keepsLocal),
    note: [extra, syncNote, dirtyNote].filter(Boolean).join(' · '),
    isDiverged: !!sync && sync.behind > 0 && sync.ahead > 0,
  }
}

// ---- modifs locales ----

const stashCount = async ($: EngineInterface, path: string) =>
  lines((await git($, path, 'stash', 'list')).stdout).length

// Met les modifs locales de côté si le dépôt est réglé pour les garder ; renvoie true si c'est fait.
const stashLocal = async ($: EngineInterface, repo: RepoConf) => {
  if (!repo.keepsLocal || !(await dirtyCount($, repo.path))) return false
  const before = await stashCount($, repo.path)
  await git($, repo.path, 'stash', 'push', '-q', '-m', 'git-mod2 modifs locales')
  return (await stashCount($, repo.path)) > before
}

// Réapplique les modifs locales ; renvoie '' ou la note du conflit.
const restoreLocal = async ($: EngineInterface, repo: RepoConf, isStashed: boolean) => {
  if (!isStashed) return ''
  const t = await t$($)
  const files = lines((await git($, repo.path, 'stash', 'show', '--name-only', 'stash@{0}')).stdout)
  const pop = await git($, repo.path, 'stash', 'pop')
  const conflicts = lines((await git($, repo.path, 'diff', '--name-only', '--diff-filter=U')).stdout)
  // En cas de conflit, git ajoute à l'index les fichiers réappliqués sans souci : on les en retire,
  // des modifs locales ne doivent jamais se retrouver prêtes à être commitées.
  const toUnstage = files.filter(f => !conflicts.includes(f))
  // Un pop qui échoue sans conflit n'a rien réappliqué : ne rien désindexer dans ce cas.
  const isApplied = pop.exitCode === 0 || conflicts.length > 0
  if (isApplied && toUnstage.length) {
    await $.process.run(['git', '-C', repo.path, 'restore', '--staged', '--', ...toUnstage], { timeoutMs: 120_000 })
  }
  if (pop.exitCode === 0) return ''
  return conflicts.length ? t.localConflict(conflicts.join(' ')) : t.localNotReapplied(firstLine(pop.stderr))
}

// Pull en avance rapide ; renvoie '' ou une note lisible, divergence comprise.
const pullFastForward = async ($: EngineInterface, path: string) => {
  const pull = await git($, path, 'pull', '-q', '--ff-only')
  if (pull.exitCode === 0) return ''
  const sync = await aheadBehind($, path)
  if (sync && sync.ahead && sync.behind) return (await t$($)).diverged(sync.ahead, sync.behind)
  return firstLine(pull.stderr)
}

// Change de branche en gardant ou en protégeant les modifs locales ; renvoie '' ou une note.
const checkoutKeepingLocal = async ($: EngineInterface, repo: RepoConf, branch: string, hasRemote: boolean) => {
  const t = await t$($)
  const isStashed = await stashLocal($, repo)
  if (!isStashed && (await dirtyCount($, repo.path))) return t.dirtySkipped
  let problem = ''
  const co = await git($, repo.path, 'checkout', branch)
  if (co.exitCode !== 0) problem = firstLine(co.stderr)
  else if (hasRemote) {
    await git($, repo.path, 'branch', '-q', `--set-upstream-to=origin/${branch}`, branch)
    problem = await pullFastForward($, repo.path)
  }
  // Les modifs locales reviennent quoi qu'il arrive, même si le changement de branche a échoué.
  const restored = await restoreLocal($, repo, isStashed)
  return [problem, restored].filter(Boolean).join(' · ')
}

// ---- exécution d'une action ----

type Outcome = Pick<Run, 'rows' | 'message'> & Partial<Pick<Run, 'cleanup'>>

// Lance une action en empêchant deux actions en même temps. Les boutons et champs l'appellent avec
// `void` : un handler de saisie ou de clic n'a que quelques secondes, une action peut durer plus.
const perform = async ($: EngineInterface, action: string, work: () => Promise<Outcome>) => {
  // Lecture et pose du verrou en une seule écriture : deux appuis rapprochés ne lancent pas deux actions.
  let isBusy = false
  await update($, run, (s): Run => {
    isBusy = s.status === 'running'
    return isBusy ? s : { ...IDLE, action, status: 'running' }
  })
  if (isBusy) return
  let toast = ''
  try {
    const t = await t$($)
    await update($, view, v => ({ ...v, isAlignAsked: false }))
    try {
      const out = await work()
      const failed = out.rows.filter(r => !r.isOk).length
      await update($, run, () => ({ ...IDLE, ...out, action, status: failed ? 'error' : 'done', finishedAt: now() }))
      toast = `${t.title} : ${action} — ${out.message}`
    } catch (err) {
      await update($, run, () => ({ ...IDLE, action, status: 'error', finishedAt: now(), message: t.failure(String(err)) }))
    }
  } finally {
    // Quoi qu'il arrive, le verrou ne reste pas posé : sinon plus aucune action ne se lancerait.
    await update($, run, (s): Run => (s.status === 'running' ? { ...s, status: 'error', finishedAt: now() } : s)).catch(
      () => undefined,
    )
  }
  if (toast) $.ui.toast(toast)
}

const fetchAll = ($: EngineInterface, repos: RepoConf[]) =>
  mapLimit(repos, CONCURRENCY, r => git($, r.path, 'fetch', '-q', 'origin'))

// ---- actions ----

const showStatus = async ($: EngineInterface) => {
  const t = await t$($)
  return perform($, t.statusLabel, async () => {
    const repos = await includedRepos($)
    await fetchAll($, repos)
    const rows = await mapLimit(repos, CONCURRENCY, r => statusRow($, r, baseOf(r) ? '' : t.unknownDefault))
    const off = rows.filter(r => !r.isOk).length
    return { rows, message: off ? t.offCount(off) : t.allClean }
  })
}

const toDefaults = async ($: EngineInterface) => {
  const t = await t$($)
  return perform($, t.defaultsLabel, async () => {
    const repos = await includedRepos($)
    await fetchAll($, repos)
    const rows = await mapLimit(repos, CONCURRENCY, async repo => {
      const base = baseOf(repo)
      if (!base) return statusRow($, repo, t.unknownDefault)
      return statusRow($, repo, await checkoutKeepingLocal($, repo, base, true))
    })
    const failed = rows.filter(r => !r.isOk).length
    return { rows, message: failed ? t.toCheck(failed) : t.allOnDefault }
  })
}

const pullCurrent = async ($: EngineInterface) => {
  const t = await t$($)
  return perform($, t.pullLabel, async () => {
    const repos = await includedRepos($)
    const rows = await mapLimit(repos, CONCURRENCY, async repo => {
      if (!(await aheadBehind($, repo.path))) return statusRow($, repo, t.noUpstream)
      const isStashed = await stashLocal($, repo)
      const problem = await pullFastForward($, repo.path)
      const restored = await restoreLocal($, repo, isStashed)
      const extra = [problem, restored].filter(Boolean).join(' · ')
      // Être sur une branche de ticket est normal ici : seul compte d'être à jour.
      return statusRow($, repo, extra, await currentBranch($, repo.path))
    })
    const failed = rows.filter(r => !r.isOk).length
    return { rows, message: failed ? t.toCheck(failed) : t.allUpToDate }
  })
}

const switchBranch = async ($: EngineInterface, branch: string) => {
  const t = await t$($)
  return perform($, t.switchAction(branch), async () => {
    if (!BRANCH_NAME.test(branch)) return { rows: [], message: t.invalidBranch }
    const repos = await includedRepos($)
    await fetchAll($, repos)
    const rows = (
      await mapLimit(repos, CONCURRENCY, async (repo): Promise<Row | null> => {
        const hasLocal = (await git($, repo.path, 'rev-parse', '-q', '--verify', `refs/heads/${branch}`)).exitCode === 0
        const hasRemote =
          (await git($, repo.path, 'rev-parse', '-q', '--verify', `refs/remotes/origin/${branch}`)).exitCode === 0
        if (!hasLocal && !hasRemote) return null
        return statusRow($, repo, await checkoutKeepingLocal($, repo, branch, hasRemote), branch)
      })
    ).filter((r): r is Row => r !== null)
    if (!rows.length) return { rows, message: t.noRepoHas(branch) }
    const failed = rows.filter(r => !r.isOk).length
    return { rows, message: failed ? t.toCheck(failed) : t.onBranch(rows.length, branch) }
  })
}

const findMerged = async ($: EngineInterface) => {
  const t = await t$($)
  return perform($, t.mergedAction, async () => {
    const repos = (await includedRepos($)).filter(r => baseOf(r))
    await fetchAll($, repos)
    const found = await mapLimit(repos, CONCURRENCY, async (repo): Promise<Cleanup | null> => {
      const base = baseOf(repo)
      const current = await currentBranch($, repo.path)
      const merged = await git($, repo.path, 'branch', '--format=%(refname:short)', '--merged', `origin/${base}`)
      const branches = lines(merged.stdout).filter(b => b !== current && b !== base && !PROTECTED.includes(b))
      return branches.length ? { name: repo.name, path: repo.path, base, branches } : null
    })
    const cleanup = found.filter((c): c is Cleanup => c !== null)
    const count = cleanup.reduce((n, c) => n + c.branches.length, 0)
    return { rows: [], cleanup, message: count ? t.mergedFound(count) : t.mergedNone }
  })
}

const deleteMerged = async ($: EngineInterface) => {
  const t = await t$($)
  // À lire avant perform : il remet l'état à zéro, liste comprise.
  const { cleanup } = await read($, run)
  return perform($, t.deleteAction, async () => {
    let keptTotal = 0
    const rows = await mapLimit(cleanup, CONCURRENCY, async (repo): Promise<Row> => {
      const current = await currentBranch($, repo.path)
      // On revérifie juste avant : seules les branches toujours fusionnées partent.
      const merged = new Set(
        lines((await git($, repo.path, 'branch', '--format=%(refname:short)', '--merged', `origin/${repo.base}`)).stdout),
      )
      const targets = repo.branches.filter(b => merged.has(b) && b !== current && b !== repo.base)
      // -D car -d compare à la branche suivie ou à HEAD, pas à la branche par défaut.
      for (let i = 0; i < targets.length; i += 100) {
        const chunk = targets.slice(i, i + 100)
        await $.process.run(['git', '-C', repo.path, 'branch', '-D', ...chunk], { timeoutMs: 120_000 })
      }
      const left = new Set(lines((await git($, repo.path, 'branch', '--format=%(refname:short)')).stdout))
      const kept = repo.branches.filter(b => left.has(b))
      keptTotal += kept.length
      const names = kept.slice(0, 5).join(', ') + (kept.length > 5 ? ', …' : '')
      return {
        name: repo.name,
        path: repo.path,
        text: t.deleted(repo.branches.length - kept.length),
        isOk: kept.length === 0,
        note: kept.length ? t.kept(kept.length, names) : '',
        isDiverged: false,
      }
    })
    const total = cleanup.reduce((n, c) => n + c.branches.length, 0)
    return { rows, message: t.deletedTotal(total - keptTotal, rows.filter(r => !r.isOk).length) }
  })
}

const alignDiverged = async ($: EngineInterface) => {
  const t = await t$($)
  // À lire avant perform, comme pour la suppression.
  const paths = (await read($, run)).rows.filter(r => r.isDiverged).map(r => r.path)
  const repos = (await read($, config)).repos.filter(r => paths.includes(r.path))
  return perform($, t.alignAction, async () => {
    const rows = await mapLimit(repos, CONCURRENCY, async repo => {
      const fetch = await git($, repo.path, 'fetch', '-q', 'origin')
      const branch = await currentBranch($, repo.path)
      if (fetch.exitCode !== 0) return statusRow($, repo, t.fetchFailed(firstLine(fetch.stderr)), branch)
      if (!branch) return statusRow($, repo, t.detachedHead, branch)
      // Le résultat affiché peut dater : on ne touche qu'à une branche encore divergente maintenant.
      const sync = await aheadBehind($, repo.path)
      if (!sync || !sync.ahead || !sync.behind) return statusRow($, repo, t.notDiverged, branch)
      // reset --hard écraserait sans prévenir un fichier non suivi (ou ignoré) que le serveur versionne au même endroit.
      const incoming = new Set(lines((await git($, repo.path, 'diff', '--name-only', 'HEAD', '@{u}')).stdout))
      const untracked = lines((await git($, repo.path, 'ls-files', '--others')).stdout)
      const blocking = untracked.filter(f => incoming.has(f))
      if (blocking.length) return statusRow($, repo, t.untrackedBlocking(blocking.slice(0, 5).join(', ')), branch)
      const isStashed = await stashLocal($, repo)
      if (!isStashed && (await dirtyCount($, repo.path))) return statusRow($, repo, t.dirtySkipped, branch)
      const backup = `backup/${branch}-local-${stamp()}`
      const saved = await git($, repo.path, 'branch', backup, branch)
      // Sans sauvegarde, pas d'alignement : les commits locaux ne seraient plus référencés.
      if (saved.exitCode !== 0) {
        const restored = await restoreLocal($, repo, isStashed)
        const extra = [t.backupFailed(firstLine(saved.stderr)), restored].filter(Boolean).join(' · ')
        return statusRow($, repo, extra, branch)
      }
      const reset = await git($, repo.path, 'reset', '-q', '--hard', '@{u}')
      const restored = await restoreLocal($, repo, isStashed)
      const extra = [reset.exitCode ? firstLine(reset.stderr) : '', restored].filter(Boolean).join(' · ')
      const row = await statusRow($, repo, extra, branch)
      return extra ? row : { ...row, note: [t.aligned(backup), row.note].filter(Boolean).join(' · ') }
    })
    const done = rows.filter(r => r.isOk).length
    return { rows, message: done === rows.length ? t.alignedTotal(done) : t.toCheck(rows.length - done) }
  })
}

// ---- scan et réglages ----

// Dépôts git sous `root`, à tous les niveaux, sans descendre dans un dépôt déjà trouvé.
const findRepos = async ($: EngineInterface, root: string) => {
  const res = await $.process.run(
    ['find', root, '(', '-name', 'node_modules', '-o', '-name', 'vendor', ')', '-prune', '-o', '-name', '.git', '-print', '-prune'],
    { timeoutMs: 120_000 },
  )
  const found = lines(res.stdout)
    .map(p => p.replace(/\/\.git$/, ''))
    .sort()
  return found.filter(p => !found.some(other => other !== p && p.startsWith(`${other}/`)))
}

// Branche par défaut annoncée par le serveur, sinon celle connue en local.
const detectDefault = async ($: EngineInterface, path: string) => {
  const remote = await $.process
    .run(['git', '-C', path, 'ls-remote', '--symref', 'origin', 'HEAD'], { timeoutMs: 20_000 })
    .catch(() => null)
  const fromServer = remote?.stdout.match(/^ref: refs\/heads\/(\S+)\s+HEAD/m)?.[1]
  if (fromServer) return { branch: fromServer, source: 'server' as const }
  const local = await git($, path, 'symbolic-ref', '-q', '--short', 'refs/remotes/origin/HEAD')
  const fromLocal = local.stdout.trim().replace(/^origin\//, '')
  if (local.exitCode === 0 && fromLocal) return { branch: fromLocal, source: 'local' as const }
  return { branch: '', source: 'unknown' as const }
}

const scan = async ($: EngineInterface, rootInput?: string) => {
  const t = await t$($)
  return perform($, t.scanAction, async () => {
    const root = (rootInput ?? (await read($, config)).root).trim().replace(/\/+$/, '')
    if (!root.startsWith('/')) return { rows: [], message: t.rootInvalid }
    if (!(await $.fs.exists(root))) return { rows: [], message: t.rootMissing(root) }
    const paths = await findRepos($, root)
    const known = new Map((await read($, config)).repos.map(r => [r.path, r]))
    // Une requête à la fois : en parallèle, le serveur git en refuse une partie.
    const repos = await mapLimit(paths, 1, async (path): Promise<RepoConf> => {
      const detected = await detectDefault($, path)
      const previous = known.get(path)
      return {
        path,
        name: path.slice(root.length + 1) || path,
        isIncluded: previous?.isIncluded ?? true,
        keepsLocal: previous?.keepsLocal ?? false,
        manualBranch: previous?.manualBranch ?? '',
        detectedBranch: detected.branch,
        detectSource: detected.source,
      }
    })
    await saveConfig($, c => ({ ...c, root, repos, scannedAt: now() }))
    const added = repos.filter(r => !known.has(r.path)).length
    return { rows: [], message: t.scanned(repos.length, added) }
  })
}

// Enregistre le dossier sans scanner : le scan se lance avec le bouton « Scanner ».
const setRoot = ($: EngineInterface, value: string) =>
  saveConfig($, c => ({ ...c, root: value.trim().replace(/\/+$/, '') }))

const editRepo = ($: EngineInterface, path: string, change: (r: RepoConf) => RepoConf) =>
  saveConfig($, c => ({ ...c, repos: c.repos.map(r => (r.path === path ? change(r) : r)) }))

const setManualBranch = async ($: EngineInterface, path: string, value: string) => {
  const branch = value.trim()
  if (branch && !BRANCH_NAME.test(branch)) return
  await editRepo($, path, r => ({ ...r, manualBranch: branch === r.detectedBranch ? '' : branch }))
  await update($, view, v => ({ ...v, editing: '' }))
}

const runAction = ($: EngineInterface, key: string) => {
  if (key === 'status') return showStatus($)
  if (key === 'defaults') return toDefaults($)
  if (key === 'pull') return pullCurrent($)
  return findMerged($)
}

const ACTIONS = [
  { key: 'status', hotkey: 's', label: 'statusLabel', help: 'statusHelp', isPrimary: false },
  { key: 'defaults', hotkey: 'd', label: 'defaultsLabel', help: 'defaultsHelp', isPrimary: true },
  { key: 'pull', hotkey: 'p', label: 'pullLabel', help: 'pullHelp', isPrimary: false },
  { key: 'merged', hotkey: 'n', label: 'mergedLabel', help: 'mergedHelp', isPrimary: false },
] as const

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    // Les réglages vivent dans $.store (d'une session à l'autre) et sont recopiés dans l'état pour l'affichage.
    const saved = (await $.store.get(STORE_KEY)) as Partial<Config> | undefined
    if (saved && Array.isArray(saved.repos)) await update($, config, () => ({ ...DEFAULT_CONFIG, ...saved }))
    await $.command.register({ name: 'git-mod2', description: texts(saved?.lang ?? 'fr').commandDescription })

    return next(e)
  })

  on('command.run', { command: 'git-mod2' }, async $ => {
    const t = await t$($)
    await $.ui.open({ id: PANE, title: t.title })
    if ((await read($, config)).repos.length) void showStatus($)
    else await update($, view, (v): View => ({ ...v, screen: 'settings' }))

    return { text: t.opened }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    // Le champ texte n'existe pas sur toutes les surfaces (mobile, VS Code).
    const Input = 'Input' in ui ? ui.Input : undefined
    const conf = await read($, config)
    const state = await read($, run)
    const v = await read($, view)
    const t = texts(conf.lang)
    const isRunning = state.status === 'running'
    const isSettings = v.screen === 'settings'
    const total = state.cleanup.reduce((n, c) => n + c.branches.length, 0)
    const diverged = state.rows.filter(r => r.isDiverged).length
    const width = Math.max(12, ...conf.repos.map(r => displayName(r.name).length)) + 1

    const header = (
      <Box flexDirection="row" gap={2}>
        <Text>{t.intro}</Text>
        <Box flexDirection="column" gap={1}>
          <Button key="screen" hotkey="g" onPress={() => update($, view, (w): View => ({ ...w, screen: isSettings ? 'actions' : 'settings', editing: '' }))}>
            {isSettings ? t.back : t.settings}
          </Button>
          <Button key="help" hotkey="h" onPress={() => update($, view, w => ({ ...w, isHelpShown: !w.isHelpShown }))}>
            {v.isHelpShown ? t.hideHelp : t.help}
          </Button>
        </Box>
      </Box>
    )

    const results = (
      <Box flexDirection="column" marginTop={1}>
        {state.action !== '' && (
          <Text bold>
            {state.action} {isRunning ? `— ${t.running}` : state.finishedAt && `(${state.finishedAt})`}
          </Text>
        )}
        {state.message !== '' && <Text color={state.status === 'error' ? 'red' : 'green'}>{state.message}</Text>}
        {state.rows.map(r => (
          <Text key={`row-${r.path}-${r.text}`} dimColor={r.isOk}>
            {r.isOk ? '✓' : '✗'} {displayName(r.name).padEnd(width)} {r.text} {r.note && `— ${r.note}`}
          </Text>
        ))}
        {state.cleanup.map(c => (
          <Text key={`clean-${c.path}`}>
            {displayName(c.name).padEnd(width)} ({c.branches.length}) {c.branches.slice(0, 5).join(', ')}
            {c.branches.length > 5 ? ', …' : ''}
          </Text>
        ))}
        {total > 0 && !isRunning && (
          <Box flexDirection="row" gap={1} marginTop={1}>
            <Button key="delete" variant="primary" onPress={() => void deleteMerged($)}>{t.deleteButton(total)}</Button>
            <Button key="cancel-delete" onPress={() => update($, run, s => ({ ...s, cleanup: [], message: t.cancelled }))}>
              {t.cancel}
            </Button>
          </Box>
        )}
        {diverged > 0 && !isRunning && !v.isAlignAsked && (
          <Box marginTop={1}>
            <Button key="align-ask" onPress={() => update($, view, w => ({ ...w, isAlignAsked: true }))}>
              {t.alignOffer(diverged)}
            </Button>
          </Box>
        )}
        {diverged > 0 && !isRunning && v.isAlignAsked && (
          <Box flexDirection="column" marginTop={1}>
            <Text color="yellow">{t.alignWarning}</Text>
            <Box flexDirection="row" gap={1}>
              <Button key="align" variant="primary" onPress={() => void alignDiverged($)}>{t.alignConfirm}</Button>
              <Button key="cancel-align" onPress={() => update($, view, w => ({ ...w, isAlignAsked: false }))}>{t.cancel}</Button>
            </Box>
          </Box>
        )}
      </Box>
    )

    if (isSettings) {
      return (
        <Box flexDirection="column">
          {header}
          <Text bold>{t.settingsTitle}</Text>
          <Box marginBottom={1}>
            <Button key="lang" plain onPress={() => saveConfig($, c => ({ ...c, lang: c.lang === 'fr' ? 'en' : 'fr' }))}>
              {t.language}
            </Button>
          </Box>
          {Input && (
            <Input
              key="root"
              label={t.rootLabel}
              placeholder={t.rootPlaceholder}
              value={conf.root}
              submitLabel={t.rootSubmit}
              onSubmit={(value: string) => setRoot($, value)}
            />
          )}
          {v.isHelpShown && <Text dimColor>{t.rootHelp}</Text>}
          <Box flexDirection="row" gap={2} marginTop={1}>
            <Button key="scan" variant="primary" hotkey="c" onPress={() => void scan($)}>{t.scan}</Button>
            <Text dimColor>{conf.scannedAt ? t.lastScan(conf.scannedAt) : t.neverScanned}</Text>
          </Box>
          {v.isHelpShown && <Text dimColor>{t.scanHelp}</Text>}
          {v.isHelpShown && conf.repos.length > 0 && <Text dimColor>{t.reposHelp}</Text>}
          <Box flexDirection="column" marginTop={1}>
            {conf.repos.map(r => {
              const source = r.manualBranch
                ? t.srcManual
                : r.detectSource === 'server'
                  ? t.srcServer
                  : r.detectSource === 'local'
                    ? t.srcLocal
                    : t.srcUnknown
              return (
                <Box key={`repo-${r.path}`} flexDirection="column">
                  <Box flexDirection="row" gap={1}>
                    <Button key={`inc-${r.path}`} plain onPress={() => editRepo($, r.path, x => ({ ...x, isIncluded: !x.isIncluded }))}>
                      {r.isIncluded ? t.included : t.excluded}
                    </Button>
                    <Box minWidth={NAME_MIN} flexShrink={1}>
                      <Text dimColor={!r.isIncluded} wrap="truncate">
                        {displayName(r.name).padEnd(width)}
                      </Text>
                    </Box>
                    <Button key={`br-${r.path}`} plain dimColor onPress={() => update($, view, w => ({ ...w, editing: r.path }))}>
                      {t.branchOf(baseOf(r) || '?', source)}
                    </Button>
                    <Button key={`keep-${r.path}`} plain dimColor onPress={() => editRepo($, r.path, x => ({ ...x, keepsLocal: !x.keepsLocal }))}>
                      {r.keepsLocal ? t.keepOn : t.keepOff}
                    </Button>
                  </Box>
                  {Input && v.editing === r.path && (
                    <Box flexDirection="column" marginLeft={4}>
                      <Input
                        key={`edit-${r.path}`}
                        label={t.branchEdit(displayName(r.name))}
                        placeholder={r.detectedBranch}
                        value={r.manualBranch}
                        submitLabel={t.branchSubmit}
                        autoFocus
                        onSubmit={(value: string) => setManualBranch($, r.path, value)}
                      />
                      <Text dimColor>{t.branchEditHelp}</Text>
                    </Box>
                  )}
                </Box>
              )
            })}
          </Box>
          {results}
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        {header}
        {conf.repos.length === 0 && <Text color="yellow">{t.noRepos}</Text>}
        <Text> </Text>
        {ACTIONS.map(a => (
          <Box key={`act-${a.key}`} flexDirection="column" marginBottom={1}>
            <Button key={a.key} variant={a.isPrimary ? 'primary' : undefined} hotkey={a.hotkey} onPress={() => void runAction($, a.key)}>
              {t[a.label]}
            </Button>
            {v.isHelpShown && <Text dimColor>{t[a.help]}</Text>}
          </Box>
        ))}
        {Input && (
          <Box flexDirection="column">
            <Input
              key="branch"
              label={t.switchLabel}
              placeholder={t.switchPlaceholder}
              submitLabel={t.switchSubmit}
              onSubmit={(value: string) => void switchBranch($, value.trim())}
            />
            {v.isHelpShown && <Text dimColor>{t.switchHelp}</Text>}
          </Box>
        )}
        {v.isHelpShown && <Text dimColor>{t.localHelp}</Text>}
        {results}
      </Box>
    )
  })
}
