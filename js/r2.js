const R2_ENDPOINT = "https://927ac929eb08673cea54d7f1888fd640.r2.cloudflarestorage.com"
const R2_BUCKET = "peeryar2storage"
export const R2_PUBLIC = "https://pyr.antserver1.eu.org"
const R2_STORE = "peerya.r2"

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

async function aws() {
  const keys = loadR2Keys()
  if (!keys) throw new Error("missing keys")
  const { AwsClient } = await import("https://cdn.jsdelivr.net/npm/aws4fetch@1.0.20/+esm")
  return new AwsClient({
    accessKeyId: keys.accessKeyId,
    secretAccessKey: keys.secretAccessKey,
    service: "s3",
    region: "auto"
  })
}

function objectUrl(key) {
  const path = String(key || "").split("/").map(encodeURIComponent).join("/")
  return R2_ENDPOINT + "/" + R2_BUCKET + "/" + path
}

export async function r2List() {
  const client = await aws()
  const res = await client.fetch(R2_ENDPOINT + "/" + R2_BUCKET + "?list-type=2")
  const xml = await res.text()
  if (!res.ok) throw new Error((xml || String(res.status)).slice(0, 180))
  const rows = []
  String(xml).split("<Contents>").slice(1).forEach((block) => {
    const key = (block.match(/<Key>([^<]+)<\/Key>/) || [])[1]
    const size = (block.match(/<Size>([^<]+)<\/Size>/) || [])[1]
    const modified = (block.match(/<LastModified>([^<]+)<\/LastModified>/) || [])[1]
    if (key) rows.push({ key, size: Number(size || 0), modified: modified || "" })
  })
  return rows
}

export async function r2Put(file) {
  const client = await aws()
  const safe = String(file.name || "file").replace(/[^\w.\-]+/g, "_")
  const key = "media/" + Date.now() + "-" + safe
  const res = await client.fetch(objectUrl(key), {
    method: "PUT",
    body: file,
    headers: { "Content-Type": file.type || "application/octet-stream" }
  })
  if (!res.ok) throw new Error((await res.text() || String(res.status)).slice(0, 180))
  return { key, url: publicUrl(key) }
}

export async function r2Delete(key) {
  const client = await aws()
  const res = await client.fetch(objectUrl(key), { method: "DELETE" })
  if (!res.ok && res.status !== 204) throw new Error((await res.text() || String(res.status)).slice(0, 180))
}
