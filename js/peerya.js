const ROOT = new URL("../", import.meta.url)

export const PEERYA = {
  name: "Peerya",
  dbName: "peerya",
  home: new URL("home/", ROOT).href,
  login: ROOT.href
}

const BOOTSTRAP_ADMIN = "0xFEE1000000000000000000000000000000000A00"

export const PASSKEYS_AVAILABLE =
  window.isSecureContext &&
  !!window.PublicKeyCredential &&
  !/^\d{1,3}(\.\d{1,3}){3}$/.test(location.hostname)

let dbPromise

export function openDb() {
  if (!dbPromise) {
    dbPromise = import("https://cdn.jsdelivr.net/npm/genosdb@0.36.3/dist/index.js").then(({ gdb }) =>
      gdb(PEERYA.dbName, {
        rtc: true,
        sm: {
          superAdmins: [BOOTSTRAP_ADMIN],
          acls: true,
          customRoles: {
            superadmin: { can: ["assignRole", "deleteAny"], inherits: ["admin"] },
            admin: { can: ["delete"], inherits: ["manager"] },
            manager: { can: ["publish"], inherits: ["user"] },
            user: { can: ["write", "link", "sync"], inherits: ["guest"] },
            guest: { can: ["read", "write", "link", "sync"] }
          }
        }
      })
    )
  }
  return dbPromise
}

export function normalizeUsername(username) {
  return (username || "").trim().toLowerCase()
}

export async function isUsernameTaken(db, username, exceptAddress) {
  const name = normalizeUsername(username)
  if (!name) return false
  try {
    const { result } = await db.get("username:" + name)
    const owner = result && result.value && result.value.address
    if (!owner) return false
    return owner.toLowerCase() !== (exceptAddress || "").toLowerCase()
  } catch {
    return false
  }
}

export async function saveProfile(db, fields) {
  const address = db.sm.getActiveEthAddress()
  if (!address) return
  const { result } = await db.get("profile:" + address)
  const prev = (result && result.value) || {}
  const name = normalizeUsername((fields && fields.username) || prev.username)
  if (!name) return
  if (await isUsernameTaken(db, name, address)) {
    throw new Error("username taken")
  }
  const value = {
    ...prev,
    type: "profile",
    username: name,
    address,
    firstName: fields && fields.firstName != null ? String(fields.firstName).trim() : prev.firstName || "",
    lastName: fields && fields.lastName != null ? String(fields.lastName).trim() : prev.lastName || "",
    email: fields && fields.email != null ? String(fields.email).trim() : prev.email || "",
    birthday: fields && fields.birthday != null ? fields.birthday : prev.birthday || "",
    gender: fields && fields.gender != null ? fields.gender : prev.gender || "",
    about: fields && fields.about != null ? String(fields.about).trim() : prev.about || "",
    createdAt: prev.createdAt || Date.now(),
    updatedAt: Date.now()
  }
  const photo = (fields && fields.avatar && fields.avatar.data)
    ? fields.avatar
    : (prev.avatar && prev.avatar.data ? prev.avatar : null)
  if (photo && photo.data) {
    value.avatar = photo
    value.hasAvatar = true
    await db.put({
      type: "avatar",
      address,
      mime: photo.mime || "image/jpeg",
      data: photo.data,
      updatedAt: Date.now()
    }, "avatar:" + String(address).toLowerCase())
  } else {
    delete value.avatar
  }
  await db.put({ type: "username", username: name, address }, "username:" + name)
  await db.put(value, "profile:" + address)
  localStorage.setItem("peerya.username", name)
  localStorage.setItem("peerya.address", address)
}

