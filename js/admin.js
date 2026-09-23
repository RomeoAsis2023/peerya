import { startPresence, attachProfiles, avatarUrl, displayName, isScpApp } from "./peerya.js"
import { loadR2Keys, saveR2Keys, clearR2Keys, r2List, r2Put, r2Delete, publicUrl, R2_CORS } from "./r2.js"

const SESSION = "peerya.scp"
const TTL = 4 * 60 * 60 * 1000
const LOGO = new URL("../logo_full.svg", import.meta.url).href

function loadCss() {
  if (document.getElementById("scp-css")) return
  const link = document.createElement("link")
  link.id = "scp-css"
  link.rel = "stylesheet"
  link.href = new URL("../css/admin.css?v=peers1", import.meta.url).href
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
  { id: "peers", label: "Live Peer Connections", icon: "bi-wifi" },
  { id: "users", label: "All Users", icon: "bi-people-fill" },
  { id: "flags", label: "Flags", icon: "bi-flag-fill" },
  { id: "genosdb", label: "GenosDB", icon: "bi-database-fill" },
  { id: "storages", label: "Storages", icon: "bi-cloud-arrow-up-fill" },
  { id: "advertisers", label: "Advertisers", icon: "bi-megaphone-fill" },
  { id: "stores", label: "Stores", icon: "bi-shop" },
  { id: "livestreams", label: "Livestreams", icon: "bi-broadcast" },
  { id: "settings", label: "Settings", icon: "bi-gear-fill" }
]

const GDB_TYPES = ["profile", "username", "avatar", "post", "like", "heart", "comment", "friend", "follow", "notice", "thread", "dm", "report"]
const GDB_PAGE = 25

function comingSoon(title) {
  return "<h2>" + title + "</h2><p class=\"scp-empty\">Nothing here yet.</p>"
}

function withTimeout(promise, ms, fallback) {
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve(fallback), ms))
  ])
}

async function counts(db) {
  const tally = { users: 0, posts: 0, friends: 0, notices: 0 }
  if (!db || !db.map) return tally
  const types = [
    ["profile", "users"],
    ["post", "posts"],
    ["friend", "friends"],
    ["notice", "notices"]
  ]
  for (const [type, key] of types) {
    try {
      const out = await withTimeout(db.map({ query: { type } }), 5000, { results: [] })
      tally[key] = ((out && out.results) || []).length
    } catch {}
  }
  return tally
}

function esc(value) {
  return String(value || "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[ch]))
}

function normName(username) {
  return String(username || "").trim().toLowerCase()
}

function profileUrl(profile) {
  const name = normName(profile && profile.username)
  if (!name) return ""
  return new URL("p/" + encodeURIComponent(name), new URL("../", import.meta.url)).href
}

async function nameTaken(db, username, exceptAddress) {
  const name = normName(username)
  if (!name) return false
  try {
    const { result } = await db.get("username:" + name)
    const owner = result && result.value && result.value.address
    if (!owner) return false
    return owner.toLowerCase() !== String(exceptAddress || "").toLowerCase()
  } catch {
    return false
  }
}

async function listReports(db) {
  try {
    const out = await withTimeout(db.map({ query: { type: "report" } }), 8000, { results: [] })
    return ((out && out.results) || []).map((row) => ({ id: row.id, ...(row.value || {}) }))
  } catch {
    return []
  }
}

function renderFlags(rows, tab) {
  const filtered = rows.filter((row) => (row.targetType || "post") === tab)
  if (!filtered.length) return "<h2>Flags</h2><p class=\"scp-empty\">No " + tab + " reports.</p>"
  const body = filtered.map((row) => {
    const when = row.createdAt ? new Date(row.createdAt).toLocaleString() : "—"
    return (
      "<tr data-id=\"" + esc(row.id) + "\">" +
      "<td>" + esc(row.targetId || "—") + "</td>" +
      "<td>" + esc(row.reason || "other") + "</td>" +
      "<td>" + esc(row.text || "") + "</td>" +
      "<td>" + esc(String(row.from || "").slice(0, 10)) + "</td>" +
      "<td>" + esc(row.status || "open") + "</td>" +
      "<td>" + esc(when) + "</td>" +
      "<td class=\"scp-actions\">" +
      "<button type=\"button\" class=\"scp-act\" data-act=\"dismiss\">Dismiss</button>" +
      (tab === "post" ? "<button type=\"button\" class=\"scp-act danger\" data-act=\"remove-post\">Remove post</button>" : "") +
      "</td></tr>"
    )
  }).join("")
  return (
    "<h2>Flags</h2><div class=\"scp-flag-tabs\">" +
    "<button type=\"button\" class=\"scp-act" + (tab === "post" ? " on" : "") + "\" data-tab=\"post\">Posts</button>" +
    "<button type=\"button\" class=\"scp-act" + (tab === "user" ? " on" : "") + "\" data-tab=\"user\">Users</button>" +
    "</div><div class=\"gdb-scroll\"><table class=\"scp-table\"><thead><tr><th>Target</th><th>Reason</th><th>Details</th><th>From</th><th>Status</th><th>When</th><th>Actions</th></tr></thead><tbody>" +
    body + "</tbody></table></div>"
  )
}

function bindFlagActions(main, db, rows, paint) {
  const byId = new Map(rows.map((row) => [row.id, row]))
  main.querySelectorAll("[data-tab]").forEach((btn) => {
    btn.addEventListener("click", () => {
      main.dataset.flagTab = btn.dataset.tab
      paint()
    })
  })
  main.querySelectorAll("[data-act]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const row = btn.closest("tr")
      const item = byId.get(row && row.dataset.id)
      if (!item) return
      if (btn.dataset.act === "dismiss") {
        try { await db.put({ ...item, status: "dismissed" }, item.id) } catch {}
      }
      if (btn.dataset.act === "remove-post" && item.targetId) {
        try { await db.remove(item.targetId) } catch {}
        try { await db.put({ ...item, status: "removed" }, item.id) } catch {}
      }
      await paint()
    })
  })
}

