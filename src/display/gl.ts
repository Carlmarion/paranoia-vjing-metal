// WebGL2 layer: programs, fullscreen triangle, R16F array texture, scene buffers (SPEC B2.4, B5).
import { GLSL_HEADER, PARAM_COUNT } from '../shared/params';
import { MAX_LAYERS, type Manifest } from '../shared/protocol';
import { blankHalf } from '../shared/sdf';
import vertSrc from './shader.vert?raw';
import fragSrc from './shader.frag?raw';
import showSrc from './show.frag?raw';

export interface FrameUniforms {
  params: Float32Array; // PARAM_COUNT effective values
  motifA: number;
  motifB: number;
  morphT: number;
  meltMode: number;
  mirrorX: boolean;
  mirrorY: boolean;
  warpPhase: number;
  spikePhase: number;
  wavePhase: number;
  spinPhase: number;
  /** Wobble lean (tiltX, tiltY). */
  tilt: [number, number];
  hueOffset: number;
}

/** One scene draw: a rectangle of the buffer (GL pixels, origin bottom-left) and the inputs it is drawn with. */
export interface CellDraw { rect: [x: number, y: number, w: number, h: number]; u: FrameUniforms; }
/** trails.ts: how much of the last frame is kept (0 = off) and where each pixel was in it (column-major mat2). */
export interface TrailUniforms { decay: number; m: [number, number, number, number]; }
/** The show pass: master fade, frame counter and grain amount. */
export interface ShowUniforms { master: number; frame: number; grain: number; }

const UNIFORMS = [
  'uSdf', 'uP', 'uRes', 'uMotifA', 'uMotifB', 'uMorphT', 'uMeltMode', 'uMirrorX', 'uMirrorY',
  'uWarpPhase', 'uSpikePhase', 'uWavePhase', 'uSpinPhase', 'uTilt', 'uHueOffset',
  'uPrev', 'uOrigin', 'uScreen', 'uTrailM', 'uTrailDecay', 'uFloor',
] as const;
type UniformName = (typeof UNIFORMS)[number];
const SHOW_UNIFORMS = ['uBuf', 'uGrain', 'uMaster', 'uFrame'] as const;
type ShowUniformName = (typeof SHOW_UNIFORMS)[number];

/** A scene buffer: rgb = the picture before grain and master, a = its luminance. */
interface Target { tex: WebGLTexture; fbo: WebGLFramebuffer; }

/** Insert the param header right after the #version line. */
export function withHeader(src: string): string {
  const nl = src.indexOf('\n');
  return src.slice(0, nl + 1) + GLSL_HEADER + src.slice(nl + 1);
}

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type);
  if (!sh) throw new Error('createShader failed');
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh) ?? 'unknown compile error';
    gl.deleteShader(sh);
    throw new Error(log);
  }
  return sh;
}

function link(gl: WebGL2RenderingContext, vert: string, frag: string): WebGLProgram {
  const vs = compile(gl, gl.VERTEX_SHADER, vert);
  const fs = compile(gl, gl.FRAGMENT_SHADER, frag);
  const prog = gl.createProgram();
  if (!prog) throw new Error('createProgram failed');
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(prog) ?? 'unknown link error';
    gl.deleteProgram(prog);
    throw new Error(log);
  }
  return prog;
}

export class Renderer {
  private program: WebGLProgram | null = null;
  private loc = {} as Record<UniformName, WebGLUniformLocation | null>;
  private showProgram: WebGLProgram | null = null;
  private showLoc = {} as Record<ShowUniformName, WebGLUniformLocation | null>;
  /** [0] is drawn into this frame, [1] holds the last frame; swapped after every draw. */
  private targets: [Target, Target] | null = null;
  private size: [number, number] = [0, 0];
  /** Float buffers (EXT_color_buffer_float). Without them: 8-bit, and the echo loses 1/255 per frame so it still reaches black. */
  private float = false;
  private tex: WebGLTexture | null = null;
  private vao: WebGLVertexArrayObject | null = null;
  private cell = 0;
  /** Last shader error; the previous program keeps running (SPEC B5 notes). */
  error: string | null = null;

  constructor(private gl: WebGL2RenderingContext) {}

  /** Build program, VAO and atlas texture. Call again after context restore. */
  init(atlas: ArrayBuffer, manifest: Manifest): void {
    this.program = null;
    this.targets = null;
    this.float = this.gl.getExtension('EXT_color_buffer_float') !== null;
    this.vao = this.gl.createVertexArray();
    this.buildProgram(withHeader(fragSrc));
    this.showProgram = link(this.gl, vertSrc, showSrc);
    for (const n of SHOW_UNIFORMS) this.showLoc[n] = this.gl.getUniformLocation(this.showProgram, n);
    this.uploadAtlas(atlas, manifest);
  }

  /** Compile and link; on failure keep the previous program and record the error. */
  buildProgram(frag: string): boolean {
    const gl = this.gl;
    try {
      const prog = link(gl, vertSrc, frag);
      if (this.program) gl.deleteProgram(this.program);
      this.program = prog;
      for (const n of UNIFORMS) this.loc[n] = gl.getUniformLocation(prog, n);
      this.error = null;
      return true;
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      return false;
    }
  }

