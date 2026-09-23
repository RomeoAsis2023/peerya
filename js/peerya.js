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

const MESH_APP = "peerya"
const MESH_CHANNEL = "peerya-live"
const MESH_NOSTR = [
  "wss://relay.damus.io",
  "wss://nos.lol",
  "wss://relay.snort.social",
  "wss://relay.primal.net",
  "wss://offchain.pub"
]
const MESH_MQTT = [
  "wss://peeryamqtt:Hoopla2019%21@captain.010101010101.xyz:8884/",
  "wss://broker.emqx.io:8084/mqtt",
  "wss://test.mosquitto.org:8081"
]
const MESH_TRACKERS = [
  "wss://tracker.webtorrent.dev",
  "wss://tracker.openwebtorrent.com",
  "wss://tracker.btorrent.xyz"
]

async function hmacSha1B64(secret, msg) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-1" }, false, ["sign"])
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg))
  const bytes = new Uint8Array(sig)
  let out = ""
  for (let i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i])
  return btoa(out)
}

export async function callIceServers() {
  return meshIceServers()
}

async function meshIceServers() {
  const stun = [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    { urls: "stun:stun.cloudflare.com:3478" }
  ]
  try {
    const username = String(Math.floor(Date.now() / 1000) + 86400)
    const credential = await hmacSha1B64("openrelayprojectsecret", username)
    return stun.concat({
      urls: [
        "turn:staticauth.openrelay.metered.ca:80",
        "turn:staticauth.openrelay.metered.ca:80?transport=tcp",
        "turn:staticauth.openrelay.metered.ca:443",
        "turn:staticauth.openrelay.metered.ca:443?transport=tcp",
        "turns:staticauth.openrelay.metered.ca:443?transport=tcp"
      ],
      username,
      credential
    })
  } catch {
    return stun
  }
}
const meshCtx = {
  db: null,
  online: null,
  mark: null,
  drop: null,
  notify: null,
  profiles: null,
  profileChange: null,
  liveMaps: new Map(),
  callHandlers: new Set(),
  disconnectHandlers: new Set(),
  onStream: null
}
let meshConnect = null
let meshReady = null
let remoteDepth = 0
const meshPeerUser = new Map()
const meshUserPeer = new Map()
const meshAvatars = new Map()

function wrapDb(db) {
  if (!db || db.__put) return db
  db.__put = db.put.bind(db)
  db.__remove = db.remove.bind(db)
  db.put = async (value, id) => {
    const result = await db.__put(value, id)
    const nodeId = id || result
    liveSet(nodeId, value)
    ingestReaction(nodeId, value)
    if (remoteDepth === 0 && value && value.type) {
      meshSend({ kind: "put", id: nodeId, value: linkOnly(value) })
    }
    meshEmit()
    return result
  }
  db.remove = async (id) => {
    const result = await db.__remove(id)
    liveRemove(id)
    ingestReaction(id, null, "removed")
    if (remoteDepth === 0) meshSend({ kind: "remove", id })
    meshEmit()
    return result
  }
  return db
}

function linkOnly(value) {
  if (!value || typeof value !== "object") return value
  const next = { ...value }
  if (next.url && next.data) delete next.data
  if (next.avatar && next.avatar.url) {
    next.avatar = { url: next.avatar.url, key: next.avatar.key || "", mime: next.avatar.mime || "" }
  }
  if (Array.isArray(next.images)) {
    next.images = next.images.map((image) => image && image.url
      ? { url: image.url, key: image.key || "", mime: image.mime || "", name: image.name || "" }
      : image)
  }
  return next
}

function meshSend(payload, connectId) {
  if (!meshConnect || !payload) return
  const msg = payload.value ? { ...payload, value: linkOnly(payload.value) } : payload
  try {
    meshConnect.Send(msg, { connectId: connectId === undefined ? null : connectId })
  } catch {}
}

function meshEmit() {
  if (meshCtx.notify) meshCtx.notify()
  if (meshCtx.profileChange) meshCtx.profileChange()
}

function liveSet(id, value) {
  if (!id || !value || !value.type) return
  const map = meshCtx.liveMaps.get(value.type)
  if (map) map.set(id, { ...value, id })
}