export function applyCurrentUser(db, profiles, onlineMap) {
  const me = db.sm.getActiveEthAddress()
  if (!me) return
  const profile = profiles.get(me.toLowerCase())
  const name = displayName(db, profiles, me)
  const handle = "@" + ((profile && profile.username) || db.sm.abbrAddr(me))
  const src = avatarUrl(me, profile)
  const set = (id, write) => {
    const el = document.getElementById(id)
    if (el) write(el)
  }
  set("side-avatar", (el) => {
    el.src = src
    el.alt = name
  })
  set("side-name", (el) => {
    el.textContent = name
  })
  set("side-role", (el) => {
    el.textContent = handle
  })
  set("me-avatar", (el) => {
    el.src = src
    el.alt = name
  })
  set("me-name", (el) => {
    el.textContent = name
  })
  set("me-handle", (el) => {
    el.textContent = handle
  })
  const on = !onlineMap || onlineMap.has(me.toLowerCase())
  set("side-presence", (el) => el.classList.toggle("online", on))
  set("me-presence", (el) => el.classList.toggle("online", on))
  set("settings-presence", (el) => el.classList.toggle("online", on))
  const href = profile && profile.username
    ? new URL("p/" + encodeURIComponent(String(profile.username).toLowerCase()), ROOT).href
    : ""
  set("side-profile-link", (el) => {
    if (href) el.href = href
  })
  set("me-profile-link", (el) => {
    if (href) el.href = href
  })
}

export function setNavBadge(id, count) {
  const el = document.getElementById(id)
  if (!el) return
  const n = Number(count) || 0
  if (n <= 0) {
    el.hidden = true
    el.textContent = ""
    return
  }
  el.hidden = false
  el.textContent = String(n)
}

export function goHome() {
  if (sessionStorage.getItem("peerya.invite")) {
    window.location.replace(new URL("friends/", ROOT).href)
    return
  }
  window.location.replace(PEERYA.home)
}

export function goLogin() {
  window.location.replace(PEERYA.login)
}

export async function requireAuth() {
  const invite = new URLSearchParams(location.search).get("invite")
  if (invite) sessionStorage.setItem("peerya.invite", invite)
  const db = await openDb()
  if (db.sm.isSecurityActive()) return db
  goLogin()
  return null
}

export function friendIdFor(a, b) {
  return "friend:" + [String(a).toLowerCase(), String(b).toLowerCase()].sort().join(":")
}

export function otherFriend(node, me) {
  const mine = String(me).toLowerCase()
  if (String(node.a).toLowerCase() === mine) return node.b
  return node.a
}

export function inviteLink(payload) {
  const token = typeof payload === "string" ? payload : JSON.stringify(payload)
  return new URL("friends/?invite=" + encodeURIComponent(token), ROOT).href
}

export async function acceptInvite(db, raw) {
  const me = db.sm.getActiveEthAddress()
  if (!me || !raw) return null
  let from = null
  const text = String(raw)
  if (/^0x[a-fA-F0-9]{40}$/.test(text)) from = text
  else {
    try {
      from = db.sm.verify(JSON.parse(text), 7 * 24 * 60 * 60 * 1000)
    } catch {
      return null
    }
  }
  if (!from || from.toLowerCase() === me.toLowerCase()) return null
  const id = friendIdFor(from, me)
  const pair = [from.toLowerCase(), me.toLowerCase()].sort()
  const { result } = await db.get(id)
  if (result) return id
  await db.put({
    type: "friend",
    a: pair[0],
    b: pair[1],
    createdAt: Date.now()
  }, id)
  await createNotice(db, { kind: "friend", from: me, to: from })
  return id
}

export async function addFriend(db, other) {
  const me = db.sm.getActiveEthAddress()
  if (!me || !other || String(other).toLowerCase() === me.toLowerCase()) return null
  const id = friendIdFor(me, other)
  const pair = [me.toLowerCase(), String(other).toLowerCase()].sort()
  const { result } = await db.get(id)
  if (result) return id
  await db.put({
    type: "friend",
    a: pair[0],
    b: pair[1],
    createdAt: Date.now()
  }, id)
  await createNotice(db, { kind: "friend", from: me, to: other })
  return id
}

export async function consumeInvite(db) {
  const raw = sessionStorage.getItem("peerya.invite") || new URLSearchParams(location.search).get("invite")
  if (!raw) return null
  sessionStorage.removeItem("peerya.invite")
  const id = await acceptInvite(db, raw)
  history.replaceState({}, "", location.pathname)
  return id
}

