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

export async function saveProfile(db, { username, email }) {
  const address = db.sm.getActiveEthAddress()
  const name = normalizeUsername(username)
  if (!address || !name) return
  if (await isUsernameTaken(db, name, address)) {
    throw new Error("username taken")
  }
  const value = {
    type: "profile",
    username: name,
    address,
    createdAt: Date.now()
  }
  if (email && email.trim()) {
    try {
      value.email = await db.sm.encryptDataForCurrentUser(email.trim())
    } catch {
      value.email = null
    }
  }
  await db.put({ type: "username", username: name, address }, "username:" + name)
  await db.put(value, "profile:" + address)
  localStorage.setItem("peerya.username", name)
  localStorage.setItem("peerya.address", address)
}

export function goHome() {
  window.location.replace(PEERYA.home)
}

export function goLogin() {
  window.location.replace(PEERYA.login)
}

export async function requireAuth() {
  const db = await openDb()
  if (db.sm.isSecurityActive()) return db
  goLogin()
  return null
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

export function avatarUrl(address) {
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

export async function signOut(db) {
  try {
    await db.sm.clearSecurity()
  } catch {}
  localStorage.removeItem("peerya.username")
  localStorage.removeItem("peerya.address")
  goLogin()
}
