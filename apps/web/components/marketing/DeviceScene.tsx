'use client'

import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js'
import { palette } from '@heli/tokens'

/**
 * The desk unit, modelled from the device contract (docs/03-device-contract.md): a turned body
 * holding the Pi, a down-firing speaker under it, an LED ring of 24 dots, a 4-mic array on top, a
 * yoke, and a camera head that tilts, with a mechanical shutter that slides over the lens.
 *
 * The ring follows the contract's table: off when idle, one dim steady dot while watching, dots that
 * follow the voice while speaking, two amber dots with the shutter closed.
 */
export type UnitState = 'idle' | 'watching' | 'speaking' | 'shutter'

const DOTS = 24
const R = 0.6
const H = 0.9

function hex(c: string) {
  return new THREE.Color(c)
}

function body(): THREE.BufferGeometry {
  const b = 0.1
  const pts: THREE.Vector2[] = [new THREE.Vector2(0, 0)]
  for (let i = 0; i <= 8; i += 1) {
    const a = -Math.PI / 2 + (i / 8) * (Math.PI / 2)
    pts.push(new THREE.Vector2(R - b + Math.cos(a) * b, b + Math.sin(a) * b))
  }
  for (let i = 0; i <= 8; i += 1) {
    const a = (i / 8) * (Math.PI / 2)
    pts.push(new THREE.Vector2(R - b + Math.cos(a) * b, H - b + Math.sin(a) * b))
  }
  pts.push(new THREE.Vector2(0, H))
  return new THREE.LatheGeometry(pts, 96)
}

