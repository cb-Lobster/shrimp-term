'use strict'

const { randomUUID } = require('node:crypto')
const { execBackground } = require('./background')
const { readJson, writeJson } = require('./storage')

const active = (record) => record.status === 'running' || record.status === 'waiting'

function createTasks({ file, session, notify, fakeRun }) {
  const tasks = new Map()
  const controllers = new Map()
  let restored = false
  function restore() {
    if (restored) return
    for (const task of readJson(file, [])) {
      if (active(task)) {
        task.status = 'unknown'
        task.error = '应用重启，未取得上一会话的终态。'
        task.finishedAt ||= Date.now()
      }
      tasks.set(task.id, task)
    }
    restored = true
  }

  function persist() {
    const finished = [...tasks.values()].filter((task) => !active(task))
    for (const task of finished.slice(0, Math.max(0, finished.length - 100))) tasks.delete(task.id)
    writeJson(file, [...tasks.values()])
  }

  function update(task, patch, save = true) {
    Object.assign(task, patch)
    if (save) {
      try {
        persist()
      } catch (error) {
        task.storageError = '任务记录写入失败：' + error.message
      }
    }
    notify({ ...task })
  }

  async function start(task) {
    const bound = session(task.sessionId)
    if (!bound) {
      update(task, { status: 'unknown', error: '原连接已断开，任务未发送。', finishedAt: Date.now() })
      return task
    }
    const controller = new AbortController()
    controllers.set(task.id, controller)
    update(task, { status: 'running', startedAt: Date.now() })
    let result
    try {
      result = bound.fake
        ? await fakeRun(task, controller.signal)
        : await execBackground(bound.conn, task.command, {
          signal: controller.signal,
          encoding: bound.encoding,
          onOutput: (name, text, truncated) => update(task, {
            [name]: text, [name + 'Truncated']: truncated,
          }, false),
        })
    } catch (error) {
      result = { status: 'unknown', error: error.message }
    }
    controllers.delete(task.id)
    update(task, { ...result, finishedAt: Date.now() })
    return task
  }

  return {
    list() {
      restore()
      return [...tasks.values()]
    },
    create(bound, conversationId, command, note, approved) {
      restore()
      const task = {
        id: randomUUID(), sessionId: bound.id, paneId: bound.paneId, conversationId,
        hostId: bound.host.id, target: bound.target, command, note,
        status: 'waiting', createdAt: Date.now(),
      }
      tasks.set(task.id, task)
      if (approved) return start(task)
      update(task, {})
      return task
    },
    confirm(id) {
      restore()
      const task = tasks.get(id)
      if (!task || task.status !== 'waiting') return false
      return start(task)
    },
    cancel(id) {
      restore()
      const task = tasks.get(id)
      if (task?.status === 'waiting') {
        update(task, { status: 'cancelled', error: '任务未发送。', finishedAt: Date.now() })
      } else controllers.get(id)?.abort()
    },
    disconnect(sessionId) {
      if (!restored) return
      for (const task of tasks.values()) {
        if (task.sessionId !== sessionId) continue
        if (task.status === 'waiting') {
          update(task, { status: 'unknown', error: '原连接已断开，任务未发送。', finishedAt: Date.now() })
        } else controllers.get(task.id)?.abort('disconnect')
      }
    },
    clear(hostId, conversationId) {
      restore()
      const matching = [...tasks.values()].filter((task) => task.hostId === hostId && task.conversationId === conversationId)
      if (matching.some(active)) throw new Error('请先完成或取消这段对话的后台任务。')
      for (const task of matching) {
        tasks.delete(task.id)
        notify({ id: task.id, hostId, removed: true })
      }
      persist()
    },
  }
}

module.exports = { createTasks }
