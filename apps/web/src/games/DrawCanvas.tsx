import { useCallback, useEffect, useRef } from "react";
import { BRUSH_COLORS, BRUSH_SIZES, CANVAS, type Stroke } from "@spotflow-games/shared";

export interface Brush {
  tool: Stroke["tool"];
  color: number;
  size: number;
}

interface Props {
  strokes: React.MutableRefObject<Stroke[]>;
  /** Bumped whenever `strokes` is replaced or cleared, to force a full redraw. */
  version: number;
  /** Bumped when strokes are appended; only the new ones are drawn. */
  tick: number;
  canDraw: boolean;
  brush: Brush;
  onStroke: (stroke: Stroke) => void;
  label: string;
}

/** Brush colours come from design tokens, which are the same in both themes. */
function colorFor(stroke: Stroke, el: Element) {
  const name = stroke.tool === "eraser" ? "canvas-paper" : `brush-${BRUSH_COLORS[stroke.color]}`;
  return getComputedStyle(el).getPropertyValue(`--${name}`).trim() || "#000";
}

export function drawStroke(ctx: CanvasRenderingContext2D, stroke: Stroke) {
  const pts = stroke.points;
  ctx.strokeStyle = colorFor(stroke, ctx.canvas);
  ctx.fillStyle = ctx.strokeStyle;
  ctx.lineWidth = BRUSH_SIZES[stroke.size]! * (stroke.tool === "eraser" ? 2 : 1);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  if (pts.length === 1) {
    ctx.beginPath();
    ctx.arc(pts[0]![0], pts[0]![1], ctx.lineWidth / 2, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  ctx.beginPath();
  ctx.moveTo(pts[0]![0], pts[0]![1]);
  for (const [x, y] of pts.slice(1)) ctx.lineTo(x, y);
  ctx.stroke();
}

/**
 * The shared drawing board. Coordinates are on a fixed 1000 x 750 grid so every screen
 * size sees the same picture. The drawer's strokes are sent in small chunks while drawing.
 */
export function DrawCanvas({ strokes, version, tick, canDraw, brush, onStroke, label }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pending = useRef<{ points: Array<[number, number]>; last: [number, number] | null; drawing: boolean }>({
    points: [],
    last: null,
    drawing: false,
  });
  const drawn = useRef(0);
  const brushRef = useRef(brush);
  brushRef.current = brush;

  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    ctx.fillStyle = getComputedStyle(canvas).getPropertyValue("--canvas-paper").trim() || "#fff";
    ctx.fillRect(0, 0, CANVAS.width, CANVAS.height);
    for (const s of strokes.current) drawStroke(ctx, s);
    drawn.current = strokes.current.length;
  }, [strokes]);

  useEffect(redraw, [version, redraw]);

  useEffect(() => {
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx) return;
    for (let i = drawn.current; i < strokes.current.length; i++) drawStroke(ctx, strokes.current[i]!);
    drawn.current = strokes.current.length;
  }, [tick, strokes]);

  const flush = useCallback(() => {
    const p = pending.current;
    if (p.points.length === 0) return;
    // Start each chunk at the previous chunk's last point so the line stays joined.
    const points = p.last ? [p.last, ...p.points] : p.points;
    for (let i = 0; i < points.length; i += CANVAS.maxPointsPerStroke - 1) {
      const chunk = points.slice(i, i + CANVAS.maxPointsPerStroke);
      if (chunk.length === 0) break;
      const stroke: Stroke = { ...brushRef.current, points: chunk };
      strokes.current.push(stroke);
      const ctx = canvasRef.current?.getContext("2d");
      if (ctx) drawStroke(ctx, stroke);
      drawn.current = strokes.current.length;
      onStroke(stroke);
    }
    p.last = points[points.length - 1]!;
    p.points = [];
  }, [onStroke, strokes]);

  useEffect(() => {
    if (!canDraw) return;
    const t = setInterval(flush, 100);
    return () => clearInterval(t);
  }, [canDraw, flush]);

  const toCanvas = (e: React.PointerEvent): [number, number] => {
    const rect = canvasRef.current!.getBoundingClientRect();
    const x = Math.round(((e.clientX - rect.left) / rect.width) * CANVAS.width);
    const y = Math.round(((e.clientY - rect.top) / rect.height) * CANVAS.height);
    return [Math.min(CANVAS.width, Math.max(0, x)), Math.min(CANVAS.height, Math.max(0, y))];
  };

  return (
    <canvas
      ref={canvasRef}
      className="sg-canvas draw-canvas"
      width={CANVAS.width}
      height={CANVAS.height}
      role="img"
      aria-label={label}
      style={{ cursor: canDraw ? "crosshair" : "default", touchAction: canDraw ? "none" : "auto" }}
      onPointerDown={(e) => {
        if (!canDraw) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        pending.current = { points: [toCanvas(e)], last: null, drawing: true };
      }}
      onPointerMove={(e) => {
        if (!canDraw || !pending.current.drawing) return;
        const pt = toCanvas(e);
        const prev = pending.current.points.at(-1) ?? pending.current.last;
        if (prev && Math.abs(prev[0] - pt[0]) + Math.abs(prev[1] - pt[1]) < 3) return;
        pending.current.points.push(pt);
      }}
      onPointerUp={() => {
        if (!canDraw) return;
        flush();
        pending.current = { points: [], last: null, drawing: false };
      }}
      onPointerCancel={() => {
        flush();
        pending.current = { points: [], last: null, drawing: false };
      }}
    />
  );
}