async function listProfiles(db) {
  try {
    const out = await withTimeout(db.map({ query: { type: "profile" } }), 8000, { results: [] })
    return ((out && out.results) || []).map((row) => {
      const value = row.value || {}
      const address = String(value.address || String(row.id || "").replace(/^profile:/, "")).toLowerCase()
      return { ...value, address }
    }).filter((row) => row.address)
  } catch {
    return []
  }
}

function renderDash(tally) {
  const admin = String(localStorage.getItem("peerya.scp.address") || "")
  const who = admin ? "<p class=\"scp-empty\">Superadmin " + esc(admin.slice(0, 6) + "…" + admin.slice(-4)) + "</p>" : ""
  return (
    "<h2>Dashboard</h2>" + who + "<div class=\"scp-grid\">" +
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
    const href = profileUrl(p)
    const url = href
      ? "<a class=\"scp-url\" href=\"" + esc(href) + "\" target=\"_blank\" rel=\"noopener\">" + esc(href) + "</a>"
      : "—"
    return (
      "<tr data-addr=\"" + esc(addr) + "\">" +
      "<td>@" + esc(p.username || "—") + "</td>" +
      "<td>" + esc(name) + "</td>" +
      "<td>" + esc(short) + "</td>" +
      "<td>" + url + "</td>" +
      "<td class=\"scp-actions\">" +
      "<button type=\"button\" class=\"scp-act\" data-act=\"edit\">Edit</button>" +
      "<button type=\"button\" class=\"scp-act danger\" data-act=\"delete\">Delete</button>" +
      "</td></tr>"
    )
  }).join("")
  return "<h2>All Users</h2><table class=\"scp-table\"><thead><tr><th>Username</th><th>Name</th><th>Address</th><th>Profile URL</th><th>Actions</th></tr></thead><tbody>" + rows + "</tbody></table>"
}

function closeModal() {
  const el = document.getElementById("scp-modal")
  if (el) el.remove()
}

function openModal(html) {
  closeModal()
  const el = document.createElement("div")
  el.id = "scp-modal"
  el.className = "scp-gate"
  el.innerHTML = html
  document.body.append(el)
  return el
}

