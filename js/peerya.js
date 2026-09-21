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
  if (fields && fields.avatar) value.avatar = fields.avatar
  await db.put({ type: "username", username: name, address }, "username:" + name)
  await db.put(value, "profile:" + address)
  localStorage.setItem("peerya.username", name)
  localStorage.setItem("peerya.address", address)
}

export function applyCurrentUser(db, profiles) {
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

export function avatarUrl(address, source) {
  let profile = source
  if (source && typeof source.get === "function") profile = source.get(String(address).toLowerCase())
  if (profile && profile.avatar && profile.avatar.data) return profile.avatar.data
  return "https://i.pravatar.cc/80?u=" + encodeURIComponent(address || "peerya")
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
  const online = new Map()
  const peerToUser = new Map()
  const announce = async () => {
    try {
      const hello = await db.sm.sign({ room: "peerya" })
      db.room.channel("presence").send(hello)
    } catch {}
  }
  const me = db.sm.getActiveEthAddress()
  if (me) online.set(me.toLowerCase(), "self")
  if (!db.room) return { online, stop() {} }
  const channel = db.room.channel("presence")
  channel.on("message", (data, peerId) => {
    const from = db.sm.verify(data)
    if (!from) return
    peerToUser.set(peerId, from.toLowerCase())
    online.set(from.toLowerCase(), peerId)
    if (onChange) onChange()
  })
  db.room.on("peer:join", () => announce())
  db.room.on("peer:leave", (peerId) => {
    const address = peerToUser.get(peerId)
    if (address) online.delete(address)
    peerToUser.delete(peerId)
    if (onChange) onChange()
  })
  announce()
  const timer = setInterval(announce, 25000)
  return {
    online,
    stop() {
      clearInterval(timer)
    }
  }
}

export const MAX_POST_IMAGES = 4

export function compressImage(file) {
  return new Promise((resolve) => {
    if (!file || !String(file.type || "").startsWith("image/")) {
      resolve(null)
      return
    }
    const img = new Image()
    const url = URL.createObjectURL(file)
    img.onload = () => {
      const max = 1280
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
      resolve({ mime: "image/jpeg", data: canvas.toDataURL("image/jpeg", 0.8) })
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
  return db.put({
    type: "comment",
    postId,
    parentId: parentId || "",
    author,
    text: body,
    createdAt: Date.now()
  })
}

export async function signOut(db) {
  try {
    await db.sm.clearSecurity()
  } catch {}
  localStorage.removeItem("peerya.username")
  localStorage.removeItem("peerya.address")
  goLogin()
}