export function threadIdFor(a, b) {
  return "dm:" + [String(a).toLowerCase(), String(b).toLowerCase()].sort().join(":")
}

export function otherInThread(threadId, me) {
  const parts = String(threadId).split(":")
  const mine = String(me).toLowerCase()
  if (parts[1] === mine) return parts[2]
  if (parts[2] === mine) return parts[1]
  return parts[2] || parts[1] || ""
}

export function profileHref(profiles, address) {
  const profile = profiles && profiles.get && profiles.get(String(address).toLowerCase())
  const username = profile && profile.username
  if (!username) return ""
  return new URL("p/" + encodeURIComponent(String(username).toLowerCase()), ROOT).href
}

function readAvatar(profile) {
  if (!profile) return ""
  const photo = profile.avatar
  if (typeof photo === "string" && photo.indexOf("data:") === 0) return photo
  if (photo && photo.data) return photo.data
  return ""
}

export function avatarUrl(address, source) {
  const key = String(address || "").toLowerCase()
  let profile = source
  if (source && typeof source.get === "function") profile = source.get(key)
  const data = readAvatar(profile)
  if (data) return data
  return new URL("default_avatar.png", ROOT).href
}

export function attachProfiles(db, profiles, onChange) {
  const emit = () => { if (onChange) onChange() }
  const keyOf = (id, value, prefix) =>
    String((value && value.address) || String(id || "").replace(prefix, "")).toLowerCase()
  db.map({ query: { type: "profile" }, realtime: true }, ({ id, value, action }) => {
    const address = keyOf(id, value, /^profile:/)
    if (!address) return
    if (action === "removed") {
      const prev = profiles.get(address)
      if (prev && prev.avatar) profiles.set(address, { address, avatar: prev.avatar })
      else profiles.delete(address)
    } else if (value) {
      const prev = profiles.get(address) || {}
      const next = { ...prev, ...value, address: value.address || prev.address || address }
      const photo = readAvatar(value) ? value.avatar : (prev.avatar || null)
      if (photo) next.avatar = photo
      else delete next.avatar
      profiles.set(address, next)
    }
    emit()
  })
  db.map({ query: { type: "avatar" }, realtime: true }, ({ id, value, action }) => {
    const address = keyOf(id, value, /^avatar:/)
    if (!address) return
    const prev = profiles.get(address) || { address }
    if (action === "removed") delete prev.avatar
    else if (value && (value.data || (value.avatar && value.avatar.data))) {
      prev.avatar = value.data
        ? { mime: value.mime || "image/jpeg", data: value.data }
        : value.avatar
    }
    profiles.set(address, prev)
    emit()
  })
}

export async function sendDm(db, to, text) {
  const from = db.sm.getActiveEthAddress()
  const body = (text || "").trim()
  if (!from || !to || !body) return null
  const threadId = threadIdFor(from, to)
  const createdAt = Date.now()
  const payload = { type: "dm", threadId, from, to, createdAt, text: body }
  const smId = await db.sm.put(payload)
  try {
    await db.sm.acls.grant(smId, to, "read")
  } catch {}
  await db.put({
    type: "dm",
    threadId,
    from,
    to,
    createdAt,
    smId
  })
  const pair = [from.toLowerCase(), to.toLowerCase()].sort()
  await db.put({
    type: "thread",
    threadId,
    a: pair[0],
    b: pair[1],
    lastAt: createdAt,
    lastFrom: from
  }, "thread:" + threadId)
  await createNotice(db, { kind: "dm", from, to, text: body })
  return { smId, threadId, createdAt }
}

export async function readDmText(db, smId) {
  if (!smId) return ""
  try {
    const { result } = await db.sm.get(smId)
    if (result && result.decrypted && result.value) return result.value.text || ""
  } catch {}
  return ""
}