async function saveUser(db, address, fields) {
  const key = "profile:" + address
  const { result } = await db.get(key)
  const prev = (result && result.value) || {}
  const name = normName(fields.username || prev.username)
  if (!name) throw new Error("username required")
  const oldName = normName(prev.username)
  if (await nameTaken(db, name, address)) throw new Error("username taken")
  if (oldName && oldName !== name) {
    try { await db.remove("username:" + oldName) } catch {}
  }
  await db.put({ type: "username", username: name, address }, "username:" + name)
  await db.put({
    ...prev,
    type: "profile",
    username: name,
    address,
    firstName: String(fields.firstName || "").trim(),
    lastName: String(fields.lastName || "").trim(),
    email: String(fields.email || "").trim(),
    birthday: fields.birthday || "",
    gender: fields.gender || "",
    about: String(fields.about || "").trim(),
    updatedAt: Date.now(),
    createdAt: prev.createdAt || Date.now()
  }, key)
}

async function deleteUser(db, profile) {
  const address = String(profile.address || "").toLowerCase()
  const name = normName(profile.username)
  if (name) try { await db.remove("username:" + name) } catch {}
  try { await db.remove("avatar:" + address) } catch {}
  await db.remove("profile:" + address)
}

function openEdit(db, profile, paint) {
  const el = openModal(
    "<form class=\"scp-card scp-edit\">" +
    "<h1>Edit user</h1>" +
    "<p>Update this profile, then save.</p>" +
    "<label for=\"scp-username\">Username</label>" +
    "<input id=\"scp-username\" value=\"" + esc(profile.username || "") + "\" required>" +
    "<div class=\"scp-edit-row\">" +
    "<div><label for=\"scp-first\">First name</label><input id=\"scp-first\" value=\"" + esc(profile.firstName || "") + "\"></div>" +
    "<div><label for=\"scp-last\">Last name</label><input id=\"scp-last\" value=\"" + esc(profile.lastName || "") + "\"></div>" +
    "</div>" +
    "<label for=\"scp-email\">Email</label>" +
    "<input id=\"scp-email\" type=\"email\" value=\"" + esc(typeof profile.email === "string" && !String(profile.email).startsWith("{") ? profile.email : "") + "\">" +
    "<div class=\"scp-edit-row\">" +
    "<div><label for=\"scp-bday\">Birthday</label><input id=\"scp-bday\" type=\"date\" value=\"" + esc(profile.birthday || "") + "\"></div>" +
    "<div><label for=\"scp-gender\">Gender</label><select id=\"scp-gender\">" +
    "<option value=\"\">Select</option>" +
    "<option value=\"male\">Male</option>" +
    "<option value=\"female\">Female</option>" +
    "<option value=\"lgbt+\">LGBT+</option>" +
    "</select></div></div>" +
    "<label for=\"scp-about\">About</label>" +
    "<textarea id=\"scp-about\" maxlength=\"500\">" + esc(profile.about || "") + "</textarea>" +
    "<p class=\"scp-err\" id=\"scp-edit-err\"></p>" +
    "<div class=\"scp-edit-actions\">" +
    "<button type=\"button\" class=\"scp-act\" id=\"scp-edit-cancel\">Cancel</button>" +
    "<button type=\"submit\" class=\"btn\">Save</button>" +
    "</div></form>"
  )
  const gender = el.querySelector("#scp-gender")
  if (profile.gender) gender.value = profile.gender
  el.querySelector("#scp-edit-cancel").addEventListener("click", closeModal)
  el.querySelector("form").addEventListener("submit", async (event) => {
    event.preventDefault()
    const err = el.querySelector("#scp-edit-err")
    err.textContent = ""
    try {
      await saveUser(db, profile.address, {
        username: el.querySelector("#scp-username").value,
        firstName: el.querySelector("#scp-first").value,
        lastName: el.querySelector("#scp-last").value,
        email: el.querySelector("#scp-email").value,
        birthday: el.querySelector("#scp-bday").value,
        gender: el.querySelector("#scp-gender").value,
        about: el.querySelector("#scp-about").value
      })
      closeModal()
      await paint()
    } catch (e) {
      err.textContent = e && e.message === "username taken" ? "Username is taken." : "Could not save."
    }
  })
}

