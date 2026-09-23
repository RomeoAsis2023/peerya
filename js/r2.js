const R2_ENDPOINT = "https://927ac929eb08673cea54d7f1888fd640.r2.cloudflarestorage.com"
const R2_BUCKET = "peeryar2storage"
export const R2_PUBLIC = "https://pyr.antserver1.eu.org"
export const R2_UPLOAD_API = "https://peerya-upload.romeoasis2023.workers.dev"
export const R2_UPLOAD_LIMIT = (5 * 1024 * 1024 * 1024) - (5 * 1024 * 1024)
const R2_STORE = "peerya.r2"
const EMPTY_HASH = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"

export const R2_CORS = [
  {
    AllowedOrigins: [
      "https://romeoasis2023.github.io",
      "https://peerya.com",
      "https://www.peerya.com"
    ],
    AllowedMethods: ["GET", "PUT", "POST", "DELETE", "HEAD"],
    AllowedHeaders: ["*"],
    ExposeHeaders: ["ETag", "Content-Length"],
    MaxAgeSeconds: 3600
  }
]

export function loadR2Keys() {
  try {
    const raw = JSON.parse(localStorage.getItem(R2_STORE) || "null")
    if (!raw || !raw.accessKeyId || !raw.secretAccessKey) return null
    return raw
  } catch {
    return null
  }
}

export function saveR2Keys(accessKeyId, secretAccessKey) {
  localStorage.setItem(R2_STORE, JSON.stringify({
    accessKeyId: String(accessKeyId || "").trim(),
    secretAccessKey: String(secretAccessKey || "").trim()
  }))
}

export function clearR2Keys() {
  localStorage.removeItem(R2_STORE)
}

export function publicUrl(key) {
  return R2_PUBLIC + "/" + String(key || "").replace(/^\//, "")
}

function encodePath(key) {
  return String(key || "").split("/").map(encodeURIComponent).join("/")
}

function objectUrl(key) {
  return R2_ENDPOINT + "/" + R2_BUCKET + "/" + encodePath(key)
}

function toHex(bytes) {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("")
}

async function sha256hex(data) {
  const buf = typeof data === "string" ? new TextEncoder().encode(data) : data
  return toHex(await crypto.subtle.digest("SHA-256", buf))
}

async function hmac(keyBytes, str) {
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
  const data = typeof str === "string" ? new TextEncoder().encode(str) : str
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, data))
}

async function signedFetch(method, url, body, contentType) {
  const keys = loadR2Keys()
  if (!keys) throw new Error("missing keys")
  const u = new URL(url)
  const region = "auto"
  const service = "s3"
  const now = new Date()
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "")
  const dateStamp = amzDate.slice(0, 8)
  let payloadHash = EMPTY_HASH
  let payload = body
  if (body && typeof body.arrayBuffer === "function") {
    const buf = await body.arrayBuffer()
    payloadHash = await sha256hex(buf)
    payload = buf
  } else if (typeof body === "string" && body) {
    payloadHash = await sha256hex(body)
  }
  const headers = {
    host: u.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate
  }
  if (contentType) headers["content-type"] = contentType
  const names = Object.keys(headers).sort()
  const signedHeaders = names.join(";")
  const canonicalHeaders = names.map((name) => name + ":" + headers[name] + "\n").join("")
  const canonical = [method, u.pathname, u.search.replace(/^\?/, ""), canonicalHeaders, signedHeaders, payloadHash].join("\n")
  const scope = dateStamp + "/" + region + "/" + service + "/aws4_request"
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, await sha256hex(canonical)].join("\n")
  let k = await hmac(new TextEncoder().encode("AWS4" + keys.secretAccessKey), dateStamp)
  k = await hmac(k, region)
  k = await hmac(k, service)
  k = await hmac(k, "aws4_request")
  const signature = toHex(await hmac(k, stringToSign))
  headers.authorization = "AWS4-HMAC-SHA256 Credential=" + keys.accessKeyId + "/" + scope + ", SignedHeaders=" + signedHeaders + ", Signature=" + signature
  try {
    return await fetch(url, { method, headers, body: payload })
  } catch {
    throw new Error("CORS blocked. In Cloudflare → R2 → peeryar2storage → Settings → CORS, paste the JSON shown on this page.")
  }
}

function xmlValue(block, tag) {
  const raw = (String(block).match(new RegExp("<" + tag + ">([^<]*)</" + tag + ">")) || [])[1] || ""
  return raw.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#39;/g, "'")
}

function listUrl(token) {
  const params = [["list-type", "2"], ["max-keys", "1000"]]
  if (token) params.push(["continuation-token", token])
  params.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)
  const qs = params.map(([key, value]) => encodeURIComponent(key) + "=" + encodeURIComponent(value)).join("&")
  return R2_ENDPOINT + "/" + R2_BUCKET + "?" + qs
}

export async function r2List() {
  const rows = []
  let token = ""
  do {
    const res = await signedFetch("GET", listUrl(token))
    const xml = await res.text()
    if (!res.ok) throw new Error((xml || String(res.status)).slice(0, 180))
    String(xml).split("<Contents>").slice(1).forEach((block) => {
      const key = xmlValue(block, "Key")
      if (!key) return
      rows.push({
        key,
        size: Number(xmlValue(block, "Size") || 0),
        modified: xmlValue(block, "LastModified")
      })
    })
    token = /<IsTruncated>true<\/IsTruncated>/.test(xml) ? xmlValue(xml, "NextContinuationToken") : ""
  } while (token)
  return rows
}

export async function r2Put(file, key) {
  if (file && file.size > R2_UPLOAD_LIMIT) throw new Error("File is over the Cloudflare single-upload limit.")
  const safe = String((file && file.name) || "file").replace(/[^\w.\-]+/g, "_")
  const objectKey = key || ("media/" + Date.now() + "-" + safe)
  const res = await signedFetch("PUT", objectUrl(objectKey), file, (file && file.type) || "application/octet-stream")
  if (!res.ok) throw new Error((await res.text() || String(res.status)).slice(0, 180))
  return {
    key: objectKey,
    url: publicUrl(objectKey),
    mime: (file && file.type) || "application/octet-stream",
    name: (file && file.name) || safe,
    size: (file && file.size) || 0
  }
}

export async function uploadMedia(file, folder) {
  if (file && file.size > 100 * 1024 * 1024) throw new Error("File is over 100 MB.")
  const name = (file && file.name) || "file"
  const type = (file && file.type) || "application/octet-stream"
  const url = R2_UPLOAD_API + "/?folder=" + encodeURIComponent(folder || "media")
  let res
  try {
    res = await fetch(url, {
      method: "POST",
      body: file,
      headers: { "Content-Type": type, "X-File-Name": name }
    })
  } catch {
    throw new Error("Upload service is not reachable yet.")
  }
  if (!res.ok) throw new Error((await res.text() || "Upload failed") .slice(0, 180))
  const data = await res.json()
  return {
    key: data.key,
    url: data.url || publicUrl(data.key),
    mime: data.mime || type,
    name: data.name || name,
    size: data.size || (file && file.size) || 0
  }
}

export async function deleteMedia(key) {
  if (!key) return
  if (loadR2Keys()) {
    await r2Delete(key)
    return
  }
  await fetch(R2_UPLOAD_API + "/?key=" + encodeURIComponent(key), { method: "DELETE" })
}

export async function r2Delete(key) {
  const res = await signedFetch("DELETE", objectUrl(key))
  if (!res.ok && res.status !== 204) throw new Error((await res.text() || String(res.status)).slice(0, 180))
}
