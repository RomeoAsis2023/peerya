const PUBLIC = "https://pyr.antserver1.eu.org"
const MAX = 100 * 1024 * 1024
const ORIGINS = new Set([
  "https://romeoasis2023.github.io",
  "https://peerya.com",
  "https://www.peerya.com"
])
const FOLDERS = new Set(["posts", "avatars", "media"])

function cors(response, origin) {
  const headers = new Headers(response.headers)
  headers.set("Access-Control-Allow-Origin", ORIGINS.has(origin) ? origin : "https://romeoasis2023.github.io")
  headers.set("Access-Control-Allow-Methods", "POST, DELETE, OPTIONS")
  headers.set("Access-Control-Allow-Headers", "Content-Type, X-File-Name")
  headers.set("Access-Control-Max-Age", "86400")
  return new Response(response.body, { status: response.status, headers })
}

function folderOf(value) {
  const name = String(value || "media").replace(/[^a-z]/g, "")
  return FOLDERS.has(name) ? name : ""
}

function safeName(value) {
  return String(value || "file").replace(/[^\w.\-]+/g, "_").slice(0, 80) || "file"
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || ""
    if (request.method === "OPTIONS") return cors(new Response(null, { status: 204 }), origin)
    if (origin && !ORIGINS.has(origin)) return cors(new Response("Origin not allowed", { status: 403 }), origin)
    const url = new URL(request.url)

    if (request.method === "DELETE") {
      const key = url.searchParams.get("key") || ""
      const folder = key.split("/")[0]
      if (!FOLDERS.has(folder) || key.includes("..")) {
        return cors(new Response("Bad key", { status: 400 }), origin)
      }
      await env.BUCKET.delete(key)
      return cors(new Response(null, { status: 204 }), origin)
    }

    if (request.method !== "POST") return cors(new Response("Method not allowed", { status: 405 }), origin)
    const folder = folderOf(url.searchParams.get("folder"))
    if (!folder) return cors(new Response("Bad folder", { status: 400 }), origin)
    const size = Number(request.headers.get("Content-Length") || 0)
    if (size > MAX) return cors(new Response("File is over 100 MB", { status: 413 }), origin)
    const key = folder + "/" + Date.now() + "-" + safeName(request.headers.get("X-File-Name"))
    const type = request.headers.get("Content-Type") || "application/octet-stream"
    await env.BUCKET.put(key, request.body, { httpMetadata: { contentType: type } })
    return cors(Response.json({
      key,
      url: PUBLIC + "/" + key,
      mime: type,
      name: request.headers.get("X-File-Name") || "file",
      size
    }), origin)
  }
}
