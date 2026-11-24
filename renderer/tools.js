// Workspace tools share the current pane through the same selection as the terminal.
let librarySection = 'all'
const transfers = new Map()
const listFiles = (id, directory) => window.st.listFiles(id, directory)
const uploadFile = (id, directory) => window.st.uploadFile(id, directory)
const downloadFile = (id, remote) => window.st.downloadFile(id, remote)
const cancelTransfer = (id) => window.st.cancelTransfer(id)

function setFilesVisible(visible) {
  el('filesPanel').hidden = !visible
  el('filesTop').setAttribute('aria-pressed', String(visible))
  if (visible) setRightVisible(false)
  updateFileView()
}

function updateFileView() {
  const pane = tabById(activeId)
  if (!el('filesPanel').hidden) {
    window.shrimpWorkspace.renderFiles(el('filesPanel'), {
      sessionId: pane?.sessionId || null, target: pane?.userTarget || '',
      transfers: [...transfers.values()].reverse(),
      list: listFiles, upload: uploadFile, download: downloadFile, cancel: cancelTransfer,
      onClose: () => { setFilesVisible(false); pane?.term.focus() },
    })
  }
}

window.st.onTransfer((record) => {
  transfers.set(record.id, record)
  const completed = [...transfers.values()].filter((item) => item.status !== 'running')
  for (const item of completed.slice(0, Math.max(0, completed.length - 30))) transfers.delete(item.id)
  const count = [...transfers.values()].filter((item) => item.status === 'running').length
  el('filesTop').classList.toggle('transferring', count > 0)
  el('filesTop').title = count > 0 ? 'SFTP · ' + count + ' 个传输中' : '远端文件'
  updateFileView()
})
el('filesTop').onclick = () => setFilesVisible(el('filesPanel').hidden)

function showLibrary(section = 'all') {
  const changedSection = librarySection !== section
  librarySection = section
  for (const link of document.querySelectorAll('button[data-library]')) {
    const selected = link.dataset.library === section
    link.classList.toggle('active', selected)
    link.setAttribute('aria-pressed', String(selected))
  }
  if (activeId) selectTerm(null)
  setRightVisible(false)
  setFilesVisible(false)
  setPanelVisible(false)
  renderHosts(changedSection)
  requestAnimationFrame(() => el('hostLibrary').querySelector('input')?.focus())
}
for (const link of document.querySelectorAll('button[data-library]')) {
  link.onclick = () => showLibrary(link.dataset.library)
}
el('libraryHome').onclick = () => showLibrary()
el('toggleHosts').onclick = () => {
  if (!activeId) { showLibrary(); return }
  setPanelVisible(el('panel').classList.contains('hidden'))
  if (!el('panel').classList.contains('hidden')) el('hostSearch').focus()
}

function showSearch(open) {
  const pane = tabById(activeId)
  el('searchWrap').hidden = !open || !pane
  el('searchToggle').setAttribute('aria-expanded', String(open && !!pane))
  if (open && pane) { el('searchInput').focus(); el('searchInput').select() }
  else if (pane) pane.term.focus()
}
el('searchToggle').onclick = () => showSearch(el('searchWrap').hidden)
el('searchClose').onclick = () => showSearch(false)
el('searchInput').addEventListener('keydown', (event) => {
  if (event.key === 'Escape') { event.stopPropagation(); showSearch(false) }
})

function showTools(open) {
  el('terminalTools').hidden = !open
  el('moreTools').setAttribute('aria-expanded', String(open))
}
el('moreTools').onclick = () => showTools(el('terminalTools').hidden)
document.addEventListener('click', (event) => {
  if (!event.target.closest('#terminalTools, #moreTools')) showTools(false)
})

function launcherItems() {
  const pane = tabById(activeId)
  return [
    ...workspaces.map((workspace) => ({
      name: workspace.name, detail: '已打开的标签', action: () => selectTerm(workspace.activePane),
    })),
    ...allHosts.map((host) => ({
      name: host.name || host.id, detail: [host.user + '@' + host.host, host.group].filter(Boolean).join(' · '), action: () => openHost(host),
    })),
    { name: '主机库', detail: '工作区', action: () => showLibrary() },
    { name: '新建主机', detail: '连接', action: () => openDialog(null) },
    { name: '常用命令', detail: '本地命令库', action: openSnippets },
    ...(pane ? [
      { name: '远端文件 SFTP', detail: '浏览和传输', action: () => setFilesVisible(true) },
      { name: '终端搜索', detail: 'Ctrl+Shift+F', action: () => showSearch(true) },
      { name: '分屏', detail: '新建窗格', action: () => el('splitMenu').click() },
      { name: '会话助手', detail: '后台 SSH', action: () => setRightVisible(true) },
    ] : []),
  ]
}