function openDelete(db, profile, paint) {
  const handle = "@" + (profile.username || "user")
  const el = openModal(
    "<form class=\"scp-card scp-edit\">" +
    "<h1>Delete user</h1>" +
    "<p>Remove " + esc(handle) + " and their profile records.</p>" +
    "<p class=\"scp-err\" id=\"scp-del-err\"></p>" +
    "<div class=\"scp-edit-actions\">" +
    "<button type=\"button\" class=\"scp-act\" id=\"scp-del-cancel\">Cancel</button>" +
    "<button type=\"submit\" class=\"btn scp-del\">Delete</button>" +
    "</div></form>"
  )
  el.querySelector("#scp-del-cancel").addEventListener("click", closeModal)
  el.querySelector("form").addEventListener("submit", async (event) => {
    event.preventDefault()
    const err = el.querySelector("#scp-del-err")
    err.textContent = ""
    try {
      await deleteUser(db, profile)
      closeModal()
      await paint()
    } catch {
      err.textContent = "Could not delete."
    }
  })
}

function cellText(value) {
  if (value == null || value === "") return "—"
  let text = value
  if (typeof value === "object") {
    try { text = JSON.stringify(value) } catch { return "[object]" }
  }
  text = String(text)
  if (text.indexOf("data:image") === 0 || text.length > 80) return text.slice(0, 48) + "…"
  return text
}

function rowHay(row) {
  try {
    return (row.id + " " + JSON.stringify(row)).toLowerCase()
  } catch {
    return String(row.id || "").toLowerCase()
  }
}

async function loadGdbTable(db, type) {
  try {
    const out = await withTimeout(db.map({ query: { type } }), 8000, { results: [] })
    return ((out && out.results) || []).map((row) => {
      const value = row.value || {}
      return { id: row.id, ...value }
    })
  } catch {
    return []
  }
}

async function loadGdbAll(db) {
  const cache = {}
  await Promise.all(GDB_TYPES.map(async (type) => {
    cache[type] = await loadGdbTable(db, type)
  }))
  return cache
}

function gdbColumns(rows) {
  const keys = new Set(["id", "type"])
  rows.forEach((row) => Object.keys(row).forEach((key) => {
    if (key !== "data") keys.add(key)
  }))
  return [...keys]
}