function liveRemove(id) {
  if (!id) return
  for (const map of meshCtx.liveMaps.values()) map.delete(id)
}

export function bindLiveMap(type, map) {
  meshCtx.liveMaps.set(type, map)
}

export function meshPeerFor(address) {
  return meshUserPeer.get(String(address || "").toLowerCase()) || null
}

export function sendMeshCall(payload, connectId) {
  const ids = new Set()
  if (connectId) ids.add(connectId)
  meshPeerUser.forEach((address, id) => ids.add(id))
  if (!ids.size) {
    meshSend(payload, null)
    return
  }
  ids.forEach((id) => meshSend(payload, id))
}

export function onMeshCall(fn) {
  meshCtx.callHandlers.add(fn)
  return () => meshCtx.callHandlers.delete(fn)
}

export function onMeshDisconnect(fn) {
  meshCtx.disconnectHandlers.add(fn)
  return () => meshCtx.disconnectHandlers.delete(fn)
}

export function openMeshStream(stream, connectId) {
  if (!meshConnect || !stream || !connectId) return
  meshConnect.openStreaming(stream, { connectId })
}

export function closeMeshStream(stream, connectId) {
  if (!meshConnect || !stream) return
  try { meshConnect.closeStreaming(stream, { connectId: null }) } catch {}
}

export function onMeshStream(fn) {
  meshCtx.onStream = fn
}

const reactionOverlay = new Map()

export function reactionKey(kind, targetId, from) {
  return "rx:" + kind + ":" + String(targetId) + ":" + String(from || "").toLowerCase()
}

export function reactionId(kind, targetId, from) {
  return reactionKey(kind, targetId, from)
}

export function ingestReaction(id, value, action) {
  if (action === "removed") {
    reactionOverlay.delete(id)
    if (value) {
      const kind = value.kind || value.type
      const target = value.targetId || value.postId
      if (kind && target && value.from) reactionOverlay.delete(reactionKey(kind, target, value.from))
    }
    return
  }
  if (!value) return
  const kind = value.kind || value.type
  if (kind !== "like" && kind !== "heart") return
  const target = String(value.targetId || value.postId || "")
  const from = value.from
  if (!target || !from) return
  const key = reactionKey(kind, target, from)
  reactionOverlay.set(key, {
    kind,
    type: kind,
    targetId: target,
    targetType: value.targetType || "post",
    from,
    createdAt: value.createdAt || Date.now(),
    id: key
  })
}

export function listReactions(kind, targetId) {
  const id = String(targetId || "")
  const rows = []
  for (const item of reactionOverlay.values()) {
    if (item.kind === kind && String(item.targetId) === id) rows.push(item)
  }
  rows.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
  return rows
}

export function countReactions(kind, targetId) {
  return listReactions(kind, targetId).length
}

export function hasReaction(kind, targetId, from) {
  return reactionOverlay.has(reactionKey(kind, targetId, from))
}

function mergeProfileMemory(id, value) {
  if (!value) return
  const type = value.type
  if (type === "avatar") {
    const address = String((value.address || String(id || "").replace(/^avatar:/, ""))).toLowerCase()
    if (!address) return
    const photo = value.data
      ? { mime: value.mime || "image/jpeg", data: value.data }
      : value.avatar
    if (photo && (photo.data || typeof photo === "string")) meshAvatars.set(address, photo)
    const profiles = meshCtx.profiles
    if (!profiles) return
    const prev = profiles.get(address) || { address }
    prev.avatar = photo || prev.avatar
    profiles.set(address, prev)
    return
  }
  if (type !== "profile") return
  const address = String((value.address || String(id || "").replace(/^profile:/, ""))).toLowerCase()
  if (!address) return
  const profiles = meshCtx.profiles
  const photo = readAvatar(value) ? value.avatar : meshAvatars.get(address)
  if (photo) meshAvatars.set(address, photo)
  if (!profiles) return
  const prev = profiles.get(address) || {}
  const next = { ...prev, ...value, address: value.address || prev.address || address }
  if (photo) next.avatar = photo
  else if (prev.avatar) next.avatar = prev.avatar
  profiles.set(address, next)
}

