import {
  avatarUrl,
  displayName,
  timeAgo,
  profileHref,
  toggleLike,
  toggleHeart,
  addComment,
  countReactions,
  hasReaction,
  listReactions
} from "./peerya.js"

let chromeBound = false

function ensureChrome() {
  if (!document.getElementById("lightbox")) {
    const box = document.createElement("div")
    box.id = "lightbox"
    box.className = "lightbox hidden"
    box.setAttribute("role", "dialog")
    box.setAttribute("aria-modal", "true")
    box.innerHTML =
      '<button type="button" class="lightbox-close" id="lightbox-close" aria-label="Close"><i class="bi bi-x-lg"></i></button>' +
      '<button type="button" class="lightbox-prev" id="lightbox-prev" aria-label="Previous"><i class="bi bi-chevron-left"></i></button>' +
      '<img id="lightbox-image" alt="">' +
      '<button type="button" class="lightbox-next" id="lightbox-next" aria-label="Next"><i class="bi bi-chevron-right"></i></button>'
    document.body.append(box)
  }
  if (!document.getElementById("react-modal")) {
    const modal = document.createElement("div")
    modal.id = "react-modal"
    modal.className = "react-modal"
    modal.setAttribute("role", "dialog")
    modal.setAttribute("aria-modal", "true")
    modal.innerHTML =
      '<div class="react-sheet"><div class="react-head">' +
      '<button type="button" class="react-tab" id="react-tab-like" data-tab="like">Likes</button>' +
      '<button type="button" class="react-tab" id="react-tab-heart" data-tab="heart">Hearts</button>' +
      '<button type="button" class="react-close" id="react-close" aria-label="Close">&times;</button>' +
      '</div><div class="react-list" id="react-list"></div></div>'
    document.body.append(modal)
  }
}