function renderGenos(main, db, state, paint) {
  const table = state.table
  const all = state.cache[table] || []
  const q = String(state.q || "").trim().toLowerCase()
  const filtered = q ? all.filter((row) => rowHay(row).includes(q)) : all
  const pages = Math.max(1, Math.ceil(filtered.length / GDB_PAGE))
  if (state.page > pages) state.page = pages
  const slice = filtered.slice((state.page - 1) * GDB_PAGE, state.page * GDB_PAGE)
  const cols = gdbColumns(slice.length ? slice : all.slice(0, 1))
  main.innerHTML =
    "<h2>GenosDB</h2><div class=\"gdb-wrap\">" +
    "<aside class=\"gdb-tables\"></aside>" +
    "<div class=\"gdb-browse\">" +
    "<div class=\"gdb-toolbar\">" +
    "<strong></strong><span class=\"gdb-count\"></span>" +
    "<input type=\"search\" class=\"gdb-search\" placeholder=\"Search this table\">" +
    "<button type=\"button\" class=\"scp-act\" id=\"gdb-sync\"><i class=\"bi bi-arrow-repeat\"></i> Sync</button>" +
    "</div>" +
    "<div class=\"gdb-scroll\"><table class=\"scp-table gdb-grid\"><thead></thead><tbody></tbody></table></div>" +
    "<div class=\"gdb-pager\"></div>" +
    "</div></div>"
  main.querySelector(".gdb-toolbar strong").textContent = table
  main.querySelector(".gdb-count").textContent = filtered.length + " / " + all.length + " rows"
  const list = main.querySelector(".gdb-tables")
  GDB_TYPES.forEach((type) => {
    const btn = document.createElement("button")
    btn.type = "button"
    btn.className = "gdb-table" + (type === table ? " on" : "")
    btn.innerHTML = "<span></span><em></em>"
    btn.querySelector("span").textContent = type
    btn.querySelector("em").textContent = String((state.cache[type] || []).length)
    btn.addEventListener("click", () => {
      state.table = type
      state.page = 1
      paint()
    })
    list.append(btn)
  })
  const search = main.querySelector(".gdb-search")
  search.value = state.q
  search.addEventListener("input", () => {
    state.q = search.value
    state.page = 1
    const pos = search.selectionStart
    Promise.resolve(paint()).then(() => {
      const next = document.querySelector(".gdb-search")
      if (!next) return
      next.focus()
      try { next.setSelectionRange(pos, pos) } catch {}
    })
  })
  main.querySelector("#gdb-sync").addEventListener("click", async () => {
    state.cache = await loadGdbAll(db)
    paint()
  })
  const thead = main.querySelector("thead")
  const head = document.createElement("tr")
  cols.forEach((col) => {
    const th = document.createElement("th")
    th.textContent = col
    head.append(th)
  })
  thead.append(head)
  const tbody = main.querySelector("tbody")
  if (!slice.length) {
    const empty = document.createElement("tr")
    empty.innerHTML = "<td colspan=\"" + cols.length + "\" class=\"scp-empty\">No rows.</td>"
    tbody.append(empty)
  } else {
    slice.forEach((row) => {
      const tr = document.createElement("tr")
      cols.forEach((col) => {
        const td = document.createElement("td")
        td.textContent = col === "id" ? row.id : cellText(row[col])
        tr.append(td)
      })
      tr.addEventListener("click", () => {
        openModal(
          "<div class=\"scp-card scp-edit\"><h1>" + esc(row.id) + "</h1>" +
          "<pre class=\"gdb-json\"></pre>" +
          "<div class=\"scp-edit-actions\"><button type=\"button\" class=\"scp-act\" id=\"scp-edit-cancel\">Close</button></div></div>"
        )
        const pre = document.querySelector(".gdb-json")
        try { pre.textContent = JSON.stringify(row, null, 2) } catch { pre.textContent = String(row.id) }
        document.getElementById("scp-edit-cancel").addEventListener("click", closeModal)
      })
      tbody.append(tr)
    })
  }
  const pager = main.querySelector(".gdb-pager")
  const prev = document.createElement("button")
  prev.type = "button"
  prev.className = "scp-act"
  prev.textContent = "Prev"
  prev.disabled = state.page <= 1
  prev.addEventListener("click", () => { state.page -= 1; paint() })
  const label = document.createElement("span")
  label.textContent = "Page " + state.page + " of " + pages
  const next = document.createElement("button")
  next.type = "button"
  next.className = "scp-act"
  next.textContent = "Next"
  next.disabled = state.page >= pages
  next.addEventListener("click", () => { state.page += 1; paint() })
  pager.append(prev, label, next)
}

function renderLivePeers(main, db, profiles, presence) {
  const keys = [...(presence && presence.online ? presence.online.keys() : [])]
  main.innerHTML =
    "<div class=\"scp-peer-hero\"><p>Live Peer Connections</p><strong></strong><span>connected now</span></div>" +
    "<div class=\"scp-peer-grid\"></div>"
  main.querySelector("strong").textContent = String(keys.length)
  const grid = main.querySelector(".scp-peer-grid")
  if (!keys.length) {
    const empty = document.createElement("p")
    empty.className = "scp-empty"
    empty.textContent = "No peers connected right now."
    grid.append(empty)
    return
  }
  keys.forEach((addr) => {
    const profile = profiles.get(addr)
    const card = document.createElement("div")
    card.className = "scp-peer-card"
    card.innerHTML = '<span class="avatar-wrap"><img class="avatar" alt=""><span class="presence online"></span></span><p class="suggest-name"></p><p class="suggest-handle"></p>'
    card.querySelector("img").src = avatarUrl(addr, profiles)
    card.querySelector(".suggest-name").textContent = displayName(db, profiles, addr)
    card.querySelector(".suggest-handle").textContent = (profile && profile.username) ? "@" + profile.username : String(addr).slice(0, 10) + "…"
    grid.append(card)
  })
}

function formatSize(bytes) {
  const n = Number(bytes) || 0
  if (n < 1024) return n + " B"
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB"
  return (n / (1024 * 1024)).toFixed(1) + " MB"
}

