const fs = require("fs")
const path = require("path")
const crypto = require("crypto")

function sha256(value) {
  return crypto.createHash("sha256").update(String(value), "utf8").digest("hex")
}

function normalizeKey(value) {
  return String(value || "").trim().replace(/^\//, "").replace(/^#/, "")
}

const pass = process.env.JUNIEADMIN_PASSCODE || ""
const key = normalizeKey(process.env.PEERYA_ADMIN_KEY || "")
const ready = Boolean(pass && key)
const out = [
  "export const ADMIN_PASS_HASH = \"" + (pass ? sha256(pass) : "") + "\"",
  "export const ADMIN_KEY_HASH = \"" + (key ? sha256(key) : "") + "\"",
  "export const ADMIN_GATE_READY = " + (ready ? "true" : "false"),
  ""
].join("\n")

fs.writeFileSync(path.join("js", "admin-gate.js"), out)
process.stdout.write("admin-gate ready=" + ready + "\n")