async function applyRemotePut(id, value) {
  if (!value) return
  const db = meshCtx.db
  if (id && db && db.__put) {
    try {
      const { result } = await db.get(id)
      const local = result && result.value
      const localTs = local && (local.updatedAt || local.createdAt || 0)
      const remoteTs = value.updatedAt || value.createdAt || 0
      if (local && localTs > remoteTs) {
        if (value.type === "avatar") mergeProfileMemory(id, value)
        meshEmit()
        return
      }
    } catch {}
    remoteDepth++
    try {
      await db.__put(value, id)
    } catch {
      try {
        await db.__put(value)
      } catch {}
    } finally {
      remoteDepth--
    }
  }
  mergeProfileMemory(id, value)
  liveSet(id, value)
  ingestReaction(id, value)
  if (value && value.type === "dm") ingestDm(id, value)
  meshEmit()
}

async function collectNodes(db, type) {
  try {
    const out = await db.map({ query: { type } })
    const rows = (out && out.results) || []
    return rows.filter((row) => row && row.id && row.value).map((row) => ({ id: row.id, value: row.value }))
  } catch {
    return []
  }
}

async function dumpTo(db, connectId) {
  const types = ["profile", "avatar", "username", "friend", "post", "like", "heart", "comment", "follow", "notice", "thread", "dm"]
  for (const type of types) {
    const items = await collectNodes(db, type)
    for (let i = 0; i < items.length; i += 4) {
      meshSend({ kind: "snapshot", items: items.slice(i, i + 4) }, connectId)
    }
  }
  const rx = [...reactionOverlay.entries()].map(([id, value]) => ({ id, value }))
  for (let i = 0; i < rx.length; i += 8) {
    meshSend({ kind: "snapshot", items: rx.slice(i, i + 8) }, connectId)
  }
  for (const [id, value] of dmOverlay) {
    meshSend({ kind: "dm", id, value }, connectId)
  }
}

function meshHello(connectId) {
  const db = meshCtx.db
  const me = (db && db.sm && db.sm.getActiveEthAddress()) || (isScpApp() && localStorage.getItem("peerya.scp.address"))
  if (!me) return
  const profile = meshCtx.profiles && meshCtx.profiles.get(me.toLowerCase())
  meshSend({
    kind: "hello",
    address: me,
    username: (profile && profile.username) || localStorage.getItem("peerya.username") || ""
  }, connectId)
}

