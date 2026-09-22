window.__PEERYA_SCP_APP__ = true
;(function () {
  const fail = function () {
    return Promise.reject(new DOMException("Not allowed.", "NotAllowedError"))
  }
  try {
    if (navigator.credentials) {
      navigator.credentials.get = fail
      navigator.credentials.create = fail
    }
    if (window.PublicKeyCredential) {
      PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable = function () {
        return Promise.resolve(false)
      }
    }
  } catch (e) {}
})()
