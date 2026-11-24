import { ArrowDown, ArrowUp, Folder, File, RefreshCw, Upload, X } from 'lucide-react'
import { useEffect, useState } from 'react'

export type FileEntry = { name: string; directory: boolean; symlink?: boolean; size?: number; modified?: number }
export type Listing = { directory: string; entries: FileEntry[] }
export type Transfer = {
  id: string; sessionId: string; target: string; name: string; direction: 'upload' | 'download'
  status: 'running' | 'done' | 'cancelled' | 'failed'; bytes: number; total: number; error?: string
}

export type FilesProps = {
  sessionId: string | null
  target: string
  transfers: Transfer[]
  onClose: () => void
  list: (id: string, directory?: string) => Promise<Listing>
  upload: (id: string, directory: string) => Promise<unknown>
  download: (id: string, file: string) => Promise<unknown>
  cancel: (id: string) => Promise<void>
}

function storageSize(bytes = 0) {
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
}

export function FilesView(props: FilesProps) {
  const { sessionId, target, list, upload, download, cancel, transfers, onClose } = props
  const [path, setPath] = useState('')
  const [directory, setDirectory] = useState('')
  const [entries, setEntries] = useState<FileEntry[]>([])
  const [request, setRequest] = useState({ next: '', generation: 0 })
  const [waiting, setWaiting] = useState(Boolean(sessionId))
  const [error, setError] = useState('')
  const [selected, setSelected] = useState<FileEntry | null>(null)
  const [chooser, setChooser] = useState(false)
  const [lastTransfer, setLastTransfer] = useState('')

  function open(next: string) {
    if (!sessionId) return
    setWaiting(true)
    setRequest((current) => ({ next, generation: current.generation + 1 }))
  }

  useEffect(() => {
    if (!sessionId) return
    let current = true
    setError('')
    list(sessionId, request.next || undefined).then((result) => {
      if (!current) return
      setDirectory(result.directory)
      setPath(result.directory)
      setEntries(result.entries.sort((a, b) => Number(Boolean(b.directory)) - Number(Boolean(a.directory)) || a.name.localeCompare(b.name)))
      setSelected(null)
    }).catch((reason: Error) => {
      if (current) setError(reason.message.replace(/^Error invoking remote method '[^']+': Error: /, ''))
    }).finally(() => { if (current) setWaiting(false) })
    return () => { current = false }
  }, [sessionId, request, list])

  const completed = transfers.find((item) => item.direction === 'upload' && item.status === 'done' && item.sessionId === sessionId)
  useEffect(() => {
    if (completed && completed.id !== lastTransfer && directory) {
      setLastTransfer(completed.id)
      setWaiting(true)
      setRequest((current) => ({ next: directory, generation: current.generation + 1 }))
    }
  }, [completed, directory, lastTransfer])

  async function pick(direction: 'upload' | 'download') {
    if (!sessionId || !directory || chooser) return
    if (direction === 'download' && (!selected || selected.directory)) return
    setChooser(true)
    setError('')
    try {
      if (direction === 'upload') await upload(sessionId, directory)
      else if (selected) await download(sessionId, child(selected.name))
    } catch (reason) {
      setError(String((reason as Error).message || reason).replace(/^Error invoking remote method '[^']+': Error: /, ''))
    } finally { setChooser(false) }
  }

  function child(name: string) { return directory.replace(/\/$/, '') + '/' + name }

  return (
    <>
      <div className="dock-header">
        <div><strong>远端文件</strong><small>{target || '未连接'}</small></div>
        <button className="tool-icon" aria-label="关闭远端文件" onClick={onClose}><X size={16} /></button>
      </div>
      <div className="file-overflow">
        {!sessionId ? <p className="dock-empty">连接主机后即可通过 SFTP 浏览文件。</p> : <>
          <form className="file-path" onSubmit={(event) => { event.preventDefault(); open(path.trim()) }}>
            <button type="button" className="tool-icon" aria-label="上一级" disabled={!directory || directory === '/' || waiting}
              onClick={() => open(directory.slice(0, directory.lastIndexOf('/')) || '/')}><ArrowUp size={15} /></button>
            <input aria-label="远端路径" value={path} placeholder="远端绝对路径" onChange={(event) => setPath(event.currentTarget.value)} />
            <button type="button" className="tool-icon" aria-label="刷新文件" disabled={waiting} onClick={() => open(directory)}><RefreshCw size={15} /></button>
          </form>
          {error && <p className="dock-error" role="alert">{error}</p>}
          <div className="file-actions">
            <button className="workspace-button" disabled={!directory || waiting || chooser} onClick={() => void pick('upload')}><Upload size={14} /> 上传</button>
            <button className="workspace-button" disabled={!selected || selected.directory || waiting || chooser} onClick={() => void pick('download')}><ArrowDown size={14} /> 下载</button>
            <small aria-live="polite">{waiting ? '正在读取…' : entries.length + ' 项'}</small>
          </div>
          <div className="file-table" role="group" aria-label="远端目录内容">
            {entries.map((entry) => (
              <button key={entry.name} className="file-row" aria-current={selected === entry} title={entry.name}
                onClick={() => setSelected(entry)}
                onDoubleClick={() => { if (entry.directory || entry.symlink) open(child(entry.name)) }}
                onKeyDown={(event) => { if (event.key === 'Enter' && (entry.directory || entry.symlink)) open(child(entry.name)) }}>
                {entry.directory ? <Folder size={15} /> : <File size={15} />}
                <span>{entry.name}{entry.symlink ? ' ↗' : ''}</span>
                <small>{entry.directory ? '—' : storageSize(entry.size)}</small>
              </button>
            ))}
            {!waiting && !error && !entries.length && <p className="dock-empty">此目录为空。</p>}
          </div>
        </>}
        {!!transfers.length && <section className="transfer-list" aria-label="传输记录">
          <h3>传输</h3>
          {transfers.slice(0, 8).map((item) => (
            <article key={item.id}>
              <div><strong>{item.direction === 'upload' ? '上传' : '下载'} · {item.name}</strong>
                {item.status === 'running' && <button className="tool-icon" onClick={() => void cancel(item.id)} aria-label={'取消 ' + item.name}><X size={14} /></button>}
              </div>
              <small>{item.target} · {item.error || (item.status === 'done' ? '已完成' : item.status === 'cancelled' ? '已取消' : item.status === 'failed' ? '失败' : storageSize(item.bytes) + ' / ' + storageSize(item.total))}</small>
              {item.status === 'running' && <progress max={Math.max(1, item.total)} value={Math.min(item.bytes, item.total)} />}
            </article>
          ))}
        </section>}
      </div>
    </>
  )
}