export function DeviceScene({
  state = 'watching',
  autoRotate = true,
  className,
  onReady,
}: {
  state?: UnitState
  autoRotate?: boolean
  className?: string
  /** Called once, after the first frame is on screen. */
  onReady?: () => void
}) {
  const host = useRef<HTMLDivElement>(null)
  const stateRef = useRef<UnitState>(state)
  stateRef.current = state

  useEffect(() => {
    const el = host.current
    if (!el) return
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.outputColorSpace = THREE.SRGBColorSpace
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.toneMappingExposure = 0.95
    renderer.shadowMap.enabled = true
    el.appendChild(renderer.domElement)
    renderer.domElement.style.touchAction = 'pan-y'

    const scene = new THREE.Scene()
    const pmrem = new THREE.PMREMGenerator(renderer)
    const env = pmrem.fromScene(new RoomEnvironment(), 0.04).texture
    scene.environment = env

    const camera = new THREE.PerspectiveCamera(28, 1, 0.1, 50)
    camera.position.set(2.15, 1.35, 3.95)

    const controls = new OrbitControls(camera, renderer.domElement)
    controls.target.set(0, 0.88, 0)
    controls.enableZoom = false
    controls.enablePan = false
    controls.enableDamping = true
    controls.minPolarAngle = Math.PI * 0.22
    controls.maxPolarAngle = Math.PI * 0.49
    controls.autoRotate = autoRotate && !reduced
    controls.autoRotateSpeed = 0.7

    const key = new THREE.DirectionalLight(0xffffff, 2.2)
    key.position.set(3, 6, 4)
    key.castShadow = true
    key.shadow.mapSize.set(1024, 1024)
    key.shadow.radius = 8
    key.shadow.camera.left = -3
    key.shadow.camera.right = 3
    key.shadow.camera.top = 3
    key.shadow.camera.bottom = -3
    const rim = new THREE.DirectionalLight(0xffffff, 1.1)
    rim.position.set(-4, 3, -3)
    scene.add(key, rim, new THREE.AmbientLight(0xffffff, 0.15))

    /* ---- materials ------------------------------------------------------------------------ */
    // Standard, not physical, materials: they compile several times faster on a phone and read the same here.
    const shell = new THREE.MeshStandardMaterial({ color: hex(palette.ink[50]), roughness: 0.42 })
    const dark = new THREE.MeshStandardMaterial({ color: hex(palette.ink[900]), roughness: 0.18, metalness: 0.2 })
    const matte = new THREE.MeshStandardMaterial({ color: hex(palette.ink[800]), roughness: 0.9 })
    const metal = new THREE.MeshStandardMaterial({ color: hex(palette.ink[200]), metalness: 0.6, roughness: 0.4 })
    const accent = new THREE.MeshStandardMaterial({ color: hex(palette.jade[800]), roughness: 0.75, envMapIntensity: 0.3 })
    const glass = new THREE.MeshStandardMaterial({ color: hex(palette.ink[900]), roughness: 0.04, metalness: 0.6 })

    const unit = new THREE.Group()
    scene.add(unit)

    /* ---- body, speaker gap, ring ----------------------------------------------------------- */
    const shellMesh = new THREE.Mesh(body(), shell)
    shellMesh.position.y = 0.07
    shellMesh.castShadow = true
    unit.add(shellMesh)

    const foot = new THREE.Mesh(new THREE.CylinderGeometry(R * 0.86, R * 0.86, 0.08, 64), matte)
    foot.position.y = 0.04
    unit.add(foot)

    const band = new THREE.Mesh(new THREE.TorusGeometry(R, 0.016, 12, 160), dark)
    band.rotation.x = Math.PI / 2
    band.position.y = 0.07 + H - 0.12
    unit.add(band)

    const dotGeo = new THREE.SphereGeometry(0.018, 12, 12)
    const dots: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>[] = []
    for (let i = 0; i < DOTS; i += 1) {
      const m = new THREE.MeshBasicMaterial({ color: hex(palette.ink[900]), toneMapped: false })
      const d = new THREE.Mesh(dotGeo, m)
      // Index 0 faces the person (+z).
      const a = Math.PI / 2 - (i / DOTS) * Math.PI * 2
      d.position.set(Math.cos(a) * (R + 0.014), band.position.y, Math.sin(a) * (R + 0.014))
      unit.add(d)
      dots.push(d)
    }

    // The seam where the shell parts, just above the speaker slot.
    const seam = new THREE.Mesh(new THREE.TorusGeometry(R - 0.001, 0.004, 8, 160), matte)
    seam.rotation.x = Math.PI / 2
    seam.position.y = 0.07 + 0.2
    unit.add(seam)

    const micGeo = new THREE.CylinderGeometry(0.014, 0.014, 0.02, 16)
    for (let i = 0; i < 4; i += 1) {
      const a = Math.PI / 4 + (i * Math.PI) / 2
      const mic = new THREE.Mesh(micGeo, matte)
      mic.position.set(Math.cos(a) * 0.36, 0.07 + H + 0.001, Math.sin(a) * 0.36)
      unit.add(mic)
    }

    /* ---- yoke and head --------------------------------------------------------------------- */
    const postGeo = new RoundedBoxGeometry(0.06, 0.5, 0.16, 4, 0.025)
    for (const x of [-0.47, 0.47]) {
      const post = new THREE.Mesh(postGeo, metal)
      post.position.set(x, 0.07 + H + 0.2, 0)
      post.castShadow = true
      unit.add(post)
    }

    const pivot = new THREE.Group()
    pivot.position.set(0, 0.07 + H + 0.36, 0)
    unit.add(pivot)

    const head = new THREE.Mesh(new RoundedBoxGeometry(0.84, 0.46, 0.48, 8, 0.19), shell)
    head.castShadow = true
    pivot.add(head)

    const face = new THREE.Mesh(new RoundedBoxGeometry(0.66, 0.3, 0.04, 6, 0.12), dark)
    face.position.z = 0.23
    pivot.add(face)

    const lensRing = new THREE.Mesh(new THREE.TorusGeometry(0.095, 0.012, 16, 64), metal)
    lensRing.position.set(-0.1, 0, 0.252)
    pivot.add(lensRing)
    const lens = new THREE.Mesh(new THREE.SphereGeometry(0.088, 32, 16, 0, Math.PI * 2, 0, Math.PI / 2), glass)
    lens.rotation.x = Math.PI / 2
    lens.scale.set(1, 0.35, 1)
    lens.position.set(-0.1, 0, 0.248)
    pivot.add(lens)

    const shutter = new THREE.Mesh(new RoundedBoxGeometry(0.17, 0.2, 0.02, 4, 0.05), accent)
    const OPEN = 0.16
    const CLOSED = -0.1
    shutter.position.set(OPEN, 0, 0.3)
    pivot.add(shutter)

    /* ---- ground ---------------------------------------------------------------------------- */
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(12, 12), new THREE.ShadowMaterial({ opacity: 0.07 }))
    ground.rotation.x = -Math.PI / 2
    ground.receiveShadow = true
    scene.add(ground)

    /* ---- sizing, visibility, loop ---------------------------------------------------------- */
    const resize = () => {
      const w = el.clientWidth
      const h = el.clientHeight
      renderer.setSize(w, h, false)
      renderer.domElement.style.width = '100%'
      renderer.domElement.style.height = '100%'
      camera.aspect = w / Math.max(h, 1)
      camera.updateProjectionMatrix()
    }
    resize()
    const ro = new ResizeObserver(resize)
    ro.observe(el)

    let visible = true
    const io = new IntersectionObserver(([entry]) => {
      visible = entry?.isIntersecting ?? true
    })
    io.observe(el)

    const off = hex(palette.ink[900])
    const dim = hex(palette.jade[200])
    const voice = hex(palette.jade[200])
    const amber = hex(palette.amber[500])
    const start = performance.now()
    let frame = 0
    let first = true

    const tick = () => {
      frame = requestAnimationFrame(tick)
      if (!visible || document.hidden) return
      const t = (performance.now() - start) / 1000
      const s = stateRef.current

      for (let i = 0; i < DOTS; i += 1) {
        // An unlit dot is not drawn at all: the ring reads as a clean line until it has something to say.
        const dot = dots[i]!
        const m = dot.material
        let lit = false
        if (s === 'watching') {
          lit = i === 0
          m.color.copy(dim)
        } else if (s === 'speaking') {
          const dist = Math.min(i, DOTS - i)
          const amp = 0.5 + 0.5 * Math.sin(t * 9 + Math.sin(t * 3.1) * 2)
          lit = dist <= 1 + Math.round(amp * 5)
          m.color.copy(voice).lerp(off, dist / 9)
        } else if (s === 'shutter') {
          lit = i === 1 || i === DOTS - 1
          m.color.copy(amber)
        }
        dot.visible = lit
      }

      const target = s === 'shutter' ? CLOSED : OPEN
      shutter.position.x += (target - shutter.position.x) * (reduced ? 1 : 0.12)
      pivot.rotation.x = reduced ? -0.06 : -0.06 + Math.sin(t * 0.45) * 0.05

      controls.update()
      renderer.render(scene, camera)
      if (first) {
        first = false
        onReady?.()
      }
    }
    tick()

    return () => {
      cancelAnimationFrame(frame)
      ro.disconnect()
      io.disconnect()
      controls.dispose()
      scene.traverse((o) => {
        if (o instanceof THREE.Mesh) {
          o.geometry.dispose()
          const mats = Array.isArray(o.material) ? o.material : [o.material]
          mats.forEach((m) => m.dispose())
        }
      })
      env.dispose()
      pmrem.dispose()
      renderer.dispose()
      renderer.domElement.remove()
    }
  }, [autoRotate])

  return <div ref={host} className={className} aria-hidden="true" />
}