function renderStorages(main, paint) {
  const keys = loadR2Keys()
  main.innerHTML = "<h2>Storages</h2><p class=\"scp-empty\">Cloudflare R2 · peeryar2storage · pyr.antserver1.eu.org</p><div id=\"r2-box\"></div>"
  const box = main.querySelector("#r2-box")
  if (!keys) {
    box.innerHTML =
      "<form class=\"scp-card scp-edit\" id=\"r2-form\">" +
      "<h1>Connect R2</h1><p>Keys stay in this app only. They are not saved in the Peerya site.</p>" +
      "<label>Access Key ID</label><input id=\"r2-id\" autocomplete=\"off\">" +
      "<label>Secret Access Key</label><input id=\"r2-secret\" type=\"password\" autocomplete=\"off\">" +
      "<p class=\"scp-err\" id=\"r2-err\"></p>" +
      "<button type=\"submit\" class=\"btn\">Save keys</button></form>"
    box.querySelector("form").addEventListener("submit", (event) => {
      event.preventDefault()
      const id = box.querySelector("#r2-id").value.trim()
      const secret = box.querySelector("#r2-secret").value.trim()
      if (!id || !secret) {
        box.querySelector("#r2-err").textContent = "Both keys are required."
        return
      }
      saveR2Keys(id, secret)
      paint()
    })
    return
  }
  box.innerHTML =
    "<div class=\"gdb-toolbar\">" +
    "<button type=\"button\" class=\"scp-act\" id=\"r2-refresh\">Refresh</button>" +
    "<label class=\"scp-act\" id=\"r2-upload-lab\">Upload<input type=\"file\" id=\"r2-file\" hidden accept=\"image/*,video/*,audio/*\"></label>" +
    "<button type=\"button\" class=\"scp-act danger\" id=\"r2-forget\">Remove keys</button>" +
    "<span class=\"gdb-count\" id=\"r2-status\"></span></div>" +
    "<div class=\"gdb-scroll\"><table class=\"scp-table\"><thead><tr><th>File</th><th>Size</th><th>Public URL</th><th></th></tr></thead><tbody id=\"r2-rows\"></tbody></table></div>"
  const status = box.querySelector("#r2-status")
  const tbody = box.querySelector("#r2-rows")
  const draw = async () => {
    status.textContent = "Loading…"
    tbody.innerHTML = ""
    try {
      const rows = await r2List()
      status.textContent = rows.length + " objects"
      if (!rows.length) {
        tbody.innerHTML = "<tr><td colspan=\"4\" class=\"scp-empty\">Empty bucket.</td></tr>"
        return
      }
      rows.forEach((row) => {
        const tr = document.createElement("tr")
        const href = publicUrl(row.key)
        tr.innerHTML =
          "<td></td><td></td><td><a class=\"scp-url\" target=\"_blank\" rel=\"noopener\"></a></td>" +
          "<td class=\"scp-actions\"><button type=\"button\" class=\"scp-act danger\">Delete</button></td>"
        tr.children[0].textContent = row.key
        tr.children[1].textContent = formatSize(row.size)
        const a = tr.querySelector("a")
        a.href = href
        a.textContent = href
        tr.querySelector("button").addEventListener("click", async () => {
          if (!confirm("Delete " + row.key + "?")) return
          try {
            await r2Delete(row.key)
            await draw()
          } catch (err) {
            status.textContent = String(err.message || err)
          }
        })
        tbody.append(tr)
      })
    } catch (err) {
      status.textContent = String(err.message || err)
    }
  }
  box.querySelector("#r2-refresh").addEventListener("click", draw)
  box.querySelector("#r2-forget").addEventListener("click", () => {
    clearR2Keys()
    paint()
  })
  box.querySelector("#r2-file").addEventListener("change", async (event) => {
    const file = event.target.files && event.target.files[0]
    event.target.value = ""
    if (!file) return
    status.textContent = "Uploading…"
    try {
      await r2Put(file)
      await draw()
    } catch (err) {
      status.textContent = String(err.message || err)
    }
  })
  draw()
}

function bindUserActions(main, db, people, paint) {
  const byAddr = new Map(people.map((p) => [String(p.address || "").toLowerCase(), p]))
  main.querySelectorAll("[data-act]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const row = btn.closest("tr")
      const profile = byAddr.get(String((row && row.dataset.addr) || "").toLowerCase())
      if (!profile) return
      if (btn.dataset.act === "edit") openEdit(db, profile, paint)
      if (btn.dataset.act === "delete") openDelete(db, profile, paint)
    })
  })
}

