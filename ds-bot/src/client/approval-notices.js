import { NOTIFY_KEY, readNotifyPrefs } from './notify.js'
import { t } from './i18n.js'

export function browserNotify({ title, body, tag }, open, NotificationApi = globalThis.Notification) {
  if (globalThis.isSecureContext === false || typeof NotificationApi !== 'function' || NotificationApi.permission !== 'granted') return
  try {
    const note = new NotificationApi(title, { body, tag })
    note.onclick = () => {
      window.focus()
      open()
      note.close()
    }
  } catch { /* Some browsers expose Notification but cannot construct one in a tab. */ }
}

// A system notification for each approval that starts waiting while this window is in
// the background or shows another conversation. Only where the platform already allows
// notifications. The user can grant permission in Settings.
export function noticeApprovals({ work, roster, shownSession, openSession, since = Date.now() }) {
  if (typeof window !== 'undefined' && window.dsBotApp) return () => {}
  const told = new Set()
  const notify = () => {
    const approvals = work.getSnapshot().approvals ?? []
    for (const id of told) {
      if (!approvals.some(entry => entry.id === id)) told.delete(id)
    }
    let stored
    try { stored = globalThis.localStorage?.getItem(NOTIFY_KEY) } catch { /* storage unavailable */ }
    const prefs = readNotifyPrefs(stored)
    for (const entry of approvals) {
      if (told.has(entry.id)) continue
      told.add(entry.id)
      // Waiting before this window opened is no news: the sidebar shows it.
      if ((entry.at ?? 0) < since) continue
      const place = entry.roomId ?? entry.sessionId
      const chat = entry.roomId ?? entry.botId
      if (!prefs.enabled || prefs.muted[chat]) continue
      const shown = shownSession()
      const snapshot = roster.getSnapshot()
      if (document.visibilityState !== 'hidden' && document.hasFocus?.() !== false
        && ((shown != null && shown === place) || (entry.roomId ? snapshot.roomsById?.[shown]?.id === chat : snapshot.byId?.[shown]?.id === chat))) continue
      const { byId, roomsById } = snapshot
      const room = entry.roomId ? roomsById[entry.roomId] : undefined
      browserNotify({
        title: t('{name} is waiting for your approval', { name: byId[entry.botId]?.name ?? t('A Bot') }),
        body: [room?.name, entry.tool].filter(Boolean).join(' · '),
        tag: `ds-bot-approval-${entry.id}`,
      }, () => openSession(chat))
    }
  }
  notify()
  return work.subscribe(notify)
}
