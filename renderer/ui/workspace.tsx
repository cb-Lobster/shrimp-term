import { useMemo, useState } from 'react'
import { ChevronRight, Folder, LayoutGrid, List, Plus, Search, Server, Star } from 'lucide-react'
import { FilesView, type FilesProps } from './files'
import { createRoot, type Root } from 'react-dom/client'
import { split, removePane } from './split'
import type { Host } from './ipc'

type HostsProps = {
  hosts: Host[]
  recent: string[]
  favorites: string[]
  onOpen: (host: Host) => void
  onFavorite: (id: string) => void
  onNew: () => void
  onQuick: (target?: string) => void
  groups?: string[]
  online?: string[]
  section?: 'all' | 'favorite' | 'recent'
  onEdit?: (host: Host) => void
}

function Hosts({ hosts, recent, favorites, onOpen, onFavorite, onNew, onQuick,
  groups = [], online = [], section = 'all', onEdit }: HostsProps) {
  const [query, setQuery] = useState('')
  const [group, setGroup] = useState('')
  const [mode, setMode] = useState(() => localStorage.getItem('shrimp-host-layout') === 'list' ? 'list' : 'grid')
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase()
    const allowed = (host: Host) => section === 'all' || (section === 'favorite' ? favorites : recent).includes(host.id)
    return hosts.filter((host) => allowed(host) && (!group || section !== 'all' || host.group === group || q)
      && [host.name, host.host, host.user, host.group, host.user + '@' + host.host].some((value) => value?.toLowerCase().includes(q)))
  }, [hosts, query, group, section, favorites, recent])
  const folders = [...new Set([...groups, ...hosts.flatMap((host) => host.group ? [host.group] : [])])]
  const eligible = section === 'recent'
    ? [...matches].sort((a, b) => recent.indexOf(a.id) - recent.indexOf(b.id))
    : matches
  const title = section === 'favorite' ? '收藏' : section === 'recent' ? '最近连接' : '所有主机'
  function connect() {
    if (matches[0]) onOpen(matches[0])
    else onQuick(query.trim())
  }
  function renderHost(host: Host) {
    const favorite = favorites.includes(host.id)
    const live = online.includes(host.id)
    const hue = [...host.id].reduce((sum, char) => sum + (char.codePointAt(0) || 0), 0) % 5
    return (
      <div className="library-host" key={host.id} onContextMenu={(event) => {
        if (onEdit) { event.preventDefault(); onEdit(host) }
      }}>
        <button className="library-connection" data-host-id={host.id} onClick={() => onOpen(host)}>
          <span className={'host-glyph color-' + hue} aria-hidden="true"><Server size={17} /></span>
          <span><strong>{host.name}{live && <i className="live-dot" aria-label="已连接" />}</strong><small>{host.user}@{host.host}:{host.port || 22}</small></span>
        </button>
        <button className="library-star" aria-label={favorite ? '取消收藏 ' + host.name : '收藏 ' + host.name}
          aria-pressed={favorite} onClick={() => onFavorite(host.id)}><Star size={15} fill={favorite ? 'currentColor' : 'none'} /></button>
      </div>
    )
  }
  function changeMode() {
    const next = mode === 'grid' ? 'list' : 'grid'
    setMode(next)
    localStorage.setItem('shrimp-host-layout', next)
  }
  return (
    <div className="library-inner">
      <div className="library-toolbar">
        <label className="library-search"><Search size={15} /><input type="search" aria-label="搜索主机"
          placeholder="搜索主机或输入 user@host" value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
          onKeyDown={(event) => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) connect() }} /></label>
        <button className="workspace-button" onClick={connect}>连接</button>
        <button className="tool-icon view-switch" aria-label={mode === 'grid' ? '切换列表视图' : '切换网格视图'}
          onClick={changeMode}>{mode === 'grid' ? <List size={17} /> : <LayoutGrid size={16} />}</button>
        <button className="workspace-button primary-action" onClick={onNew}><Plus size={16} /> 新建主机</button>
      </div>
      <div className="library-breadcrumb">
        <button className="quiet-button" onClick={() => { setGroup(''); setQuery('') }}>{title}</button>
        {group && section === 'all' && <><ChevronRight size={14} /><span>{group}</span></>}
      </div>
      {!query && section === 'all' && !group && !!folders.length && <section>
        <div className="library-section"><h2>分组</h2><small>{folders.length} 个分组</small></div>
        <div className={'library-grid ' + mode}>
          {folders.map((name) => <button className="library-host folder-tile" key={name} onClick={() => setGroup(name)}>
            <span className="host-glyph folder-glyph"><Folder size={17} /></span>
            <span><strong>{name}</strong><small>{hosts.filter((host) => host.group === name).length} 台主机</small></span>
          </button>)}
        </div>
      </section>}
      <section>
        <div className="library-section"><h2>{query ? '搜索结果' : '主机'}</h2><small>{eligible.length} 台主机</small></div>
        <div className={'library-grid ' + mode}>{eligible.map(renderHost)}</div>
        {!eligible.length && <p className="library-empty">{query ? '没有匹配的主机。' : '这里还没有主机。'}</p>}
      </section>
    </div>
  )
}

const roots = new WeakMap<HTMLElement, Root>()
function rootFor(container: HTMLElement) {
  let root = roots.get(container)
  if (!root) {
    root = createRoot(container)
    roots.set(container, root)
  }
  return root
}

let libraryGeneration = 0
export function renderHosts(container: HTMLElement, props: HostsProps, reset = false) {
  if (reset) libraryGeneration++
  rootFor(container).render(<Hosts key={libraryGeneration} {...props} />)
}

export function renderFiles(container: HTMLElement, props: FilesProps) {
  rootFor(container).render(<FilesView key={props.sessionId ?? 'offline'} {...props} />)
}

export { split, removePane }
