/* GitGrove landing — small, dependency-free, deferred. */
;(() => {
  const root = document.documentElement
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches

  /* ---- Theme: persisted, else system ------------------------------------ */
  const saved = localStorage.getItem('gg-theme')
  if (saved === 'light' || saved === 'dark') {
    root.setAttribute('data-theme', saved)
  } else if (window.matchMedia('(prefers-color-scheme: light)').matches) {
    root.setAttribute('data-theme', 'light')
  }
  const setMeta = () => {
    const m = document.querySelector('meta[name="theme-color"]')
    if (m) m.content = root.getAttribute('data-theme') === 'light' ? '#ffffff' : '#0c0d10'
  }
  setMeta()
  document.getElementById('themeToggle')?.addEventListener('click', () => {
    const next = root.getAttribute('data-theme') === 'light' ? 'dark' : 'light'
    root.setAttribute('data-theme', next)
    localStorage.setItem('gg-theme', next)
    setMeta()
  })

  /* ---- Nav: condense on scroll + mobile menu ---------------------------- */
  const nav = document.getElementById('nav')
  const onScroll = () => nav.classList.toggle('scrolled', window.scrollY > 8)
  onScroll()
  window.addEventListener('scroll', onScroll, { passive: true })

  const navToggle = document.getElementById('navToggle')
  navToggle?.addEventListener('click', () => {
    const open = nav.classList.toggle('menu-open')
    navToggle.setAttribute('aria-expanded', String(open))
  })
  nav.querySelectorAll('.nav-links a').forEach((a) =>
    a.addEventListener('click', () => {
      nav.classList.remove('menu-open')
      navToggle?.setAttribute('aria-expanded', 'false')
    })
  )

  /* ---- OS-aware download label ------------------------------------------ */
  const ua = navigator.userAgent
  const plat = (navigator.platform || '') + ' ' + ua
  let os = 'macOS'
  if (/Win/i.test(plat)) os = 'Windows'
  else if (/Linux|X11/i.test(plat) && !/Android/i.test(plat)) os = 'Linux'
  else if (/Mac/i.test(plat)) os = 'macOS'
  const label = document.getElementById('heroDownloadLabel')
  if (label) label.textContent = 'Download for ' + os
  const osKey = os === 'Windows' ? 'windows' : os === 'Linux' ? 'linux' : 'mac'
  document.querySelector(`.dl-card[data-os="${osKey}"]`)?.classList.add('detected')

  /* ---- Direct download links --------------------------------------------
     Buttons default (in the HTML) to the Releases page so the page works with
     no JS. Here we ask the GitHub API for the *latest* release and rewrite them
     to direct-download URLs — the asset names embed the version, so we match by
     pattern and never need per-release edits. Falls back silently on error. */
  const REPO = 'danipen/gitgrove'
  const ASSET = {
    macArm: /macOS-arm64\.dmg$/i,
    macX64: /macOS-x64\.dmg$/i,
    winX64: /Windows-x64\.exe$/i,
    winArm: /Windows-arm64\.exe$/i,
    linux: /Linux.*\.AppImage$/i
  }
  const enhanceDownloads = async () => {
    try {
      const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
        headers: { Accept: 'application/vnd.github+json' }
      })
      if (!res.ok) return
      const rel = await res.json()
      const assets = rel.assets || []
      const urlFor = (re) => (assets.find((a) => re.test(a.name)) || {}).browser_download_url
      const setHref = (id, re) => {
        const el = document.getElementById(id)
        const u = urlFor(re)
        if (el && u) el.href = u
      }
      setHref('dl-mac', ASSET.macArm)
      setHref('dl-mac-alt', ASSET.macX64)
      setHref('dl-win', ASSET.winX64)
      setHref('dl-win-alt', ASSET.winArm)
      setHref('dl-linux', ASSET.linux)
      if (rel.tag_name) {
        document.querySelectorAll('.dl-version').forEach((e) => { e.textContent = rel.tag_name })
        const hv = document.getElementById('heroVersion')
        if (hv) hv.textContent = rel.tag_name
      }
      // Point the hero CTA at the detected platform's installer too.
      const heroRe = os === 'Windows' ? ASSET.winX64 : os === 'Linux' ? ASSET.linux : ASSET.macArm
      const heroUrl = urlFor(heroRe)
      const heroBtn = document.getElementById('heroDownload')
      if (heroBtn && heroUrl) heroBtn.href = heroUrl
    } catch {
      /* keep the Releases-page fallback already in the HTML */
    }
  }
  enhanceDownloads()

  /* ---- Scroll reveal ----------------------------------------------------- */
  const reveals = document.querySelectorAll('.reveal:not(.in)')
  if (reduceMotion || !('IntersectionObserver' in window)) {
    reveals.forEach((el) => el.classList.add('in'))
  } else {
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            e.target.classList.add('in')
            io.unobserve(e.target)
          }
        }
      },
      { threshold: 0.12, rootMargin: '0px 0px -8% 0px' }
    )
    reveals.forEach((el) => io.observe(el))
  }

  /* ---- Grove: draw the git-graph lines in ------------------------------- */
  const groves = document.querySelectorAll('.grove-draw')
  if (!reduceMotion) {
    groves.forEach((p, i) => {
      const len = p.getTotalLength()
      p.style.strokeDasharray = len
      p.style.strokeDashoffset = len
      p.style.transition = 'none'
      // force reflow, then animate
      void p.getBoundingClientRect()
      requestAnimationFrame(() => {
        p.style.transition = `stroke-dashoffset 1.6s cubic-bezier(0.22,1,0.36,1) ${0.15 + i * 0.18}s`
        p.style.strokeDashoffset = '0'
      })
    })
  } else {
    groves.forEach((p) => { p.style.strokeDashoffset = '0' })
  }

  /* ---- Two-themes drag-to-compare --------------------------------------- */
  const compare = document.getElementById('compare')
  if (compare) {
    const after = compare.querySelector('.after')
    const handle = compare.querySelector('.handle')
    const range = document.getElementById('compareRange')
    const afterImg = after.querySelector('img')
    const setW = () => { afterImg.style.setProperty('--cmp-w', compare.clientWidth + 'px') }
    const apply = (pct) => {
      pct = Math.max(0, Math.min(100, pct))
      after.style.width = pct + '%'
      handle.style.left = pct + '%'
      range.value = pct
    }
    setW()
    apply(50)
    window.addEventListener('resize', setW, { passive: true })
    range.addEventListener('input', () => apply(+range.value))
    const fromEvent = (clientX) => {
      const r = compare.getBoundingClientRect()
      apply(((clientX - r.left) / r.width) * 100)
    }
    let dragging = false
    compare.addEventListener('pointerdown', (e) => { dragging = true; fromEvent(e.clientX) })
    window.addEventListener('pointermove', (e) => { if (dragging) fromEvent(e.clientX) })
    window.addEventListener('pointerup', () => { dragging = false })
  }

  /* ---- Lightbox: full demo with sound ----------------------------------- */
  const lightbox = document.getElementById('lightbox')
  const demoVideo = document.getElementById('demoVideo')
  const heroVideo = document.getElementById('heroVideo')
  const openLightbox = () => {
    lightbox.classList.add('open')
    document.body.style.overflow = 'hidden'
    heroVideo?.pause()
    demoVideo.currentTime = 0
    demoVideo.play().catch(() => {})
  }
  const closeLightbox = () => {
    lightbox.classList.remove('open')
    document.body.style.overflow = ''
    demoVideo.pause()
    if (!reduceMotion) heroVideo?.play().catch(() => {})
  }
  document.getElementById('watchDemo')?.addEventListener('click', openLightbox)
  document.getElementById('lightboxClose')?.addEventListener('click', closeLightbox)
  lightbox?.addEventListener('click', (e) => { if (e.target === lightbox) closeLightbox() })
  /* ---- Screenshot lightbox: click a feature shot to view full size ------ */
  const imgLightbox = document.getElementById('imgLightbox')
  const imgLightboxImg = document.getElementById('imgLightboxImg')
  const openImg = (src, alt) => {
    imgLightboxImg.src = src
    imgLightboxImg.alt = alt || ''
    imgLightbox.classList.add('open')
    document.body.style.overflow = 'hidden'
  }
  const closeImg = () => {
    imgLightbox.classList.remove('open')
    document.body.style.overflow = ''
  }
  document.querySelectorAll('.feature-media .app-window').forEach((win) => {
    const img = win.querySelector('img')
    if (!img) return
    win.setAttribute('role', 'button')
    win.setAttribute('tabindex', '0')
    win.setAttribute('aria-label', `View full size: ${img.alt}`)
    const open = () => openImg(img.currentSrc || img.src, img.alt)
    win.addEventListener('click', open)
    win.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        open()
      }
    })
  })
  document.getElementById('imgLightboxClose')?.addEventListener('click', closeImg)
  imgLightbox?.addEventListener('click', (e) => { if (e.target === imgLightbox) closeImg() })

  /* ---- Esc closes whichever overlay is open ----------------------------- */
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return
    if (lightbox.classList.contains('open')) closeLightbox()
    if (imgLightbox.classList.contains('open')) closeImg()
  })

  /* Reduced motion: don't autoplay the hero loop. */
  if (reduceMotion && heroVideo) { heroVideo.removeAttribute('autoplay'); heroVideo.pause() }
})()
