import { ADMIN_PHRASE_HASH } from "./admin-gate.js"

const STORE = "peerya.scp.address"

function ethersApi() {
  return import("https://cdn.jsdelivr.net/npm/ethers@6.13.5/+esm")
}

export function normalizeMnemonic(raw) {
  return String(raw || "").toLowerCase().replace(/[^a-z]+/g, " ").trim()
}

export function boundAdmin() {
  return String(localStorage.getItem(STORE) || "").toLowerCase()
}

export function bindAdmin(address) {
  const addr = String(address || "").toLowerCase()
  if (!addr) return
  localStorage.setItem(STORE, addr)
  localStorage.setItem("peerya.address", addr)
}

async function sha256hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("")
}

export async function addressFromPhrase(mnemonic) {
  const phrase = normalizeMnemonic(mnemonic)
  const words = phrase ? phrase.split(" ") : []
  if (words.length !== 12 && words.length !== 24) throw new Error("Use 12 or 24 words.")
  const { HDNodeWallet } = await ethersApi()
  const wallet = HDNodeWallet.fromPhrase(phrase)
  return String(wallet.address).toLowerCase()
}

export function canCreateSuperadmin() {
  return !ADMIN_PHRASE_HASH && !boundAdmin()
}

export async function createSuperadmin() {
  if (!canCreateSuperadmin()) throw new Error("Superadmin phrase is already set.")
  const { HDNodeWallet } = await ethersApi()
  const wallet = HDNodeWallet.createRandom()
  return {
    address: String(wallet.address).toLowerCase(),
    mnemonic: wallet.mnemonic.phrase
  }
}

export function confirmSuperadmin(address) {
  bindAdmin(address)
  return boundAdmin()
}

export async function unlockWithPhrase(mnemonic) {
  const phrase = normalizeMnemonic(mnemonic)
  const address = await addressFromPhrase(phrase)
  if (ADMIN_PHRASE_HASH) {
    const hex = await sha256hex(phrase)
    if (hex !== ADMIN_PHRASE_HASH) throw new Error("This phrase is not Superadmin.")
  } else {
    const bound = boundAdmin()
    if (bound && bound !== address) throw new Error("This phrase is not the Superadmin identity on this app.")
  }
  bindAdmin(address)
  return address
}