function ensureMesh(db, extra) {
  if (extra) {
    if (extra.online) meshCtx.online = extra.online
    if (extra.mark) meshCtx.mark = extra.mark
    if (extra.drop) meshCtx.drop = extra.drop
    if (extra.notify) meshCtx.notify = extra.notify
  }
  if (db) meshCtx.db = wrapDb(db)
  if (meshReady) return meshReady
  const graph = meshCtx.db
  if (!graph) return Promise.resolve(null)
  meshReady = Promise.all([
    import("https://cdn.jsdelivr.net/npm/webconnect/dist/esm/webconnect.js"),
    meshIceServers()
  ]).then(([{ default: webconnect }, iceServers]) => {
    const OrigPC = window.RTCPeerConnection
    if (OrigPC && !OrigPC.__peeryaIce) {
      const Wrapped = function (config) {
        const next = Object.assign({}, config || {}, {
          iceServers: [].concat((config && config.iceServers) || [], iceServers)
        })
        return Reflect.construct(OrigPC, [next], new.target || OrigPC)
      }
      Wrapped.prototype = OrigPC.prototype
      Wrapped.__peeryaIce = true
      Object.setPrototypeOf(Wrapped, OrigPC)
      window.RTCPeerConnection = Wrapped
    }
    const connect = webconnect({
      appName: MESH_APP,
      channelName: MESH_CHANNEL,
      iceConfiguration: { iceServers },
      nostrRelays: MESH_NOSTR,
      mqttBrokers: MESH_MQTT,
      torrentTrackers: MESH_TRACKERS
    })
    meshConnect = connect
    connect.onConnect(async (attr) => {
      meshHello(attr.connectId)
      await dumpTo(graph, attr.connectId)
    })
    connect.onDisconnect((attr) => {
      const address = meshPeerUser.get(attr.connectId)
      meshPeerUser.delete(attr.connectId)
      if (address && meshUserPeer.get(address) === attr.connectId) meshUserPeer.delete(address)
      if (address && meshCtx.drop) meshCtx.drop(address)
      meshCtx.disconnectHandlers.forEach((fn) => {
        try { fn(attr, address) } catch {}
      })
    })
    connect.onStreaming((stream, attr) => {
      if (meshCtx.onStream) meshCtx.onStream(stream, attr)
    })
    connect.onReceive(async (data, attr) => {
      let msg = data
      if (typeof data === "string") {
        try { msg = JSON.parse(data) } catch { return }
      }
      if (!msg || typeof msg !== "object") return
      if (msg.kind === "hello" && msg.address) {
        const address = String(msg.address).toLowerCase()
        meshPeerUser.set(attr.connectId, address)
        meshUserPeer.set(address, attr.connectId)
        if (meshCtx.mark) meshCtx.mark(msg.address, attr.connectId)
      } else if (String(msg.kind || "").indexOf("call-") === 0) {
        meshCtx.callHandlers.forEach((fn) => {
          try { fn(msg, attr) } catch {}
        })
      } else if (msg.kind === "dm" && msg.value) {
        ingestDm(msg.id || ("dm:" + Date.now()), msg.value)
        meshEmit()
      } else if (msg.kind === "reaction" && msg.value) {
        ingestReaction(msg.id, msg.value)
        await applyRemotePut(msg.id, msg.value)
      } else if (msg.kind === "reaction-remove" && msg.id) {
        ingestReaction(msg.id, null, "removed")
        liveRemove(msg.id)
        if (graph.__remove) {
          remoteDepth++
          try { await graph.__remove(msg.id) } catch {}
          remoteDepth--
        }
        meshEmit()
      } else if (msg.kind === "put") {
        await applyRemotePut(msg.id, msg.value)
      } else if (msg.kind === "remove" && msg.id && graph.__remove) {
        remoteDepth++
        try { await graph.__remove(msg.id) } catch {}
        remoteDepth--
        liveRemove(msg.id)
        meshEmit()
      } else if (msg.kind === "snapshot" && Array.isArray(msg.items)) {
        for (const item of msg.items) await applyRemotePut(item.id, item.value)
      } else if (msg.kind === "need-sync") {
        await dumpTo(graph, attr.connectId)
      }
    })
    meshHello(null)
    return connect
  })
  return meshReady
}

function gdbOptions() {
  return {
    rtc: true,
    sm: {
      superAdmins: [BOOTSTRAP_ADMIN],
      acls: true,
      resume: true,
      customRoles: {
        superadmin: { can: ["assignRole", "deleteAny"], inherits: ["admin"] },
        admin: { can: ["delete"], inherits: ["manager"] },
        manager: { can: ["publish"], inherits: ["user"] },
        user: { can: ["write", "link", "sync"], inherits: ["guest"] },
        guest: { can: ["read", "write", "link", "sync"] }
      }
    }
  }
}

function deleteDb(name) {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.deleteDatabase(name)
      req.onsuccess = () => resolve()
      req.onerror = () => resolve()
      req.onblocked = () => setTimeout(resolve, 400)
    } catch {
      resolve()
    }
  })
}

async function resetPeeryaStorage() {
  try {
    if (indexedDB.databases) {
      const dbs = await indexedDB.databases()
      const names = (dbs || []).map((row) => row && row.name).filter((name) => /peerya|genos|gdb/i.test(String(name || "")))
      await Promise.all((names.length ? names : [PEERYA.dbName]).map(deleteDb))
    } else {
      await deleteDb(PEERYA.dbName)
    }
  } catch {
    await deleteDb(PEERYA.dbName)
  }
}

function isStaleIdb(err) {
  return /state cached in an interface object|state had changed since it was read from disk/i.test(String((err && err.message) || err || ""))
}

async function openGdb() {
  const { gdb } = await import("https://cdn.jsdelivr.net/npm/genosdb@0.36.3/dist/index.js")
  try {
    return wrapDb(await gdb(PEERYA.dbName, gdbOptions()))
  } catch (err) {
    if (!isStaleIdb(err)) throw err
    await resetPeeryaStorage()
    await new Promise((resolve) => setTimeout(resolve, 300))
    return wrapDb(await gdb(PEERYA.dbName, gdbOptions()))
  }
}