export function displayName(db, profiles, address) {
  const profile = profiles.get(String(address).toLowerCase())
  if (profile) {
    const full = [profile.firstName, profile.lastName].filter(Boolean).join(" ").trim()
    if (full) return full
    if (profile.username) return profile.username
  }
  try {
    return db.sm.abbrAddr(address)
  } catch {
    return String(address || "").slice(0, 10)
  }
}

export function timeAgo(ms) {
  if (!ms) return ""
  const diff = Date.now() - ms
  if (diff < 60000) return "now"
  if (diff < 3600000) return Math.floor(diff / 60000) + "m ago"
  if (diff < 86400000) return Math.floor(diff / 3600000) + "h ago"
  return Math.floor(diff / 86400000) + "d ago"
}

export function startPresence(db, onChange) {
  const TTL = 35000
  const online = new Map()
  const lastSeen = new Map()
  const peerToUser = new Map()
  const me = db.sm.getActiveEthAddress()
  const notify = () => { if (onChange) onChange() }
  const mark = (address, peerId) => {
    const key = String(address).toLowerCase()
    const was = online.has(key)
    lastSeen.set(key, Date.now())
    online.set(key, peerId || online.get(key) || "peer")
    if (peerId && peerId !== "self") peerToUser.set(peerId, key)
    if (!was) notify()
  }
  const drop = (address) => {
    const key = String(address).toLowerCase()
    if (me && key === me.toLowerCase()) return
    if (!online.has(key)) return
    online.delete(key)
    lastSeen.delete(key)
    notify()
  }
  const announce = async () => {
    if (me) mark(me, "self")
    if (!db.room) return
    try {
      const hello = await db.sm.sign({ kind: "here" })
      db.room.channel("presence").send(hello)
    } catch {}
  }
  if (me) mark(me, "self")
  if (!db.room) return { online, stop() {} }
  const channel = db.room.channel("presence")
  channel.on("message", (data, peerId) => {
    const from = db.sm.verify(data, TTL)
    if (from) mark(from, peerId)
  })
  db.room.on("peer:join", () => announce())
  db.room.on("peer:leave", (peerId) => {
    const address = peerToUser.get(peerId)
    peerToUser.delete(peerId)
    if (address) drop(address)
  })
  announce()
  const beat = setInterval(announce, 8000)
  const prune = setInterval(() => {
    const now = Date.now()
    for (const [address, at] of lastSeen) {
      if (me && address === me.toLowerCase()) continue
      if (now - at >= TTL) drop(address)
    }
  }, 4000)
  return {
    online,
    stop() {
      clearInterval(beat)
      clearInterval(prune)
    }
  }
}

export const MAX_POST_IMAGES = 4

export function compressImage(file, maxSize) {
  return new Promise((resolve) => {
    if (!file || !String(file.type || "").startsWith("image/")) {
      resolve(null)
      return
    }
    const img = new Image()
    const url = URL.createObjectURL(file)
    img.onload = () => {
      const max = maxSize || 1280
      let width = img.width
      let height = img.height
      if (width > max || height > max) {
        const scale = Math.min(max / width, max / height)
        width = Math.round(width * scale)
        height = Math.round(height * scale)
      }
      const canvas = document.createElement("canvas")
      canvas.width = width
      canvas.height = height
      canvas.getContext("2d").drawImage(img, 0, 0, width, height)
      URL.revokeObjectURL(url)
      resolve({ mime: "image/jpeg", data: canvas.toDataURL("image/jpeg", maxSize && maxSize <= 400 ? 0.72 : 0.8) })
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      resolve(null)
    }
    img.src = url
  })
}

export function compressAvatar(file) {
  return new Promise((resolve) => {
    if (!file || !String(file.type || "").startsWith("image/")) {
      resolve(null)
      return
    }
    const img = new Image()
    const url = URL.createObjectURL(file)
    img.onload = () => {
      const size = Math.min(img.width, img.height) || 1
      const sx = (img.width - size) / 2
      const sy = (img.height - size) / 2
      const canvas = document.createElement("canvas")
      canvas.width = 256
      canvas.height = 256
      canvas.getContext("2d").drawImage(img, sx, sy, size, size, 0, 0, 256, 256)
      URL.revokeObjectURL(url)
      resolve({ mime: "image/jpeg", data: canvas.toDataURL("image/jpeg", 0.72) })
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      resolve(null)
    }
    img.src = url
  })
}

