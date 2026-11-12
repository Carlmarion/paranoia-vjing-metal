// WebGL2 layer: program, fullscreen triangle, R16F array texture (SPEC B2.4, B5).
import { GLSL_HEADER, PARAM_COUNT } from '../shared/params';
import type { Manifest } from '../shared/protocol';
import vertSrc from './shader.vert?raw';
import fragSrc from './shader.frag?raw';

export interface FrameUniforms {
  params: Float32Array; // PARAM_COUNT effective values
  res: [number, number];
  motifA: number;
  motifB: number;
  morphT: number;
  meltMode: number;
  mirrorX: boolean;
  mirrorY: boolean;
  warpPhase: number;
  spikePhase: number;
  wavePhase: number;
  hueOffset: number;
  master: number;
  frame: number;
}

const UNIFORMS = [
  'uSdf', 'uP', 'uRes', 'uMotifA', 'uMotifB', 'uMorphT', 'uMeltMode', 'uMirrorX', 'uMirrorY',
  'uWarpPhase', 'uSpikePhase', 'uWavePhase', 'uHueOffset', 'uMaster', 'uFrame',
] as const;
type UniformName = (typeof UNIFORMS)[number];

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

export class Renderer {
  private program: WebGLProgram | null = null;
  private loc = {} as Record<UniformName, WebGLUniformLocation | null>;
  private tex: WebGLTexture | null = null;
  private vao: WebGLVertexArrayObject | null = null;
  /** Last shader error; the previous program keeps running (SPEC B5 notes). */
  error: string | null = null;

  constructor(private gl: WebGL2RenderingContext) {}

  /** Build program, VAO and atlas texture. Call again after context restore. */
  init(atlas: ArrayBuffer, manifest: Manifest): void {
    this.program = null;
    this.vao = this.gl.createVertexArray();
    this.buildProgram(withHeader(fragSrc));
    this.uploadAtlas(atlas, manifest);
  }

  /** Compile and link; on failure keep the previous program and record the error. */
  buildProgram(frag: string): boolean {
    const gl = this.gl;
    try {
      const vs = compile(gl, gl.VERTEX_SHADER, vertSrc);
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

  private uploadAtlas(atlas: ArrayBuffer, m: Manifest): void {
    const gl = this.gl;
    const expected = m.cell * m.cell * m.count * 2;
    if (atlas.byteLength !== expected) {
      throw new Error(`atlas.bin is ${atlas.byteLength} bytes, manifest expects ${expected}`);
    }
    if (this.tex) gl.deleteTexture(this.tex);
    this.tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage3D(gl.TEXTURE_2D_ARRAY, 0, gl.R16F, m.cell, m.cell, m.count, 0, gl.RED, gl.HALF_FLOAT, new Uint16Array(atlas));
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  draw(u: FrameUniforms): void {
    const gl = this.gl;
    if (!this.program) return;
    if (u.params.length !== PARAM_COUNT) throw new Error('params length mismatch');
    gl.viewport(0, 0, u.res[0], u.res[1]);
    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.tex);
    const L = this.loc;
    gl.uniform1i(L.uSdf, 0);
    gl.uniform1fv(L.uP, u.params);
    gl.uniform2f(L.uRes, u.res[0], u.res[1]);
    gl.uniform1f(L.uMotifA, u.motifA);
    gl.uniform1f(L.uMotifB, u.motifB);
    gl.uniform1f(L.uMorphT, u.morphT);
    gl.uniform1i(L.uMeltMode, u.meltMode);
    gl.uniform1i(L.uMirrorX, u.mirrorX ? 1 : 0);
    gl.uniform1i(L.uMirrorY, u.mirrorY ? 1 : 0);
    gl.uniform1f(L.uWarpPhase, u.warpPhase);
    gl.uniform1f(L.uSpikePhase, u.spikePhase);
    gl.uniform1f(L.uWavePhase, u.wavePhase);
    gl.uniform1f(L.uHueOffset, u.hueOffset);
    gl.uniform1f(L.uMaster, u.master);
    gl.uniform1f(L.uFrame, u.frame % 997);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
}