export function openDb() {
  if (!dbPromise) {
    dbPromise = openGdb().catch((err) => {
      dbPromise = null
      throw err
    })
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
  const incoming = fields && fields.avatar
  const photo = incoming && (incoming.url || incoming.data)
    ? incoming
    : (prev.avatar && (prev.avatar.url || prev.avatar.data) ? prev.avatar : null)
  if (photo && (photo.url || photo.data)) {
    if (prev.avatar && prev.avatar.key && photo.key && prev.avatar.key !== photo.key) dropMedia(prev.avatar)
    value.avatar = photo.url
      ? { url: photo.url, key: photo.key || "", mime: photo.mime || "image/jpeg", name: photo.name || "" }
      : photo
    value.hasAvatar = true
    await db.put({
      type: "avatar",
      address,
      mime: value.avatar.mime || "image/jpeg",
      url: value.avatar.url || "",
      key: value.avatar.key || "",
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

export function isScpApp() {
  if (window.__PEERYA_SCP_APP__ === true) return true
  return /\/scp\.html$/i.test(location.pathname)
}

export async function waitScpApp() {
  return isScpApp()
}

export async function claimSuperadmin(db) {
  const me = String((db && db.sm && db.sm.getActiveEthAddress()) || "").toLowerCase()
  if (!me || !db.sm.isSecurityActive()) throw new Error("Device PIN is required.")
  if (!isScpApp()) throw new Error("Superadmin is only available on the control panel.")
  try {
    const out = await db.map({ query: { type: "scp-admin" } })
    const rows = (out && out.results) || []
    for (const row of rows) {
      const addr = String((row.value && row.value.address) || "").toLowerCase()
      if (row.id && addr !== me) {
        try { await db.remove(row.id) } catch {}
      }
    }
  } catch {}
  try { await db.sm.assignRole(me, "superadmin") } catch {}
  try {
    await db.put({ type: "scp-admin", address: me, role: "superadmin", updatedAt: Date.now() }, "scp-admin:" + me)
  } catch {}
  localStorage.setItem("peerya.scp.address", me)
  return me
}

export function goHome() {
  if (isScpApp()) return
  const hash = location.hash || ""
  if (sessionStorage.getItem("peerya.invite")) {
    window.location.replace(new URL("friends/", ROOT).href + hash)
    return
  }
  window.location.replace(PEERYA.home + hash)
}

export async function bootAdmin(db) {
  if (db) ensureMesh(db)
  const run = async () => {
      const { startSuperadmin } = await import("./admin.js?v=r2lim1")
    await startSuperadmin(db)
  }
  await run()
  if (!window.__peeryaAdminHash) {
    window.__peeryaAdminHash = true
    window.addEventListener("hashchange", run)
  }
}

export function goLogin() {
  window.location.replace(PEERYA.login)
}

export async function requireAuth() {
  const invite = new URLSearchParams(location.search).get("invite")
  if (invite) sessionStorage.setItem("peerya.invite", invite)
  const db = await openDb()
  if (db.sm.isSecurityActive()) {
    ensureMesh(db)
    return db
  }
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
  if (typeof photo === "string" && (photo.indexOf("data:") === 0 || photo.indexOf("http") === 0)) return photo
  if (photo && photo.url) return photo.url
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
  meshCtx.profiles = profiles
  meshCtx.profileChange = onChange
  ensureMesh(db)
  for (const [address, photo] of meshAvatars) {
    const prev = profiles.get(address) || { address }
    prev.avatar = photo
    profiles.set(address, prev)
  }
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
      const photo = readAvatar(value) ? value.avatar : (prev.avatar || meshAvatars.get(address) || null)
      if (photo) {
        next.avatar = photo
        meshAvatars.set(address, photo)
      } else delete next.avatar
      profiles.set(address, next)
    }
    emit()
  })
  db.map({ query: { type: "avatar" }, realtime: true }, ({ id, value, action }) => {
    const address = keyOf(id, value, /^avatar:/)
    if (!address) return
    const prev = profiles.get(address) || { address }
    if (action === "removed") delete prev.avatar
    else if (value && (value.url || value.data || (value.avatar && (value.avatar.url || value.avatar.data)))) {
      prev.avatar = value.url
        ? { mime: value.mime || "image/jpeg", url: value.url, key: value.key || "" }
        : value.data
          ? { mime: value.mime || "image/jpeg", data: value.data }
          : value.avatar
      meshAvatars.set(address, prev.avatar)
    }
    profiles.set(address, prev)
    emit()
  })
}

const dmOverlay = new Map()

function persistDms() {
  try {
    localStorage.setItem("peerya.dms", JSON.stringify([...dmOverlay.values()].slice(-800)))
  } catch {}
}

export function hydrateDms() {
  try {
    const rows = JSON.parse(localStorage.getItem("peerya.dms") || "[]")
    if (!Array.isArray(rows)) return
    for (const row of rows) {
      if (!row) continue
      const id = row.id || ("dm:" + (row.threadId || "") + ":" + (row.createdAt || "") + ":" + String(row.from || "").toLowerCase())
      ingestDm(id, row)
    }
  } catch {}
}

export function ingestDm(id, value, action) {
  if (action === "removed") {
    dmOverlay.delete(id)
    const map = meshCtx.liveMaps.get("dm")
    if (map) map.delete(id)
    persistDms()
    return
  }
  if (!value) return
  const prev = dmOverlay.get(id) || {}
  const next = {
    ...prev,
    ...value,
    id,
    text: value.text || prev.text || ""
  }
  dmOverlay.set(id, next)
  const map = meshCtx.liveMaps.get("dm")
  if (map) map.set(id, next)
  persistDms()
}

export async function sendDm(db, to, text) {
  const from = db.sm.getActiveEthAddress()
  const body = (text || "").trim()
  if (!from || !to || !body) return null
  const threadId = threadIdFor(from, to)
  const createdAt = Date.now()
  const id = "dm:" + threadId + ":" + createdAt + ":" + from.toLowerCase()
  const value = { type: "dm", threadId, from, to, createdAt, text: body }
  ingestDm(id, value)
  meshSend({ kind: "dm", id, value })
  meshEmit()
  let smId = ""
  try {
    smId = await db.sm.put({ type: "dm", threadId, from, to, createdAt, text: body })
    try { await db.sm.acls.grant(smId, to, "read") } catch {}
  } catch {}
  try {
    await db.put({
      type: "dm",
      threadId,
      from,
      to,
      createdAt,
      smId,
      text: body
    }, id)
  } catch {}
  const pair = [from.toLowerCase(), to.toLowerCase()].sort()
  try {
    await db.put({
      type: "thread",
      threadId,
      a: pair[0],
      b: pair[1],
      lastAt: createdAt,
      lastFrom: from
    }, "thread:" + threadId)
  } catch {}
  try { await createNotice(db, { kind: "dm", from, to, text: body }) } catch {}
  return { smId, threadId, createdAt, id }
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
  const diff = Math.max(0, Date.now() - ms)
  const sec = Math.floor(diff / 1000)
  if (sec < 15) return "just now"
  if (sec < 60) return sec + " secs ago"
  const min = Math.floor(sec / 60)
  if (min === 1) return "1 min ago"
  if (min < 60) return min + " mins ago"
  const hr = Math.floor(min / 60)
  if (hr === 1) return "1 hour ago"
  if (hr < 24) return hr + " hours ago"
  const day = Math.floor(hr / 24)
  if (day === 1) return "Yesterday"
  if (day < 7) return day + " days ago"
  return new Date(ms).toLocaleDateString()
}

export function startPresence(db, onChange) {
  const TTL = 35000
  const online = new Map()
  const lastSeen = new Map()
  const peerToUser = new Map()
  const scpMe = isScpApp() ? String(localStorage.getItem("peerya.scp.address") || "").toLowerCase() : ""
  if (!db || !db.sm) {
    const notify = () => { if (onChange) onChange() }
    const mark = (address, peerId) => {
      const key = String(address).toLowerCase()
      online.set(key, peerId || online.get(key) || "peer")
      lastSeen.set(key, Date.now())
      notify()
    }
    if (scpMe) mark(scpMe, "self")
    if (db) ensureMesh(db, { online, mark, notify })
    return { online, stop() {} }
  }
  const me = db.sm.getActiveEthAddress() || scpMe
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
  ensureMesh(db, { online, mark, drop, notify })
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

export function mediaSrc(file) {
  if (!file) return ""
  if (typeof file === "string") return file
  return file.url || file.data || ""
}

export async function storeMedia(file, folder) {
  const { uploadMedia } = await import("./r2.js")
  return uploadMedia(file, folder)
}

export async function dropMedia(item) {
  const key = item && (item.key || (typeof item === "string" ? item : ""))
  if (!key || String(key).indexOf("http") === 0) return
  try {
    const { r2Delete } = await import("./r2.js")
    await r2Delete(key)
  } catch {}
}

export async function publishPost(db, caption, images) {
  const author = db.sm.getActiveEthAddress()
  const text = (caption || "").trim()
  const pics = (images || []).filter((image) => image && (image.url || image.data)).slice(0, MAX_POST_IMAGES)
  if (!author || (!text && !pics.length)) return null
  return db.put({
    type: "post",
    author,
    caption: text,
    images: pics.filter((image) => image.url).map((image) => ({
      url: image.url,
      key: image.key || "",
      mime: image.mime || "",
      name: image.name || ""
    })),
    createdAt: Date.now()
  })
}

export async function updatePost(db, postId, caption) {
  const me = db.sm.getActiveEthAddress()
  if (!me || !postId) return null
  const { result } = await db.get(postId)
  const prev = result && result.value
  if (!prev || String(prev.author).toLowerCase() !== me.toLowerCase()) return null
  return db.put({ ...prev, caption: String(caption || "").trim(), updatedAt: Date.now() }, postId)
}

export async function removePost(db, postId) {
  const me = db.sm.getActiveEthAddress()
  if (!me || !postId) return false
  const { result } = await db.get(postId)
  const prev = result && result.value
  if (!prev || String(prev.author).toLowerCase() !== me.toLowerCase()) return false
  for (const image of prev.images || []) await dropMedia(image)
  await db.remove(postId)
  return true
}

export async function reportContent(db, { targetType, targetId, about, reason, text }) {
  const from = db.sm.getActiveEthAddress()
  if (!from || !targetId) return null
  const kind = targetType || "post"
  const id = "report:" + kind + ":" + targetId + ":" + from.toLowerCase()
  const { result } = await db.get(id)
  if (result) return id
  return db.put({
    type: "report",
    targetType: kind,
    targetId,
    about: about || "",
    from,
    reason: reason || "other",
    text: String(text || "").slice(0, 280),
    createdAt: Date.now(),
    status: "open"
  }, id)
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

export async function toggleReaction(db, kind, targetId, targetType) {
  const from = db.sm.getActiveEthAddress()
  const type = targetType || "post"
  const target = String(targetId || "")
  if (!from || !target || (kind !== "like" && kind !== "heart")) return false
  const id = reactionKey(kind, target, from)
  if (reactionOverlay.has(id)) {
    reactionOverlay.delete(id)
    meshSend({ kind: "reaction-remove", id })
    meshEmit()
    try { await db.remove(id) } catch {}
    return false
  }
  const value = {
    type: kind,
    kind,
    postId: target,
    targetId: target,
    targetType: type,
    from,
    createdAt: Date.now()
  }
  try {
    const { result: node } = await db.get(target)
    const doc = node && node.value
    if (doc) {
      if (type === "comment" && doc.postId) value.postId = doc.postId
      if (doc.author) value.to = doc.author
    }
  } catch {}
  ingestReaction(id, value)
  meshSend({ kind: "reaction", id, value })
  meshEmit()
  try { await db.put(value, id) } catch {}
  if (value.to) {
    try { await createNotice(db, { kind, from, to: value.to, postId: value.postId }) } catch {}
  }
  return true
}

export async function toggleLike(db, targetId, targetType) {
  return toggleReaction(db, "like", targetId, targetType)
}

export async function toggleHeart(db, targetId, targetType) {
  return toggleReaction(db, "heart", targetId, targetType)
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
