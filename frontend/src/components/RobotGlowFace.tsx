import React, { useEffect, useRef } from 'react'

const ICON_SIZE = 56
const CENTER = ICON_SIZE / 2

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))

interface RobotGlowFaceProps {
  className?: string
}

export const RobotGlowFace: React.FC<RobotGlowFaceProps> = ({ className }) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const requestRef = useRef<number>()
  const containerRef = useRef<HTMLDivElement | null>(null)

  const state = useRef({
    mouse: { x: CENTER, y: CENTER, lastX: 0, lastY: 0, lastMove: 0 },
    facePos: { x: 0, y: 0 },
    blink: { val: 1, timer: 3000 },
    wander: { x: 0, y: 0, nextChange: 0 },
    emotion: {
      current: 'NEUTRAL',
      target: 'NEUTRAL',
      morph: 0,
    },
  })

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const COLORS = {
      iceBlue: '#00D2FF',
      deepBlue: '#0095FF',
      iceGlow: 'rgba(160, 238, 255, 0.4)',
      iris: 'rgba(160, 238, 255, 0.3)',
      highlight: '#FFFFFF',
      outline: '#102030',
      grayLine: 'rgba(136, 136, 136, 0.15)',
      black: '#000000',
    }

    canvas.width = ICON_SIZE
    canvas.height = ICON_SIZE

    const handleMouseMove = (event: MouseEvent | Touch) => {
      const container = containerRef.current?.closest('[data-agent-panel]')
      if (!container) return
      const rect = container.getBoundingClientRect()
      if (
        event.clientX < rect.left ||
        event.clientX > rect.right ||
        event.clientY < rect.top ||
        event.clientY > rect.bottom
      ) {
        return
      }

      const s = state.current
      const canvasRect = canvas.getBoundingClientRect()
      const rawX = event.clientX - canvasRect.left
      const rawY = event.clientY - canvasRect.top

      s.mouse.x = rawX
      s.mouse.y = rawY
      s.mouse.lastMove = performance.now()
      s.mouse.lastX = event.clientX
      s.mouse.lastY = event.clientY
    }

    const handlePointerMove = (evt: MouseEvent) => {
      handleMouseMove(evt)
    }

    const handleTouchMove = (evt: TouchEvent) => {
      if (!evt.touches.length) return
      handleMouseMove(evt.touches[0])
    }

    const animate = (time: number) => {
      const s = state.current
      const outerRadius = 18
      const innerRadius = 15

      const isIdle = time - s.mouse.lastMove > 3000

      if (time > s.wander.nextChange) {
        s.wander.x = (Math.random() - 0.5) * (isIdle ? 3 : 5)
        s.wander.y = (Math.random() - 0.5) * (isIdle ? 2 : 4)

        s.emotion.target = Math.random() > 0.85 ? 'WINK' : 'NEUTRAL'
        s.wander.nextChange = time + 2000 + Math.random() * 2000
      }

      const distToCenter = Math.hypot(s.mouse.x - CENTER, s.mouse.y - CENTER)
      if (!isIdle) {
        if (distToCenter < 12) s.emotion.target = 'HAPPY'
        else if (distToCenter > 100) s.emotion.target = 'SURPRISED'
        else if (s.emotion.target !== 'WINK') s.emotion.target = 'NEUTRAL'
      }

      const morphSpeed = 0.08
      if (s.emotion.current !== s.emotion.target) {
        s.emotion.morph -= morphSpeed
        if (s.emotion.morph <= 0) {
          s.emotion.morph = 0
          s.emotion.current = s.emotion.target
        }
      } else {
        s.emotion.morph += (1 - s.emotion.morph) * (morphSpeed * 2)
      }

      const breath = (Math.sin(time / 1200) + 1) / 2
      const targetFaceX = clamp(((s.mouse.x - CENTER) / CENTER) * 4, -4, 4) + s.wander.x
      const targetFaceY = clamp(((s.mouse.y - CENTER) / CENTER) * 3, -3, 3) + s.wander.y
      s.facePos.x += (targetFaceX - s.facePos.x) * 0.1
      s.facePos.y += (targetFaceY - s.facePos.y) * 0.1

      if (s.emotion.current !== 'WINK') {
        if (s.blink.timer > 0) {
          s.blink.timer -= 16.6
          s.blink.val += (1 - s.blink.val) * 0.15
        } else {
          s.blink.val -= 0.6
          if (s.blink.val <= 0) {
            s.blink.val = 0
            s.blink.timer = 2000 + Math.random() * 4000
          }
        }
      }

      ctx.clearRect(0, 0, ICON_SIZE, ICON_SIZE)

      const drawGlow = () => {
        ctx.save()
        ctx.beginPath()
        ctx.rect(0, 0, ICON_SIZE, ICON_SIZE)
        ctx.arc(CENTER, CENTER, outerRadius, 0, Math.PI * 2, true)
        ctx.clip()

        const glowR = outerRadius * (1.1 + 0.3 * breath)
        const grad = ctx.createRadialGradient(CENTER, CENTER, outerRadius, CENTER, CENTER, glowR)
        const alpha = 0.4 * breath
        grad.addColorStop(0, `rgba(0, 160, 255, ${alpha})`)
        grad.addColorStop(1, 'rgba(0, 160, 255, 0)')
        ctx.fillStyle = grad
        ctx.beginPath()
        ctx.arc(CENTER, CENTER, glowR, 0, Math.PI * 2)
        ctx.fill()
        ctx.restore()
      }
      drawGlow()

      const drawAnnulus = () => {
        ctx.save()
        const ax = CENTER + s.facePos.x * 0.2
        const ay = CENTER + s.facePos.y * 0.2

        ctx.beginPath()
        ctx.arc(ax, ay, outerRadius, 0, Math.PI * 2, false)
        ctx.arc(ax, ay, innerRadius, 0, Math.PI * 2, true)
        ctx.closePath()

        const grad = ctx.createRadialGradient(ax, ay, innerRadius, ax, ay, outerRadius)
        const alpha = 0.4 + breath * 0.3
        grad.addColorStop(0, `rgba(0, 140, 255, ${alpha})`)
        grad.addColorStop(1, `rgba(180, 240, 255, ${alpha})`)
        ctx.fillStyle = grad
        ctx.fill()

        ctx.strokeStyle = COLORS.grayLine
        ctx.lineWidth = 0.5
        ctx.stroke()
        ctx.restore()
      }
      drawAnnulus()

      const drawFace = () => {
        const fx = CENTER + s.facePos.x
        const fy = CENTER + s.facePos.y
        const eyeSpacing = 6.5
        const eyeR = 2.4

        const drawEye = (side: number, isWinkTarget: boolean) => {
          const ex = fx + side * eyeSpacing
          const ey = fy - 1

          const sizeMult = s.emotion.current === 'SURPRISED' ? 1 + 0.2 * s.emotion.morph : 1
          let currentH: number
          if (s.emotion.current === 'WINK' && isWinkTarget) {
            currentH = (1 - s.emotion.morph * 0.9) * eyeR * sizeMult
          } else {
            currentH = s.blink.val * eyeR * sizeMult
          }

          ctx.save()
          ctx.beginPath()
          ctx.ellipse(ex, ey, eyeR * sizeMult, Math.max(0.1, currentH), 0, 0, Math.PI * 2)
          ctx.fillStyle = COLORS.iceGlow
          ctx.fill()

          if (currentH > 0.8) {
            const pupilR = 1.1 * sizeMult
            const pDX = clamp((s.mouse.x - ex) * 0.1, -1, 1)
            const pDY = clamp((s.mouse.y - ey) * 0.1, -1, 1)

            ctx.beginPath()
            ctx.arc(ex + pDX, ey + pDY, pupilR, 0, Math.PI * 2)
            ctx.fillStyle = COLORS.outline
            ctx.fill()

            ctx.beginPath()
            ctx.arc(ex + pDX - 0.4, ey + pDY - 0.4, 0.4, 0, Math.PI * 2)
            ctx.fillStyle = COLORS.highlight
            ctx.fill()
          }

          ctx.beginPath()
          ctx.ellipse(ex, ey, eyeR * sizeMult, Math.max(0.1, currentH), 0, 0, Math.PI * 2)
          ctx.lineWidth = 0.8
          ctx.strokeStyle = COLORS.black
          ctx.stroke()
          ctx.restore()
        }

        drawEye(-1, true)
        drawEye(1, false)

        const my = fy + 4.5
        const mw = 5.5
        ctx.save()
        ctx.beginPath()
        if (s.emotion.current === 'HAPPY' || s.emotion.current === 'WINK') {
          ctx.moveTo(fx - mw / 2, my)
          ctx.quadraticCurveTo(fx, my + 3 * s.emotion.morph, fx + mw / 2, my)
        } else if (s.emotion.current === 'SURPRISED') {
          ctx.ellipse(fx, my + 1, 1.8 * s.emotion.morph, 2.5 * s.emotion.morph, 0, 0, Math.PI * 2)
        } else {
          ctx.moveTo(fx - 1.8, my)
          ctx.lineTo(fx + 1.8, my)
        }
        ctx.lineWidth = 1.1
        ctx.strokeStyle = COLORS.outline
        ctx.lineCap = 'round'
        ctx.stroke()
        ctx.restore()
      }
      drawFace()

      requestRef.current = requestAnimationFrame(animate)
    }

    window.addEventListener('mousemove', handlePointerMove)
    window.addEventListener('touchmove', handleTouchMove)
    requestRef.current = requestAnimationFrame(animate)

    return () => {
      window.removeEventListener('mousemove', handlePointerMove)
      window.removeEventListener('touchmove', handleTouchMove)
      if (requestRef.current) {
        cancelAnimationFrame(requestRef.current)
      }
    }
  }, [])

  return (
    <div className={className} style={{ width: ICON_SIZE, height: ICON_SIZE }} ref={containerRef}>
      <canvas ref={canvasRef} style={{ width: ICON_SIZE, height: ICON_SIZE, display: 'block' }} />
    </div>
  )
}

export default RobotGlowFace


