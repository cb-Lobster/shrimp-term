export interface Host {
  id: string
  name: string
  host: string
  port: number
  user: string
  group?: string
  disabled?: boolean
  hasPassword?: boolean
}

export interface Task {
  id: string
  hostId: string
  sessionId: string
  paneId?: string
  conversationId: string
  target: string
  command: string
  note: string
  status: 'waiting' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'timeout' | 'unknown'
  createdAt: number
  startedAt?: number
  finishedAt?: number
  stdout?: string
  stderr?: string
  stdoutTruncated?: boolean
  stderrTruncated?: boolean
  exitCode?: number | null
  exitSignal?: string | null
  error?: string
  storageError?: string
}

export type OpenConnection = { id: string } | { trust: { endpoint: string; fingerprint: string; token: string } }
export type TerminalData = { id: string; data: string }
export type TerminalClosed = { id: string; reason: string }
export type TaskEvent = Task | { id: string; hostId: string; removed: true }

declare global {
  interface Window {
    st: {
      open(hostId: string, options: { paneId?: string; encoding?: string; trustToken?: string }): Promise<OpenConnection>
      attach(sessionId: string): Promise<void>
      input(sessionId: string, data: string): Promise<boolean>
      resize(sessionId: string, cols: number, rows: number): Promise<void>
      onData(callback: (event: TerminalData) => void): () => void
      onClosed(callback: (event: TerminalClosed) => void): () => void
      onTask(callback: (event: TaskEvent) => void): () => void
    }
  }
}
