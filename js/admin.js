const SESSION = "peerya.scp"
const TTL = 4 * 60 * 60 * 1000
const LOGO = new URL("../logo_full.svg", import.meta.url).href

function loadCss() {
  if (document.getElementById("scp-css")) return
  const link = document.createElement("link")
  link.id = "scp-css"
  link.rel = "stylesheet"
  link.href = new URL("../css/admin.css", import.meta.url).href
  document.head.append(link)
}

function setNoindex(on) {
  let tag = document.querySelector('meta[name="robots"]')
  if (!tag) {
    tag = document.createElement("meta")
    tag.name = "robots"
    document.head.append(tag)
  }
  tag.content = on ? "noindex, nofollow, noarchive" : "index, follow"
}

async function sha256hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("")
}

function hexEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false
  let x = 0
  for (let i = 0; i < a.length; i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return x === 0
}

function fragment() {
  return String(location.hash || "").replace(/^#/, "").trim()
}

function sessionOk() {
  try {
    const raw = sessionStorage.getItem(SESSION)
    if (!raw) return false
    const data = JSON.parse(raw)
    return data && Date.now() - Number(data.t || 0) < TTL
  } catch {
    return false
  }
}

function saveSession() {
  sessionStorage.setItem(SESSION, JSON.stringify({ t: Date.now() }))
}

function clearSession() {
  sessionStorage.removeItem(SESSION)
}

const MENUS = [
  { id: "dashboard", label: "Dashboard", icon: "bi-grid-fill" },
  { id: "users", label: "All Users", icon: "bi-people-fill" },
  { id: "advertisers", label: "Advertisers", icon: "bi-megaphone-fill" },
  { id: "stores", label: "Stores", icon: "bi-shop" },
  { id: "livestreams", label: "Livestreams", icon: "bi-broadcast" },
  { id: "settings", label: "Settings", icon: "bi-gear-fill" }
]

function comingSoon(title) {
  return "<h2>" + title + "</h2><p class=\"scp-empty\">Nothing here yet.</p>"
}

async function counts(db) {
  const tally = { users: 0, posts: 0, friends: 0, notices: 0 }
  const types = [
    ["profile", "users"],
    ["post", "posts"],
    ["friend", "friends"],
    ["notice", "notices"]
  ]
  for (const [type, key] of types) {
    try {
      const out = await db.map({ query: { type } })
      tally[key] = ((out && out.results) || []).length
    } catch {}
  }
  return tally
}

async function listProfiles(db) {
  try {
    const out = await db.map({ query: { type: "profile" } })
    return ((out && out.results) || []).map((row) => row.value).filter(Boolean)
  } catch {
    return []
  }
}

function renderDash(tally) {
  return (
    "<h2>Dashboard</h2><div class=\"scp-grid\">" +
    [["Users", tally.users], ["Posts", tally.posts], ["Friend links", tally.friends], ["Notices", tally.notices]].map(([label, n]) =>
      "<div class=\"scp-stat\"><span>" + label + "</span><strong>" + n + "</strong></div>"
    ).join("") +
    "</div>"
  )
}

function renderUsers(people) {
  if (!people.length) return "<h2>All Users</h2><p class=\"scp-empty\">No profiles yet.</p>"
  const rows = people.map((p) => {
    const name = [p.firstName, p.lastName].filter(Boolean).join(" ") || p.username || ""
    const addr = String(p.address || "")
    const short = addr ? addr.slice(0, 6) + "…" + addr.slice(-4) : "—"
    return "<tr><td>@" + (p.username || "—") + "</td><td>" + name + "</td><td>" + short + "</td></tr>"
  }).join("")
  return "<h2>All Users</h2><table class=\"scp-table\"><thead><tr><th>Username</th><th>Name</th><th>Address</th></tr></thead><tbody>" + rows + "</tbody></table>"
}

export async function startSuperadmin(db) {
  if (document.getElementById("scp-root") || document.getElementById("scp-gate")) return
  let gate
  try {
    gate = await import("./admin-gate.js")
  } catch {
    return
  }
  if (!gate.ADMIN_GATE_READY || !gate.ADMIN_PASS_HASH || !gate.ADMIN_KEY_HASH) return
  const frag = fragment()
  if (!frag) return
  const keyHex = await sha256hex(frag)
  if (!hexEqual(keyHex, gate.ADMIN_KEY_HASH)) return
  if (!db || !db.sm || !db.sm.isSecurityActive()) return

  loadCss()

  const unlock = async () => {
    setNoindex(true)
    const root = document.createElement("div")
    root.id = "scp-root"
    root.className = "scp-root"
    root.innerHTML =
      "<aside class=\"scp-side\"><a class=\"scp-brand\" href=\"#\"><img alt=\"Peerya\"><span>Superadmin</span></a><nav><ul class=\"scp-nav\"></ul></nav></aside><section class=\"scp-main\" id=\"scp-main\"></section>"
    root.querySelector(".scp-brand img").src = LOGO
    const nav = root.querySelector(".scp-nav")
    document.body.append(root)
    document.body.style.overflow = "hidden"

    let page = "dashboard"
    const paint = async () => {
      nav.querySelectorAll("button").forEach((btn) => btn.classList.toggle("on", btn.dataset.id === page))
      const main = document.getElementById("scp-main")
      if (page === "dashboard") main.innerHTML = renderDash(await counts(db))
      else if (page === "users") main.innerHTML = renderUsers(await listProfiles(db))
      else if (page === "advertisers") main.innerHTML = comingSoon("Advertisers")
      else if (page === "stores") main.innerHTML = comingSoon("Stores")
      else if (page === "livestreams") main.innerHTML = comingSoon("Livestreams")
      else if (page === "settings") main.innerHTML = comingSoon("Settings")
    }

    MENUS.forEach((item) => {
      const btn = document.createElement("button")
      btn.type = "button"
      btn.dataset.id = item.id
      btn.innerHTML = "<i class=\"bi " + item.icon + "\"></i><span></span>"
      btn.querySelector("span").textContent = item.label
      btn.addEventListener("click", () => { page = item.id; paint() })
      nav.append(btn)
    })
    const quit = document.createElement("button")
    quit.type = "button"
    quit.className = "quit"
    quit.innerHTML = "<i class=\"bi bi-box-arrow-left\"></i><span>Quit Superadmin CP</span>"
    quit.addEventListener("click", () => {
      clearSession()
      setNoindex(false)
      document.body.style.overflow = ""
      root.remove()
      history.replaceState({}, "", location.pathname + location.search)
    })
    nav.append(quit)
    paint()
  }

  if (sessionOk()) {
    await unlock()
    return
  }

  const gateEl = document.createElement("div")
  gateEl.id = "scp-gate"
  gateEl.className = "scp-gate"
  gateEl.innerHTML =
    "<form class=\"scp-card\"><img alt=\"Peerya\"><h1>Superadmin</h1><p>Enter the passcode to continue.</p><p class=\"scp-err\" id=\"scp-err\"></p><input type=\"password\" autocomplete=\"current-password\" id=\"scp-pass\" placeholder=\"Passcode\"><button type=\"submit\" class=\"btn\">Unlock</button></form>"
  gateEl.querySelector("img").src = LOGO
  document.body.append(gateEl)
  const input = gateEl.querySelector("#scp-pass")
  input.focus()
  gateEl.querySelector("form").addEventListener("submit", async (event) => {
    event.preventDefault()
    const err = document.getElementById("scp-err")
    const hex = await sha256hex(input.value)
    if (!hexEqual(hex, gate.ADMIN_PASS_HASH)) {
      err.textContent = "Wrong passcode."
      input.value = ""
      input.focus()
      return
    }
    saveSession()
    gateEl.remove()
    await unlock()
  })
}
