type Direction = 'horizontal' | 'vertical'
type MovableElement = HTMLElement & { moveBefore?: (node: Node, reference: Node | null) => void }

function resizeBranch(branch: HTMLElement, ratio: number) {
  const bounds = branch.getBoundingClientRect()
  const axisLength = branch.classList.contains('horizontal') ? bounds.width : bounds.height
  const floor = Math.min(0.48, 138 / Math.max(1, axisLength))
  branch.style.setProperty('--split', Math.min(1 - floor, Math.max(floor, ratio)) * 100 + '%')
}

export function split(base: HTMLElement, pane: HTMLElement, direction: Direction) {
  const branch = document.createElement('div')
  branch.className = 'terminal-split ' + direction
  const separator = document.createElement('button')
  separator.className = 'terminal-separator'
  separator.setAttribute('role', 'separator')
  separator.setAttribute('aria-label', '调整分屏大小')
  separator.setAttribute('aria-orientation', direction === 'horizontal' ? 'vertical' : 'horizontal')

  const prior = base.parentElement
  if (!prior) throw new Error('找不到要分屏的窗格。')
  const after = base.nextSibling
  // moveBefore keeps DOM state on browsers that support atomic reparenting.
  prior.insertBefore(branch, after)
  const move = (branch as MovableElement).moveBefore
  if (move) move.call(branch, base, null)
  else branch.append(base)
  branch.append(separator, pane)
  separator.onpointerdown = (event) => {
    event.preventDefault()
    separator.setPointerCapture(event.pointerId)
  }
  separator.onpointermove = (event) => {
    if (!separator.hasPointerCapture(event.pointerId)) return
    const bounds = branch.getBoundingClientRect()
    const ratio = direction === 'horizontal'
      ? (event.clientX - bounds.left) / bounds.width
      : (event.clientY - bounds.top) / bounds.height
    resizeBranch(branch, ratio)
  }
  separator.onkeydown = (event) => {
    const key = direction === 'horizontal' ? ['ArrowLeft', 'ArrowRight'] : ['ArrowUp', 'ArrowDown']
    if (!key.includes(event.key)) return
    event.preventDefault()
    const ratio = (Number.parseFloat(branch.style.getPropertyValue('--split')) || 50) / 100
    resizeBranch(branch, ratio + (event.key === key[0] ? -0.05 : 0.05))
  }
}

export function removePane(pane: HTMLElement) {
  const branch = pane.parentElement
  if (!branch?.classList.contains('terminal-split')) { pane.remove(); return }
  const sibling = [...branch.children].find((item) => item !== pane && !item.classList.contains('terminal-separator'))
  const parent = branch.parentElement
  if (parent && sibling) {
    const move = (parent as MovableElement).moveBefore
    if (move) {
      move.call(parent, sibling, branch)
      branch.remove()
    } else branch.replaceWith(sibling)
  } else pane.remove()
}
