export const PEERYA = {
  name: "Peerya",
  dbName: "peerya",
  home: "home.html"
}

const BOOTSTRAP_ADMIN = "0xFEE1000000000000000000000000000000000A00"

export const PASSKEYS_AVAILABLE =
  window.isSecureContext &&
  !!window.PublicKeyCredential &&
  !/^\d{1,3}(\.\d{1,3}){3}$/.test(location.hostname)

let dbPromise

export function openDb() {
  if (!dbPromise) {
    dbPromise = import("https://cdn.jsdelivr.net/npm/genosdb@0.36.3/dist/index.min.js").then(({ gdb }) =>
      gdb(PEERYA.dbName, {
        rtc: true,
        sm: {
          superAdmins: [BOOTSTRAP_ADMIN],
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

export async function saveProfile(db, { username, email }) {
  const address = db.sm.getActiveEthAddress()
  const name = (username || "").trim().toLowerCase()
  if (!address || !name) return
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
  await db.put(value, "profile:" + address)
  localStorage.setItem("peerya.username", name)
  localStorage.setItem("peerya.address", address)
}

export function goHome() {
  window.location.replace(PEERYA.home)
}

export function goLogin() {
  window.location.replace("index.html")
}

export async function requireAuth() {
  const db = await openDb()
  if (db.sm.isSecurityActive()) return db
  goLogin()
  return null
}

export async function signOut(db) {
  try {
    await db.sm.clearSecurity()
  } catch {}
  localStorage.removeItem("peerya.username")
  localStorage.removeItem("peerya.address")
  goLogin()
}
