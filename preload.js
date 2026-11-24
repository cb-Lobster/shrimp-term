'use strict'
const { contextBridge, ipcRenderer } = require('electron')

function subscribe(channel, callback) {
  const listener = (_event, payload) => callback(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

contextBridge.exposeInMainWorld('st', {
  hosts: () => ipcRenderer.invoke('hosts:list'),
  saveHost: (h) => ipcRenderer.invoke('hosts:save', h),

  groups: () => ipcRenderer.invoke('hosts:groups'),

  deleteHost: (id) => ipcRenderer.invoke('hosts:delete', id),

  settings: () => ipcRenderer.invoke('settings:get'),

  histGet: (k) => ipcRenderer.invoke('hist:get', k),

  histSave: (k, v) => ipcRenderer.invoke('hist:save', k, v),

  histClear: (k) => ipcRenderer.invoke('hist:clear', k),
  histList: (h) => ipcRenderer.invoke('hist:list', h),

  saveSettings: (s) => ipcRenderer.invoke('settings:save', s),

  addGroup: (n) => ipcRenderer.invoke('hosts:addGroup', n),
  open: (hostId, opts) => ipcRenderer.invoke('term:open', hostId, opts),
  attach: (id) => ipcRenderer.invoke('term:attach', id),

  setEncoding: (id, enc) => ipcRenderer.invoke('term:setEncoding', id, enc),
  input: (id, data) => ipcRenderer.invoke('term:input', { id, data }),
  resize: (id, cols, rows) => ipcRenderer.invoke('term:resize', { id, cols, rows }),
  close: (id) => ipcRenderer.invoke('term:close', id),
  listFiles: (id, directory) => ipcRenderer.invoke('files:list', id, directory),
  uploadFile: (id, directory) => ipcRenderer.invoke('files:upload', id, directory),
  downloadFile: (id, remote) => ipcRenderer.invoke('files:download', id, remote),
  cancelTransfer: (id) => ipcRenderer.invoke('files:cancel', id),
  copyText: (text) => ipcRenderer.invoke('app:copy', text),
  appInfo: () => ipcRenderer.invoke('app:info'),

  ask: (req) => ipcRenderer.invoke('agent:ask', req),
  tasks: () => ipcRenderer.invoke('agent:tasks'),
  confirmTask: (id) => ipcRenderer.invoke('agent:confirm', id),
  cancelTask: (id) => ipcRenderer.invoke('agent:cancel', id),
  clearTasks: (hostId, conversationId) => ipcRenderer.invoke('agent:clear', hostId, conversationId),

  testAgent: (cfg) => ipcRenderer.invoke('agent:test', cfg),
  winMinimize: () => ipcRenderer.invoke('win:minimize'),
  winMaximize: () => ipcRenderer.invoke('win:maximize'),
  winClose: () => ipcRenderer.invoke('win:close'),
  onData: (cb) => subscribe('term:data', cb),
  onClosed: (cb) => subscribe('term:closed', cb),
  onTransfer: (cb) => subscribe('files:transfer', cb),
  onTask: (cb) => subscribe('agent:task', cb),
})