export function createFeed({ db, me, profiles, comments, presence, onRender }) {
  const openComments = new Set()
  const replyTo = new Map()
  const nameOf = (address) => displayName(db, profiles, address)
  let reactTarget = ""
  let reactTab = "like"
  let reactLock = false
  let lightboxImages = []
  let lightboxIndex = 0

  ensureChrome()
  const reactModal = document.getElementById("react-modal")
  const reactList = document.getElementById("react-list")
  const lightbox = document.getElementById("lightbox")
  const lightboxImage = document.getElementById("lightbox-image")

  const paintReactModal = () => {
    if (!reactModal.classList.contains("is-open") || !reactTarget) return
    document.getElementById("react-tab-like").classList.toggle("on", reactTab === "like")
    document.getElementById("react-tab-heart").classList.toggle("on", reactTab === "heart")
    const rows = listReactions(reactTab, reactTarget)
    reactList.innerHTML = ""
    if (!rows.length) {
      const empty = document.createElement("p")
      empty.className = "react-empty"
      empty.textContent = reactTab === "heart" ? "No hearts yet." : "No likes yet."
      reactList.append(empty)
      return
    }
    for (const item of rows) {
      const row = document.createElement("button")
      row.type = "button"
      row.className = "react-row"
      const href = profileHref(profiles, item.from)
      row.innerHTML = '<span class="avatar-wrap"><img class="avatar" alt=""><span class="presence"></span></span><div><p class="suggest-name"></p><p class="suggest-handle"></p></div>'
      row.querySelector("img").src = avatarUrl(item.from, profiles)
      row.querySelector(".presence").classList.toggle("online", presence.online.has(String(item.from).toLowerCase()))
      row.querySelector(".suggest-name").textContent = nameOf(item.from)
      const profile = profiles.get(String(item.from).toLowerCase())
      row.querySelector(".suggest-handle").textContent = "@" + ((profile && profile.username) || db.sm.abbrAddr(item.from))
      row.addEventListener("click", () => { if (href) location.href = href })
      reactList.append(row)
    }
  }

  const openReactModal = (targetId, tab) => {
    reactTarget = String(targetId || "")
    reactTab = tab === "heart" ? "heart" : "like"
    reactLock = true
    reactModal.classList.add("is-open")
    paintReactModal()
    setTimeout(() => { reactLock = false }, 400)
  }

  const closeReactModal = () => {
    if (reactLock) return
    reactModal.classList.remove("is-open")
    reactTarget = ""
  }

  if (!chromeBound) {
    chromeBound = true
    document.getElementById("react-close").addEventListener("click", (event) => {
      event.preventDefault()
      event.stopPropagation()
      reactLock = false
      reactModal.classList.remove("is-open")
      reactTarget = ""
    })
    reactModal.addEventListener("click", (event) => {
      if (reactLock) return
      if (event.target === reactModal) closeReactModal()
    })
    reactModal.querySelector(".react-sheet").addEventListener("click", (event) => event.stopPropagation())
    document.getElementById("react-tab-like").addEventListener("click", () => {
      reactTab = "like"
      paintReactModal()
    })
    document.getElementById("react-tab-heart").addEventListener("click", () => {
      reactTab = "heart"
      paintReactModal()
    })
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") closeReactModal()
    })
    const stepLightbox = (dir) => {
      if (!lightboxImages.length) return
      lightboxIndex = (lightboxIndex + dir + lightboxImages.length) % lightboxImages.length
      lightboxImage.src = lightboxImages[lightboxIndex].data
    }
    document.getElementById("lightbox-close").addEventListener("click", () => lightbox.classList.add("hidden"))
    document.getElementById("lightbox-prev").addEventListener("click", () => stepLightbox(-1))
    document.getElementById("lightbox-next").addEventListener("click", () => stepLightbox(1))
    lightbox.addEventListener("click", (event) => {
      if (event.target === lightbox) lightbox.classList.add("hidden")
    })
  }

  const openLightbox = (images, index) => {
    lightboxImages = images
    lightboxIndex = index
    lightboxImage.src = images[index].data
    const many = images.length > 1
    document.getElementById("lightbox-prev").style.visibility = many ? "visible" : "hidden"
    document.getElementById("lightbox-next").style.visibility = many ? "visible" : "hidden"
    lightbox.classList.remove("hidden")
  }

  const makeReactPair = (kind, targetId, targetType, postId) => {
    const on = hasReaction(kind, targetId, me)
    const wrap = document.createElement("div")
    wrap.className = "react-pair" + (targetType === "comment" ? " comment-stat" : " post-stat") + (on ? (kind === "heart" ? " on-heart" : " on-like") : "")
    const toggle = document.createElement("button")
    toggle.type = "button"
    toggle.className = "react-icon"
    toggle.setAttribute("aria-label", kind === "heart" ? "Heart" : "Like")
    const filled = kind === "heart" ? "bi-heart-fill" : "bi-hand-thumbs-up-fill"
    const empty = kind === "heart" ? "bi-heart" : "bi-hand-thumbs-up"
    toggle.innerHTML = '<i class="bi ' + (on ? filled : empty) + '"></i>'
    toggle.addEventListener("click", async (event) => {
      event.preventDefault()
      event.stopPropagation()
      if (postId) openComments.add(postId)
      await (kind === "heart" ? toggleHeart : toggleLike)(db, targetId, targetType)
    })
    const count = document.createElement("button")
    count.type = "button"
    count.className = "react-count"
    count.textContent = String(countReactions(kind, targetId))
    count.addEventListener("click", (event) => {
      event.preventDefault()
      event.stopPropagation()
      event.stopImmediatePropagation()
      openReactModal(targetId, kind)
    })
    wrap.append(toggle, count)
    return wrap
  }

  const renderPosts = (root, posts, emptyText) => {
    root.innerHTML = ""
    if (!posts.length) {
      const empty = document.createElement("p")
      empty.className = "feed-empty"
      empty.textContent = emptyText || "No posts yet."
      root.append(empty)
      return
    }
    for (const post of posts) {
      const postComments = [...comments.values()].filter((item) => item.postId === post.id)
      const article = document.createElement("article")
      article.className = "card post-card" + (openComments.has(post.id) ? " open-comments" : "")
      article.innerHTML =
        '<div class="post-header">' + (profileHref(profiles, post.author) ? '<a class="avatar-link" href="' + profileHref(profiles, post.author) + '">' : "") + '<span class="avatar-wrap"><img class="avatar" alt=""><span class="presence"></span></span>' + (profileHref(profiles, post.author) ? "</a>" : "") + '<div><p class="post-user"></p><p class="post-meta"></p></div>' +
        '<button type="button" class="post-more" aria-label="More"><i class="bi bi-three-dots"></i></button></div>' +
        '<div class="post-media-grid"></div>' +
        '<p class="post-caption"><strong></strong><span></span></p>' +
        '<div class="post-actions"></div>' +
        '<div class="post-comments"></div>'
      article.querySelector(".avatar").src = avatarUrl(post.author, profiles)
      article.querySelector(".post-header .presence").classList.toggle("online", presence.online.has(String(post.author).toLowerCase()))
      article.querySelector(".post-user").textContent = nameOf(post.author)
      article.querySelector(".post-meta").textContent = timeAgo(post.createdAt)
      const pics = Array.isArray(post.images) ? post.images.filter((image) => image && image.data) : []
      const grid = article.querySelector(".post-media-grid")
      if (!pics.length) grid.remove()
      else {
        grid.classList.add("count-" + Math.min(pics.length, 4))
        pics.forEach((image, index) => {
          const img = document.createElement("img")
          img.src = image.data
          img.alt = ""
          img.addEventListener("click", () => openLightbox(pics, index))
          grid.append(img)
        })
      }
      const caption = article.querySelector(".post-caption")
      if (post.caption) {
        caption.querySelector("strong").textContent = nameOf(post.author)
        caption.querySelector("span").textContent = " " + post.caption
      } else caption.remove()
      const actions = article.querySelector(".post-actions")
      const commentBtn = document.createElement("button")
      commentBtn.type = "button"
      commentBtn.className = "post-stat"
      commentBtn.innerHTML = '<i class="bi bi-chat"></i><span></span>'
      commentBtn.querySelector("span").textContent = String(postComments.length)
      commentBtn.addEventListener("click", () => {
        if (openComments.has(post.id)) openComments.delete(post.id)
        else openComments.add(post.id)
        onRender()
      })
      actions.append(commentBtn, makeReactPair("like", post.id, "post"), makeReactPair("heart", post.id, "post"))
      const box = article.querySelector(".post-comments")
      const form = document.createElement("form")
      form.className = "comment-form"
      const parentId = replyTo.get(post.id) || ""
      form.innerHTML = '<span class="avatar-wrap sm"><img class="avatar" alt=""></span><input type="text" class="form-control" maxlength="280"><button type="submit" class="btn"></button>'
      form.querySelector("img").src = avatarUrl(me, profiles)
      form.querySelector("input").placeholder = parentId ? "Write a reply…" : "Write a comment…"
      form.querySelector(".btn").textContent = parentId ? "Reply" : "Comment"
      form.addEventListener("submit", async (event) => {
        event.preventDefault()
        const input = form.querySelector("input")
        await addComment(db, post.id, input.value, parentId)
        input.value = ""
        replyTo.delete(post.id)
      })
      box.append(form)
      const roots = postComments.filter((item) => !item.parentId)
      const kids = (parent) => postComments.filter((item) => item.parentId === parent)
      const drawComment = (node, into) => {
        const row = document.createElement("div")
        row.className = "comment-item"
        row.innerHTML =
          (profileHref(profiles, node.author) ? '<a class="avatar-link" href="' + profileHref(profiles, node.author) + '">' : "") +
          '<span class="avatar-wrap sm"><img class="avatar" alt=""><span class="presence"></span></span>' +
          (profileHref(profiles, node.author) ? "</a>" : "") +
          '<div class="comment-main"><div class="comment-body"><div class="comment-meta"><strong></strong><span class="comment-time"></span></div>' +
          '<p class="comment-text"></p></div><div class="comment-actions"><button type="button" class="comment-reply">Reply</button></div></div>'
        row.querySelector("img").src = avatarUrl(node.author, profiles)
        row.querySelector(".presence").classList.toggle("online", presence.online.has(String(node.author).toLowerCase()))
        row.querySelector("strong").textContent = nameOf(node.author)
        row.querySelector(".comment-time").textContent = timeAgo(node.createdAt)
        row.querySelector(".comment-text").textContent = node.text || ""
        row.querySelector(".comment-actions").append(makeReactPair("like", node.id, "comment", post.id), makeReactPair("heart", node.id, "comment", post.id))
        row.querySelector(".comment-reply").addEventListener("click", () => {
          openComments.add(post.id)
          replyTo.set(post.id, node.id)
          onRender()
        })
        into.append(row)
        const replies = kids(node.id)
        if (replies.length) {
          const nest = document.createElement("div")
          nest.className = "comment-replies"
          replies.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0)).forEach((child) => drawComment(child, nest))
          row.querySelector(".comment-main").append(nest)
        }
      }
      if (!roots.length) {
        const empty = document.createElement("p")
        empty.className = "comment-empty"
        empty.textContent = "Be the first to comment."
        box.append(empty)
      } else {
        roots.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0)).forEach((node) => drawComment(node, box))
      }
      root.append(article)
    }
    paintReactModal()
  }

  return { renderPosts, paintReactModal, openComments }
}