  /**
   * B2.4: one immutable array of MAX_LAYERS layers. The baked atlas fills layers 0…count−1; every other layer
   * starts blank (+2, far from any line — a zero-filled layer would draw the whole screen as a line).
   */
  private uploadAtlas(atlas: ArrayBuffer, m: Manifest): void {
    const gl = this.gl;
    const expected = m.cell * m.cell * m.count * 2;
    if (atlas.byteLength !== expected) {
      throw new Error(`atlas.bin is ${atlas.byteLength} bytes, manifest expects ${expected}`);
    }
    if (m.count >= MAX_LAYERS) throw new Error(`${m.count} baked motifs: at most ${MAX_LAYERS - 1}`);
    if (this.tex) gl.deleteTexture(this.tex);
    this.tex = gl.createTexture();
    this.cell = m.cell;
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.R16F, m.cell, m.cell, MAX_LAYERS);
    gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, 0, m.cell, m.cell, m.count, gl.RED, gl.HALF_FLOAT, new Uint16Array(atlas));
    const blank = blankHalf(m.cell);
    for (let layer = m.count; layer < MAX_LAYERS; layer++) this.uploadLayer(layer, blank);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  /** Replace one layer (a drawn shape, the live layer, or blank). */
  uploadLayer(layer: number, half: Uint16Array): void {
    const gl = this.gl;
    if (!this.tex || half.length !== this.cell * this.cell) return;
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, layer, this.cell, this.cell, 1, gl.RED, gl.HALF_FLOAT, half);
  }

  /** Scene buffers follow the canvas size; new buffers start black. Call every frame. */
  resize(w: number, h: number): void {
    if (this.targets && this.size[0] === w && this.size[1] === h) return;
    const gl = this.gl;
    if (this.targets) for (const t of this.targets) { gl.deleteTexture(t.tex); gl.deleteFramebuffer(t.fbo); }
    const make = (): Target => {
      const tex = gl.createTexture();
      const fbo = gl.createFramebuffer();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texStorage2D(gl.TEXTURE_2D, 1, this.float ? gl.RGBA16F : gl.RGBA8, w, h);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      return { tex, fbo };
    };
    this.targets = [make(), make()];
    this.size = [w, h];
    this.clear();
  }

  /** Both scene buffers to black: no echo is left. */
  clear(): void {
    const gl = this.gl;
    if (!this.targets) return;
    gl.disable(gl.SCISSOR_TEST);
    gl.clearColor(0, 0, 0, 0);
    for (const t of this.targets) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /** Scene (one draw per cell, over the faded last frame) → buffer → canvas. The cells must tile the buffer. */
  draw(cells: readonly CellDraw[], trail: TrailUniforms, show: ShowUniforms): void {
    const gl = this.gl;
    if (!this.program || !this.showProgram || !this.targets) return;
    const [cur, prev] = this.targets;
    const [w, h] = this.size;
    const L = this.loc;

    gl.bindFramebuffer(gl.FRAMEBUFFER, cur.fbo);
    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.tex);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, prev.tex);
    gl.uniform1i(L.uSdf, 0);
    gl.uniform1i(L.uPrev, 1);
    gl.uniform2f(L.uScreen, w, h);
    gl.uniformMatrix2fv(L.uTrailM, false, trail.m);
    gl.uniform1f(L.uTrailDecay, trail.decay);
    gl.uniform1f(L.uFloor, this.float ? 0 : 1 / 255);
    gl.enable(gl.SCISSOR_TEST);
    for (const c of cells) this.drawCell(c);
    gl.disable(gl.SCISSOR_TEST);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, w, h);
    gl.useProgram(this.showProgram);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, cur.tex);
    gl.uniform1i(this.showLoc.uBuf, 0);
    gl.uniform1f(this.showLoc.uGrain, show.grain);
    gl.uniform1f(this.showLoc.uMaster, show.master);
    gl.uniform1f(this.showLoc.uFrame, show.frame % 997);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    this.targets = [prev, cur];
  }

  private drawCell({ rect: [x, y, w, h], u }: CellDraw): void {
    const gl = this.gl;
    if (u.params.length !== PARAM_COUNT) throw new Error('params length mismatch');
    const L = this.loc;
    gl.viewport(x, y, w, h);
    gl.scissor(x, y, w, h);
    gl.uniform2f(L.uOrigin, x, y);
    gl.uniform2f(L.uRes, w, h);
    gl.uniform1fv(L.uP, u.params);
    gl.uniform1f(L.uMotifA, u.motifA);
    gl.uniform1f(L.uMotifB, u.motifB);
    gl.uniform1f(L.uMorphT, u.morphT);
    gl.uniform1i(L.uMeltMode, u.meltMode);
    gl.uniform1i(L.uMirrorX, u.mirrorX ? 1 : 0);
    gl.uniform1i(L.uMirrorY, u.mirrorY ? 1 : 0);
    gl.uniform1f(L.uWarpPhase, u.warpPhase);
    gl.uniform1f(L.uSpikePhase, u.spikePhase);
    gl.uniform1f(L.uWavePhase, u.wavePhase);
    gl.uniform1f(L.uSpinPhase, u.spinPhase);
    gl.uniform2f(L.uTilt, u.tilt[0], u.tilt[1]);
    gl.uniform1f(L.uHueOffset, u.hueOffset);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
}