export async function publishPost(db, caption, images) {
  const author = db.sm.getActiveEthAddress()
  const text = (caption || "").trim()
  const pics = (images || []).filter((image) => image && image.data).slice(0, MAX_POST_IMAGES)
  if (!author || (!text && !pics.length)) return null
  return db.put({
    type: "post",
    author,
    caption: text,
    images: pics,
    createdAt: Date.now()
  })
}

export async function toggleFollow(db, target) {
  const from = db.sm.getActiveEthAddress()
  if (!from || !target) return false
  const id = "follow:" + from.toLowerCase() + ":" + String(target).toLowerCase()
  const { result } = await db.get(id)
  if (result) {
    await db.remove(id)
    return false
  }
  await db.put({ type: "follow", from, to: target, createdAt: Date.now() }, id)
  return true
}

export async function toggleReaction(db, kind, postId) {
  const from = db.sm.getActiveEthAddress()
  if (!from || !postId || (kind !== "like" && kind !== "heart")) return false
  const id = kind + ":" + postId + ":" + from.toLowerCase()
  const { result } = await db.get(id)
  if (result) {
    await db.remove(id)
    return false
  }
  await db.put({ type: kind, postId, from, createdAt: Date.now() }, id)
  try {
    const { result: post } = await db.get(postId)
    const author = post && post.value && post.value.author
    if (author) await createNotice(db, { kind, from, to: author, postId })
  } catch {}
  return true
}

export async function toggleLike(db, postId) {
  return toggleReaction(db, "like", postId)
}

export async function toggleHeart(db, postId) {
  return toggleReaction(db, "heart", postId)
}

export async function addComment(db, postId, text, parentId) {
  const author = db.sm.getActiveEthAddress()
  const body = (text || "").trim()
  if (!author || !postId || !body) return null
  const commentId = await db.put({
    type: "comment",
    postId,
    parentId: parentId || "",
    author,
    text: body,
    createdAt: Date.now()
  })
  try {
    if (parentId) {
      const { result } = await db.get(parentId)
      const to = result && result.value && result.value.author
      if (to) await createNotice(db, { kind: "reply", from: author, to, postId, text: body })
    } else {
      const { result } = await db.get(postId)
      const to = result && result.value && result.value.author
      if (to) await createNotice(db, { kind: "comment", from: author, to, postId, text: body })
    }
  } catch {}
  return commentId
}

export async function createNotice(db, { kind, from, to, postId, text }) {
  const a = String(from || "").toLowerCase()
  const b = String(to || "").toLowerCase()
  if (!a || !b || a === b) return null
  return db.put({
    type: "notice",
    kind: kind || "info",
    from: a,
    to: b,
    postId: postId || "",
    text: String(text || "").slice(0, 80),
    createdAt: Date.now(),
    read: false
  })
}

export function watchNotices(db, onChange) {
  const me = String(db.sm.getActiveEthAddress() || "").toLowerCase()
  const items = new Map()
  const emit = () => {
    const unread = [...items.values()].filter((item) => !item.read).length
    if (onChange) onChange(unread, items)
  }
  db.map({ query: { type: "notice" }, realtime: true }, ({ id, value, action }) => {
    if (action === "removed") items.delete(id)
    else if (value && String(value.to).toLowerCase() === me) items.set(id, { ...value, id })
    else return
    emit()
  })
  return items
}

export async function markNoticesRead(db, items) {
  for (const notice of items) {
    if (!notice || !notice.id || notice.read) continue
    const { id, ...value } = notice
    await db.put({ ...value, read: true }, id)
  }
}

export async function signOut(db) {
  try {
    await db.sm.clearSecurity()
  } catch {}
  localStorage.removeItem("peerya.username")
  localStorage.removeItem("peerya.address")
  goLogin()
}
