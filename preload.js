'use strict'
const { contextBridge, ipcRenderer } = require('electron')

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

  setEncoding: (id, enc) => ipcRenderer.invoke('term:setEncoding', id, enc),
  input: (id, data) => ipcRenderer.invoke('term:input', { id, data }),
  resize: (id, cols, rows) => ipcRenderer.invoke('term:resize', { id, cols, rows }),
  close: (id) => ipcRenderer.invoke('term:close', id),
  appInfo: () => ipcRenderer.invoke('app:info'),

  ask: (req) => ipcRenderer.invoke('agent:ask', req),

  testAgent: (cfg) => ipcRenderer.invoke('agent:test', cfg),
  winMinimize: () => ipcRenderer.invoke('win:minimize'),
  winMaximize: () => ipcRenderer.invoke('win:maximize'),
  winClose: () => ipcRenderer.invoke('win:close'),
  onData: (cb) => ipcRenderer.on('term:data', (_e, p) => cb(p)),
  onClosed: (cb) => ipcRenderer.on('term:closed', (_e, p) => cb(p)),
})
