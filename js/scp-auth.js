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

export async function addressFromPhrase(mnemonic) {
  const phrase = normalizeMnemonic(mnemonic)
  const words = phrase ? phrase.split(" ") : []
  if (words.length !== 12 && words.length !== 24) throw new Error("Use 12 or 24 words.")
  const { HDNodeWallet } = await ethersApi()
  const wallet = HDNodeWallet.fromPhrase(phrase)
  return String(wallet.address).toLowerCase()
}

export async function createSuperadmin() {
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
  const address = await addressFromPhrase(mnemonic)
  const bound = boundAdmin()
  if (bound && bound !== address) throw new Error("This phrase is not the Superadmin identity on this app.")
  bindAdmin(address)
  return address
}