export async function startSuperadmin(db) {
  if (!isScpApp()) return
  if (document.getElementById("scp-root")) {
    if (db && typeof window.__peeryaAdminAttach === "function") window.__peeryaAdminAttach(db)
    return
  }
  let gate
  try {
    gate = await import("./admin-gate.js")
  } catch {
    return
  }
  if (!gate.ADMIN_GATE_READY || !gate.ADMIN_PASS_HASH || !gate.ADMIN_KEY_HASH) return
  if (!db || !db.sm || !(db.sm.isSecurityActive() || db.sm.getActiveEthAddress())) return

  loadCss()

  const grantScpRole = async () => {}

  const unlock = async () => {
    setNoindex(true)
    const root = document.createElement("div")
    root.id = "scp-root"
    root.className = "scp-root"
    root.innerHTML =
      "<aside class=\"scp-side\"><a class=\"scp-brand\" href=\"#\"><img alt=\"Peerya\"><span>Superadmin</span></a><nav><ul class=\"scp-nav\"></ul></nav></aside><section class=\"scp-main\" id=\"scp-main\"><h2>Dashboard</h2><p class=\"scp-empty\">Connecting to peers and GenosDB…</p></section>"
    root.querySelector(".scp-brand img").src = LOGO
    const nav = root.querySelector(".scp-nav")
    document.body.append(root)
    document.body.style.overflow = "hidden"
    const oldGate = document.getElementById("scp-gate")
    if (oldGate) oldGate.remove()

    let liveDb = db
    let page = "dashboard"
    const profiles = new Map()
    let paint = () => {}
    let presence = { online: new Map(), stop() {} }
    const attachDb = (next) => {
      liveDb = next || liveDb
      if (!liveDb) return
      try { presence = startPresence(liveDb, () => paint()) || presence } catch {}
      try { attachProfiles(liveDb, profiles, () => paint()) } catch {}
      grantScpRole(liveDb).catch(() => {})
      paint()
    }
    window.__peeryaAdminAttach = attachDb
    const gdbState = { table: "profile", q: "", page: 1, cache: {} }
    paint = async () => {
      nav.querySelectorAll("button").forEach((btn) => btn.classList.toggle("on", btn.dataset.id === page))
      const main = document.getElementById("scp-main")
      if (!main) return
      try {
        if (!liveDb) {
          main.innerHTML = "<h2>Dashboard</h2><p class=\"scp-empty\">Connecting to peers and GenosDB…</p>"
          return
        }
        if (page === "dashboard") main.innerHTML = renderDash(await counts(liveDb))
        else if (page === "peers") renderLivePeers(main, liveDb, profiles, presence)
        else if (page === "users") {
          const people = await listProfiles(liveDb)
          main.innerHTML = renderUsers(people)
          bindUserActions(main, liveDb, people, paint)
        } else if (page === "flags") {
          const rows = await listReports(liveDb)
          const tab = main.dataset.flagTab || "post"
          main.innerHTML = renderFlags(rows, tab)
          main.dataset.flagTab = tab
          bindFlagActions(main, liveDb, rows, paint)
        } else if (page === "genosdb") {
          if (!Object.keys(gdbState.cache).length) gdbState.cache = await loadGdbAll(liveDb)
          renderGenos(main, liveDb, gdbState, paint)
        } else if (page === "storages") renderStorages(main, paint)
        else if (page === "advertisers") main.innerHTML = comingSoon("Advertisers")
        else if (page === "stores") main.innerHTML = comingSoon("Stores")
        else if (page === "livestreams") main.innerHTML = comingSoon("Livestreams")
        else if (page === "settings") main.innerHTML = comingSoon("Settings")
      } catch (err) {
        main.innerHTML = "<h2>Dashboard</h2><p class=\"scp-empty\">" + esc(err && err.message || "Could not load this page.") + "</p>"
      }
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
      closeModal()
      clearSession()
      setNoindex(false)
      document.body.style.overflow = ""
      root.remove()
      history.replaceState({}, "", location.pathname + location.search)
    })
    nav.append(quit)
    if (liveDb) attachDb(liveDb)
    else paint()
  }

  if (sessionOk() || isScpApp()) {
    await unlock()
    return
  }

  if (document.getElementById("scp-gate")) return

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
