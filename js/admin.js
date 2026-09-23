import { startPresence, attachProfiles, avatarUrl, displayName, isScpApp, dropMedia, listProfileFields } from "./peerya.js"
import { loadR2Keys, saveR2Keys, clearR2Keys, r2List, r2Put, r2Delete, publicUrl, R2_CORS, R2_UPLOAD_LIMIT } from "./r2.js"

const SESSION = "peerya.scp"
const TTL = 4 * 60 * 60 * 1000
const LOGO = new URL("../logo_full.svg", import.meta.url).href

function loadCss() {
  if (document.getElementById("scp-css")) return
  const link = document.createElement("link")
  link.id = "scp-css"
  link.rel = "stylesheet"
  link.href = new URL("../css/admin.css?v=fields2", import.meta.url).href
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
  { id: "fields", label: "Profile fields", icon: "bi-ui-checks-grid" },
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

const FLAG_PAGE = 8
const FLAG_REASONS = ["spam", "harassment", "nudity", "violence", "scam", "other"]
const FLAG_STATUSES = ["open", "reviewed", "dismissed", "removed"]

function reportValue(item, patch) {
  const prev = item || {}
  const next = { ...prev, ...(patch || {}) }
  delete next.id
  return {
    type: "report",
    targetType: next.targetType || "post",
    targetId: next.targetId || "",
    about: next.about || "",
    from: next.from || "",
    reason: next.reason || "other",
    text: String(next.text || "").slice(0, 280),
    createdAt: next.createdAt || Date.now(),
    updatedAt: Date.now(),
    status: next.status || "open"
  }
}

async function saveReport(db, item, patch) {
  const value = reportValue(item, patch)
  const id = (item && item.id) || ("report:" + value.targetType + ":" + value.targetId + ":" + String(value.from || "scp").toLowerCase())
  if (!value.targetId) throw new Error("Target is required.")
  await db.put(value, id)
  return id
}

async function removeFlagTarget(db, item) {
  const id = String(item.targetId || "")
  if (!id) return
  if ((item.targetType || "post") !== "user") {
    try {
      const { result } = await db.get(id)
      const pics = result && result.value && result.value.images
      for (const image of pics || []) await dropMedia(image)
    } catch {}
  }
  if ((item.targetType || "post") === "user") {
    const address = id.replace(/^profile:/, "").toLowerCase()
    let profile = { address }
    try {
      const { result } = await db.get("profile:" + address)
      if (result && result.value) profile = { ...result.value, address }
    } catch {}
    await deleteUser(db, profile)
    return
  }
  await db.remove(id)
}

function renderFlags(main, db, rows, state, paint) {
  const tab = state.tab || "all"
  const status = state.status || "all"
  const q = String(state.q || "").trim().toLowerCase()
  const typed = rows.filter((row) => tab === "all" || (row.targetType || "post") === tab)
  const filtered = typed.filter((row) => {
    if (status !== "all" && (row.status || "open") !== status) return false
    if (!q) return true
    return [row.targetId, row.reason, row.text, row.from, row.about, row.status].join(" ").toLowerCase().includes(q)
  })
  const pages = Math.max(1, Math.ceil(filtered.length / FLAG_PAGE))
  if (state.page > pages) state.page = pages
  if (state.page < 1) state.page = 1
  const slice = filtered.slice((state.page - 1) * FLAG_PAGE, state.page * FLAG_PAGE)
  const count = (name) => rows.filter((row) => name === "all" || (row.targetType || "post") === name).length
  main.innerHTML =
    "<div class=\"flag-head\"><div><h2>Flags</h2><p class=\"scp-empty\">Review reports. Changes save to GenosDB.</p></div>" +
    "<button type=\"button\" class=\"scp-act on\" id=\"flag-new\">New flag</button></div>" +
    "<div class=\"scp-flag-tabs\"></div>" +
    "<div class=\"gdb-toolbar flag-tools\">" +
    "<input type=\"search\" class=\"gdb-search\" id=\"flag-q\" placeholder=\"Search target, reason, details\">" +
    "<select id=\"flag-status\" class=\"flag-select\"></select>" +
    "<span class=\"gdb-count\" id=\"flag-count\"></span></div>" +
    "<p class=\"scp-err\" id=\"flag-err\"></p>" +
    "<div class=\"gdb-scroll\"><table class=\"scp-table flag-table\"><thead><tr><th>Type</th><th>Target</th><th>Reason</th><th>Details</th><th>From</th><th>Status</th><th>When</th><th>Actions</th></tr></thead><tbody></tbody></table></div>" +
    "<div class=\"gdb-pager\"></div>"
  const tabs = main.querySelector(".scp-flag-tabs")
  ;[["all", "All"], ["post", "Posts"], ["user", "Users"]].forEach(([id, label]) => {
    const btn = document.createElement("button")
    btn.type = "button"
    btn.className = "scp-act" + (tab === id ? " on" : "")
    btn.textContent = label + " " + count(id)
    btn.addEventListener("click", () => { state.tab = id; state.page = 1; paint() })
    tabs.append(btn)
  })
  const select = main.querySelector("#flag-status")
  ;[["all", "All statuses"]].concat(FLAG_STATUSES.map((item) => [item, item])).forEach(([id, label]) => {
    const opt = document.createElement("option")
    opt.value = id
    opt.textContent = label
    if (id === status) opt.selected = true
    select.append(opt)
  })
  select.addEventListener("change", () => { state.status = select.value; state.page = 1; paint() })
  const search = main.querySelector("#flag-q")
  search.value = state.q
  search.addEventListener("input", () => {
    state.q = search.value
    state.page = 1
    const pos = search.selectionStart
    Promise.resolve(paint()).then(() => {
      const next = document.getElementById("flag-q")
      if (!next) return
      next.focus()
      try { next.setSelectionRange(pos, pos) } catch {}
    })
  })
  main.querySelector("#flag-count").textContent = filtered.length + " / " + rows.length
  const tbody = main.querySelector("tbody")
  const err = main.querySelector("#flag-err")
  if (!slice.length) {
    tbody.innerHTML = "<tr><td colspan=\"8\" class=\"scp-empty\">No flags match this filter.</td></tr>"
  }
  slice.forEach((item) => {
    const tr = document.createElement("tr")
    const when = item.createdAt ? new Date(item.createdAt).toLocaleString() : "—"
    const kind = item.targetType || "post"
    tr.innerHTML =
      "<td></td><td class=\"flag-target\"></td><td></td><td class=\"flag-details\"></td><td></td><td><span class=\"flag-status\"></span></td><td></td>" +
      "<td class=\"scp-actions\"></td>"
    tr.children[0].textContent = kind
    tr.children[1].textContent = item.targetId || "—"
    tr.children[2].textContent = item.reason || "other"
    tr.children[3].textContent = item.text || item.about || "—"
    tr.children[4].textContent = String(item.from || "—").slice(0, 10)
    const pill = tr.querySelector(".flag-status")
    pill.textContent = item.status || "open"
    pill.dataset.status = item.status || "open"
    tr.children[6].textContent = when
    const actions = tr.querySelector(".scp-actions")
    const add = (label, act, danger) => {
      const btn = document.createElement("button")
      btn.type = "button"
      btn.className = "scp-act" + (danger ? " danger" : "")
      btn.textContent = label
      btn.addEventListener("click", () => runFlag(act))
      actions.append(btn)
    }
    const runFlag = async (act) => {
      err.textContent = ""
      try {
        if (act === "edit") return openFlagEditor(db, item, paint)
        if (act === "dismiss") await saveReport(db, item, { status: "dismissed" })
        if (act === "reopen") await saveReport(db, item, { status: "open" })
        if (act === "remove-target") {
          await removeFlagTarget(db, item)
          await saveReport(db, item, { status: "removed" })
        }
        if (act === "delete") await db.remove(item.id)
        await paint()
      } catch (e) {
        err.textContent = String((e && e.message) || "Could not update that flag.")
      }
    }
    add("Edit", "edit")
    if ((item.status || "open") !== "dismissed") add("Dismiss", "dismiss")
    if ((item.status || "open") !== "open") add("Reopen", "reopen")
    add(kind === "user" ? "Remove user" : "Remove post", "remove-target", true)
    add("Delete", "delete", true)
    tbody.append(tr)
  })
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
  main.querySelector("#flag-new").addEventListener("click", () => openFlagEditor(db, null, paint))
}

function openFlagEditor(db, item, paint) {
  const creating = !item
  const el = openModal(
    "<form class=\"scp-card scp-edit\">" +
    "<h1>" + (creating ? "New flag" : "Edit flag") + "</h1>" +
    "<p>" + (creating ? "Create a report in GenosDB." : "Update this report.") + "</p>" +
    "<div class=\"scp-edit-row\">" +
    "<div><label for=\"flag-type\">Type</label><select id=\"flag-type\"><option value=\"post\">Post</option><option value=\"user\">User</option></select></div>" +
    "<div><label for=\"flag-reason\">Reason</label><select id=\"flag-reason\"></select></div>" +
    "</div>" +
    "<label for=\"flag-target\">Target id or address</label><input id=\"flag-target\" required>" +
    "<label for=\"flag-text\">Details</label><textarea id=\"flag-text\" maxlength=\"280\"></textarea>" +
    "<label for=\"flag-edit-status\">Status</label><select id=\"flag-edit-status\"></select>" +
    "<p class=\"scp-err\" id=\"flag-edit-err\"></p>" +
    "<div class=\"scp-edit-actions\">" +
    "<button type=\"button\" class=\"scp-act\" id=\"flag-cancel\">Cancel</button>" +
    "<button type=\"submit\" class=\"btn\">Save</button></div></form>"
  )
  const type = el.querySelector("#flag-type")
  const reason = el.querySelector("#flag-reason")
  const status = el.querySelector("#flag-edit-status")
  FLAG_REASONS.forEach((name) => {
    const opt = document.createElement("option")
    opt.value = name
    opt.textContent = name
    reason.append(opt)
  })
  FLAG_STATUSES.forEach((name) => {
    const opt = document.createElement("option")
    opt.value = name
    opt.textContent = name
    status.append(opt)
  })
  if (item) {
    type.value = item.targetType || "post"
    reason.value = item.reason || "other"
    status.value = item.status || "open"
    el.querySelector("#flag-target").value = item.targetId || ""
    el.querySelector("#flag-text").value = item.text || ""
  }
  el.querySelector("#flag-cancel").addEventListener("click", closeModal)
  el.querySelector("form").addEventListener("submit", async (event) => {
    event.preventDefault()
    const err = el.querySelector("#flag-edit-err")
    err.textContent = ""
    try {
      await saveReport(db, item, {
        targetType: type.value,
        targetId: el.querySelector("#flag-target").value.trim(),
        reason: reason.value,
        text: el.querySelector("#flag-text").value.trim(),
        status: status.value,
        from: (item && item.from) || localStorage.getItem("peerya.scp.address") || "scp"
      })
      closeModal()
      await paint()
    } catch (e) {
      err.textContent = String((e && e.message) || "Could not save.")
    }
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
  if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + " MB"
  return (n / (1024 * 1024 * 1024)).toFixed(2) + " GB"
}

function renderStorages(main, paint, db) {
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
    box.querySelector("form").addEventListener("submit", async (event) => {
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
    "<div class=\"scp-grid r2-stats\">" +
    "<div class=\"scp-stat\"><span>Files in R2</span><strong id=\"r2-count\">—</strong></div>" +
    "<div class=\"scp-stat\"><span>Total size</span><strong id=\"r2-size\">—</strong></div>" +
    "<div class=\"scp-stat\"><span>Cloudflare file limit</span><strong id=\"r2-limit\">—</strong></div>" +
    "<div class=\"scp-stat\"><span>Remaining for one file</span><strong id=\"r2-left\">—</strong></div>" +
    "</div>" +
    "<div class=\"r2-meter\"><span id=\"r2-bar\"></span></div>" +
    "<p class=\"scp-empty\" id=\"r2-meter-label\">Limit updates from the files in this bucket.</p>" +
    "<div class=\"gdb-toolbar\">" +
    "<button type=\"button\" class=\"scp-act\" id=\"r2-refresh\">Refresh</button>" +
    "<label class=\"scp-act\" id=\"r2-upload-lab\">Upload<input type=\"file\" id=\"r2-file\" hidden accept=\"image/*,video/*,audio/*\"></label>" +
    "<button type=\"button\" class=\"scp-act danger\" id=\"r2-forget\">Remove keys</button>" +
    "<span class=\"gdb-count\" id=\"r2-status\"></span></div>" +
    "<div class=\"gdb-scroll\"><table class=\"scp-table\"><thead><tr><th>File already in bucket</th><th>Size</th><th>Public URL</th><th></th></tr></thead><tbody id=\"r2-rows\"></tbody></table></div>"
  const status = box.querySelector("#r2-status")
  const tbody = box.querySelector("#r2-rows")
  const draw = async () => {
    status.textContent = "Loading bucket…"
    box.querySelector("#r2-count").textContent = "…"
    box.querySelector("#r2-size").textContent = "…"
    box.querySelector("#r2-limit").textContent = formatSize(R2_UPLOAD_LIMIT)
    box.querySelector("#r2-left").textContent = "…"
    tbody.innerHTML = ""
    try {
      const rows = await r2List()
      const total = rows.reduce((sum, row) => sum + (Number(row.size) || 0), 0)
      const largest = rows.reduce((max, row) => Math.max(max, Number(row.size) || 0), 0)
      const left = Math.max(0, R2_UPLOAD_LIMIT - largest)
      const usedPct = Math.min(100, (largest / R2_UPLOAD_LIMIT) * 100)
      box.querySelector("#r2-count").textContent = String(rows.length)
      box.querySelector("#r2-size").textContent = formatSize(total)
      box.querySelector("#r2-limit").textContent = formatSize(R2_UPLOAD_LIMIT)
      box.querySelector("#r2-left").textContent = formatSize(left)
      box.querySelector("#r2-bar").style.width = usedPct.toFixed(1) + "%"
      box.querySelector("#r2-meter-label").textContent =
        "Largest file is " + usedPct.toFixed(1) + "% of the " + formatSize(R2_UPLOAD_LIMIT) + " single-upload limit. Recalculated from the bucket."
      status.textContent = rows.length + " files · " + formatSize(total)
      if (!rows.length) {
        tbody.innerHTML = "<tr><td colspan=\"4\" class=\"scp-empty\">No files in this bucket yet.</td></tr>"
        return
      }
      rows.forEach((row) => {
        const tr = document.createElement("tr")
        const href = publicUrl(row.key)
        tr.innerHTML =
          "<td></td><td></td><td><a class=\"scp-url\" target=\"_blank\" rel=\"noopener\"></a></td>" +
          "<td class=\"scp-actions\"><button type=\"button\" class=\"scp-act danger\">Delete</button></td>"
        tr.children[0].textContent = row.key
        const pct = ((Number(row.size) || 0) / R2_UPLOAD_LIMIT) * 100
        tr.children[1].textContent = formatSize(row.size) + " · " + pct.toFixed(1) + "%"
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
    if (file.size > R2_UPLOAD_LIMIT) {
      status.textContent = "File is over the Cloudflare single-upload limit of " + formatSize(R2_UPLOAD_LIMIT) + "."
      return
    }
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

const FIELD_TYPES = ["text", "radio", "checkbox", "textarea", "wysiwyg"]

function slugField(label) {
  return String(label || "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 40)
}

async function renderProfileFields(main, db, paint) {
  const rows = await listProfileFields(db)
  main.innerHTML =
    "<div class=\"field-page\"><div class=\"flag-head\"><div><h2>Profile fields</h2><p class=\"scp-empty\">These fields appear on Settings and public profiles.</p></div>" +
    "<button type=\"button\" class=\"scp-act on\" id=\"field-new\">Add field</button></div>" +
    "<p class=\"scp-err\" id=\"field-err\"></p>" +
    "<div class=\"gdb-scroll\"><table class=\"scp-table\"><thead><tr><th>Label</th><th>Key</th><th>Type</th><th>Required</th><th></th></tr></thead><tbody></tbody></table></div></div>"
  const tbody = main.querySelector("tbody")
  const err = main.querySelector("#field-err")
  if (!rows.length) tbody.innerHTML = "<tr><td colspan=\"5\" class=\"scp-empty\">No extra fields yet.</td></tr>"
  rows.forEach((field) => {
    const tr = document.createElement("tr")
    tr.innerHTML = "<td></td><td></td><td></td><td></td><td class=\"scp-actions\"></td>"
    tr.children[0].textContent = field.label
    tr.children[1].textContent = field.key
    tr.children[2].textContent = field.fieldType || "text"
    tr.children[3].textContent = field.required ? "Yes" : "No"
    const actions = tr.querySelector(".scp-actions")
    const edit = document.createElement("button")
    edit.type = "button"
    edit.className = "scp-act"
    edit.textContent = "Edit"
    edit.addEventListener("click", () => openFieldEditor(db, field, rows, paint))
    const del = document.createElement("button")
    del.type = "button"
    del.className = "scp-act danger"
    del.textContent = "Remove"
    del.addEventListener("click", async () => {
      try {
        await db.remove(field.id)
        await paint()
      } catch (e) {
        err.textContent = String((e && e.message) || "Could not remove that field.")
      }
    })
    actions.append(edit, del)
    tbody.append(tr)
  })
  main.querySelector("#field-new").addEventListener("click", () => openFieldEditor(db, null, rows, paint))
}

function openFieldEditor(db, field, rows, paint) {
  const el = openModal(
    "<form class=\"scp-card scp-edit\">" +
    "<h1>" + (field ? "Edit field" : "Add field") + "</h1>" +
    "<label class=\"form-label\" for=\"pf-label\">Label</label><input class=\"form-control\" id=\"pf-label\" required>" +
    "<label class=\"form-label\" for=\"pf-type\">Type</label><select class=\"form-select\" id=\"pf-type\"></select>" +
    "<label class=\"form-label\" for=\"pf-options\">Options</label><textarea class=\"form-control\" id=\"pf-options\" placeholder=\"One option per line. Used by radio and checkbox.\"></textarea>" +
    "<label class=\"pf-check\" for=\"pf-required\"><input type=\"checkbox\" id=\"pf-required\"> Required</label>" +
    "<p class=\"scp-err\" id=\"pf-err\"></p>" +
    "<div class=\"scp-edit-actions\"><button type=\"button\" class=\"scp-act\" id=\"pf-cancel\">Cancel</button><button type=\"submit\" class=\"btn\">Save</button></div></form>"
  )
  const type = el.querySelector("#pf-type")
  FIELD_TYPES.forEach((name) => {
    const opt = document.createElement("option")
    opt.value = name
    opt.textContent = name
    type.append(opt)
  })
  if (field) {
    el.querySelector("#pf-label").value = field.label || ""
    type.value = field.fieldType || "text"
    el.querySelector("#pf-options").value = (field.options || []).join("\n")
    el.querySelector("#pf-required").checked = !!field.required
  }
  el.querySelector("#pf-cancel").addEventListener("click", closeModal)
  el.querySelector("form").addEventListener("submit", async (event) => {
    event.preventDefault()
    const err = el.querySelector("#pf-err")
    const label = el.querySelector("#pf-label").value.trim()
    const key = field && field.key ? field.key : slugField(label)
    if (!label || !key) {
      err.textContent = "Label is required."
      return
    }
    const options = el.querySelector("#pf-options").value.split("\n").map((line) => line.trim()).filter(Boolean)
    try {
      await db.put({
        type: "profile-field",
        key,
        label,
        fieldType: type.value,
        required: el.querySelector("#pf-required").checked,
        options,
        order: field ? Number(field.order) || 0 : rows.length + 1,
        updatedAt: Date.now()
      }, field && field.id ? field.id : "profile-field:" + key)
      closeModal()
      await paint()
    } catch (e) {
      err.textContent = String((e && e.message) || "Could not save.")
    }
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
    const flagState = { tab: "all", status: "all", q: "", page: 1 }
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
          renderFlags(main, liveDb, await listReports(liveDb), flagState, paint)
        } else if (page === "genosdb") {
          if (!Object.keys(gdbState.cache).length) gdbState.cache = await loadGdbAll(liveDb)
          renderGenos(main, liveDb, gdbState, paint)
        }         else if (page === "storages") renderStorages(main, paint, liveDb)
        else if (page === "advertisers") main.innerHTML = comingSoon("Advertisers")
        else if (page === "stores") main.innerHTML = comingSoon("Stores")
        else if (page === "livestreams") main.innerHTML = comingSoon("Livestreams")
        else if (page === "fields") await renderProfileFields(main, liveDb, paint)
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