let launcherSelection = 0
function renderLauncher(items = launcherItems()) {
  const query = el('launcherQuery').value.trim().toLowerCase()
  const filtered = items.filter((item) => (item.name + ' ' + item.detail).toLowerCase().includes(query)).slice(0, 35)
  launcherSelection = Math.min(Math.max(0, launcherSelection), Math.max(0, filtered.length - 1))
  const container = el('launcherItems')
  container.replaceChildren()
  filtered.forEach((item, index) => {
    const button = document.createElement('button')
    button.className = 'palette-row'
    const name = document.createElement('span')
    const detail = document.createElement('small')
    name.textContent = item.name
    detail.textContent = item.detail
    button.append(name, detail)
    if (index === launcherSelection) button.classList.add('chosen')
    button.onclick = () => { el('launcherDialog').close(); item.action() }
    container.append(button)
  })
  if (!filtered.length) {
    const empty = document.createElement('p')
    empty.className = 'dock-empty'
    empty.textContent = '没有匹配的主机或操作。'
    container.append(empty)
  }
}

function openLauncher() {
  const dialog = el('launcherDialog')
  if (dialog.open) return
  el('launcherQuery').value = ''
  launcherSelection = 0
  renderLauncher()
  dialog.showModal()
  el('launcherQuery').focus()
}
el('openLauncher').onclick = openLauncher
el('launcherClose').onclick = () => el('launcherDialog').close()
el('launcherQuery').oninput = () => { launcherSelection = 0; renderLauncher() }
el('launcherQuery').onkeydown = (event) => {
  if (event.isComposing) return
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault()
    launcherSelection += event.key === 'ArrowDown' ? 1 : -1
    renderLauncher()
    el('launcherItems').querySelector('.chosen')?.scrollIntoView({ block: 'nearest' })
  }
  if (event.key === 'Enter') {
    event.preventDefault()
    el('launcherItems').querySelector('.chosen')?.click()
  }
}

let editingSnippet = null
function clearSnippetForm() {
  editingSnippet = null
  el('snippetForm').reset()
  el('snippetReset').hidden = true
  el('snippetMessage').textContent = ''
}
function snippetButton(label, action) {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'workspace-button'
  button.textContent = label
  button.onclick = action
  return button
}
async function saveSnippets(snippets) {
  await window.st.saveSettings({ snippets })
  settings.snippets = snippets
  clearSnippetForm()
  renderSnippets()
}
function renderSnippets() {
  const container = el('snippetItems')
  container.replaceChildren()
  const snippets = settings.snippets || []
  for (const snippet of snippets) {
    const row = document.createElement('article')
    row.className = 'snippet-row'
    const label = document.createElement('strong')
    label.textContent = snippet.name
    const command = document.createElement('code')
    command.textContent = snippet.command
    const group = document.createElement('div')
    group.className = 'snippet-actions'
    group.append(snippetButton('复制', async () => {
      try {
        await window.st.copyText(snippet.command)
        el('snippetMessage').textContent = '已复制到剪贴板。'
      } catch (error) { el('snippetMessage').textContent = error.message }
    }), snippetButton('编辑', () => {
      editingSnippet = snippet.id
      el('snippetName').value = snippet.name
      el('snippetCommand').value = snippet.command
      el('snippetReset').hidden = false
      el('snippetName').focus()
    }), snippetButton('删除', async (event) => {
      if (event.currentTarget.textContent === '删除') {
        event.currentTarget.textContent = '确认删除'
        return
      }
      try { await saveSnippets(snippets.filter((item) => item.id !== snippet.id)) }
      catch (error) { el('snippetMessage').textContent = error.message }
    }))
    row.append(label, command, group)
    container.append(row)
  }
  if (!snippets.length) {
    const empty = document.createElement('p')
    empty.className = 'dock-empty'
    empty.textContent = '保存常用命令，之后可一键复制。'
    container.append(empty)
  }
}
function openSnippets() {
  clearSnippetForm()
  renderSnippets()
  el('snippetsDialog').showModal()
}
el('snippetsHome').onclick = openSnippets
el('snippetsClose').onclick = () => el('snippetsDialog').close()
el('snippetReset').onclick = clearSnippetForm
el('snippetForm').onsubmit = async (event) => {
  event.preventDefault()
  const name = el('snippetName').value.trim()
  const command = el('snippetCommand').value.trim()
  if (!name || !command) return
  const snippets = settings.snippets || []
  if (!editingSnippet && snippets.length >= 100) { el('snippetMessage').textContent = '已保存 100 条命令。'; return }
  const next = { id: editingSnippet || crypto.randomUUID(), name, command }
  try { await saveSnippets(editingSnippet ? snippets.map((item) => item.id === editingSnippet ? next : item) : [...snippets, next]) }
  catch (error) { el('snippetMessage').textContent = error.message }
}

document.addEventListener('keydown', (event) => {
  if (event.defaultPrevented || event.isComposing || !event.ctrlKey || event.altKey) return
  const key = event.key.toLowerCase()
  if (!event.shiftKey && key === 'k') {
    if (document.querySelector('dialog[open], .ovl.on, #overlay.on')) return
    event.preventDefault()
    event.stopPropagation()
    openLauncher()
  } else if (event.shiftKey && key === 'f' && activeId && !document.querySelector('dialog[open], .ovl.on, #overlay.on')) {
    event.preventDefault()
    event.stopPropagation()
    showSearch(el('searchWrap').hidden)
  }
}, true)
