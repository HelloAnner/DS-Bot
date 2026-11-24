const el = id => document.getElementById(id)
const login = el('login'), chat = el('chat'), target = el('target'), status = el('status'), history = el('history'), older = el('older')
let targets = [], version = 0, cursor = null, previous = [], latest = [], loading = undefined

async function request(path, body) {
  const res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  if (res.status === 401) { chat.hidden = true; login.hidden = false; return undefined }
  if (!res.ok) throw new Error(res.status === 429 ? 'Wait a moment and try again.' : `Request failed (${res.status}).`)
  if (res.status === 204) return true
  const result = await res.json()
  if (!result.ok) throw new Error(result.error.message)
  return result.value
}

function draw() {
  const following = history.scrollHeight - history.scrollTop - history.clientHeight < 48
  history.replaceChildren(...[...previous, ...latest].map(row => {
    const article = document.createElement('article'), name = document.createElement('strong'), text = document.createElement('p')
    name.textContent = row.kind === 'user' ? 'You' : row.name ?? 'Bot'
    text.textContent = row.text
    article.append(name, text)
    return article
  }))
  if (following) history.scrollTop = history.scrollHeight
  older.hidden = !cursor
}
const selected = () => targets.find(item => `${item.kind}:${item.id}` === target.value)
async function read(past = false) {
  const item = selected()
  const mine = version
  if (!item || loading === mine) return
  loading = mine
  try {
    const page = await request('/chat', { action: 'read', kind: item.kind, id: item.id, ...(past ? { cursor } : {}) })
    if (!page || mine !== version) return
    if (past) previous = [...page.items, ...previous]
    else latest = page.items
    if (past || previous.length === 0) cursor = page.cursor
    draw()
  } finally { if (loading === mine) loading = undefined }
}
const report = fn => { void fn().catch(error => { status.textContent = error.message }) }
async function openChat() {
  const list = await request('/chat', { action: 'list' })
  if (!list) return
  targets = list
  target.replaceChildren(...targets.map(item => new Option(item.name, `${item.kind}:${item.id}`)))
  login.hidden = true
  chat.hidden = false
  el('send').hidden = targets.length === 0
  status.textContent = targets.length ? '' : 'No conversations are available.'
  await read()
}
login.addEventListener('submit', event => {
  event.preventDefault()
  report(async () => {
    const code = el('code')
    const ok = await request('/login', { code: code.value.trim() })
    if (!ok) { status.textContent = 'Incorrect LAN access password.'; return }
    code.value = ''
    await openChat()
  })
})
target.addEventListener('change', () => { version += 1; previous = []; latest = []; cursor = null; draw(); report(read) })
older.addEventListener('click', () => report(() => read(true)))
el('send').addEventListener('submit', event => {
  event.preventDefault()
  const item = selected(), box = el('message'), button = el('send').querySelector('button')
  if (!item || button.disabled || !box.value.trim()) return
  report(async () => {
    button.disabled = true
    const text = box.value
    try {
      if (await request('/chat', { action: 'send', kind: item.kind, id: item.id, text })) {
        if (box.value === text) box.value = ''
        status.textContent = ''
        await read()
      }
    } finally { button.disabled = false }
  })
})
report(openChat)
setInterval(() => { if (!chat.hidden && !document.hidden) report(read) }, 2500)
