#version 300 es
// FERRO fragment shader. Section numbers follow SPEC B5.
// gl.ts inserts the param header (#define P_ZOOM uP[0] …) after the #version line.
precision highp float;
precision highp sampler2DArray;

uniform sampler2DArray uSdf;
uniform float uP[PARAM_COUNT];
uniform vec2  uRes;
uniform float uMotifA, uMotifB, uMorphT;
uniform int   uMeltMode;
uniform bool  uMirrorX, uMirrorY;
uniform float uWarpPhase, uSpikePhase, uWavePhase, uHueOffset, uMaster, uFrame;

out vec4 fragColor;

const float TAU = 6.28318530718;

// ---------- helpers (hash-based noise, no textures; vnoise and fbm return 0…1) ----------
// Integer hash of the cell floor(p): exact for cells up to 2^24, so noise stays clean
// however far the warp and spike phases have travelled.
float hash(vec2 p) {
  uvec2 q = uvec2(ivec2(floor(p))) * uvec2(1597334673u, 3812015801u);
  uint n = (q.x ^ q.y) * 1597334673u;
  return float(n) * (1.0 / 4294967296.0);
}
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x),
             mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
}
float fbm(vec2 p) { return (vnoise(p) + 0.5 * vnoise(p * 2.03 + 7.1)) / 1.5; }
mat2 rot(float a) { float c = cos(a), s = sin(a); return mat2(c, s, -s, c); }
float smin(float a, float b, float k) {
  float h = max(k - abs(a - b), 0.0) / k;
  return min(a, b) - h * h * k * 0.25;
}
vec3 hsv2rgb(vec3 c) {
  vec3 p = abs(fract(c.xxx + vec3(0.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0);
  return c.z * mix(vec3(1.0), clamp(p - 1.0, 0.0, 1.0), c.y);
}

// ---------- 4. SDF sample, valid distance outside the cell ----------
float sdf(vec2 p, float layer) {
  vec2 c = clamp(p, -1.0, 1.0);
  vec2 uv = vec2(c.x, -c.y) * 0.5 + 0.5; // atlas origin is top-left
  return texture(uSdf, vec3(uv, layer)).r + length(p - c);
}

void main() {
  // ---------- 1. Screen space: short side spans −1…+1 ----------
  vec2 s = (gl_FragCoord.xy - 0.5 * uRes) / (0.5 * min(uRes.x, uRes.y));
  vec2 p = s;

  // ---------- 2. Tilt, mirror, rotate, zoom ----------
  p /= max(1.0 + P_TILTX * p.x + P_TILTY * p.y, 0.25);
  if (uMirrorX) p.x = abs(p.x) - P_MIRRORSHIFT;
  if (uMirrorY) p.y = abs(p.y) - P_MIRRORSHIFT;
  p = rot(P_ROTATION * TAU) * p / P_ZOOM;

  // ---------- 3. Warp ----------
  vec2 q = p * P_WARPSCALE + uWarpPhase;
  p += P_WARPAMT * (vec2(fbm(q), fbm(q + 17.3)) * 2.0 - 1.0);

  // ---------- 4. Sample both motifs (exactly 2 texture samples) ----------
  float dA = sdf(p, uMotifA);
  float dB = sdf(p, uMotifB);

  // ---------- 5. Melt ----------
  float t = uMorphT;
  if (uMeltMode == 2)
    t = clamp(t * (1.0 + P_MELTNOISE) - P_MELTNOISE * fbm(p * P_MELTNOISESCALE), 0.0, 1.0);
  float d = mix(dA, dB, t);
  if (uMeltMode == 1) {
    float dU = smin(dA, dB, P_MELTK);
    d = t < 0.5 ? mix(dA, dU, smoothstep(0.0, 0.5, t))
                : mix(dU, dB, smoothstep(0.5, 1.0, t));
  }

  // ---------- 6. Line: thickness, spikes ----------
  d -= P_THICKNESS;
  d -= P_SPIKEAMP * pow(vnoise(p * P_SPIKEFREQ + uSpikePhase), P_SPIKESHARP);

  // ---------- 7. Mask ----------
  float aa = clamp(fwidth(d), 1e-4, 0.02);
  float mask = 1.0 - smoothstep(-aa, aa, d);

  // ---------- 8. Inner waves ----------
  float wv = 0.5 + 0.5 * sin(TAU * (d * P_WAVEFREQ - uWavePhase));
  float e = mix(0.5, 0.01, P_WAVESHARP);
  wv = smoothstep(0.5 - e, 0.5 + e, wv);
  float inner = mix(1.0, wv, P_WAVEAMT);

  // ---------- 9. Outer glow ----------
  float g = exp(-max(d, 0.0) / P_GLOWWIDTH) * P_GLOW * mix(1.0, wv, P_RIPPLE);

  // ---------- 10. Colour ----------
  float h = P_HUE + uHueOffset - clamp(d, -0.1, 0.02) * 10.0 * P_HUEDEPTH + length(s) * 0.5 * P_HUESPACE;
  vec3 rgb = hsv2rgb(vec3(fract(h), P_SAT, 1.0));
  float lum = mask * inner + (1.0 - mask) * g;
  vec3 col = rgb * lum * P_BRIGHTNESS;

  // ---------- 11. Grain, master fade ----------
  col += (hash(gl_FragCoord.xy + vec2(127.0, 311.0) * uFrame) - 0.5) * P_GRAIN * (0.15 + lum);
  fragColor = vec4(clamp(col, 0.0, 1.0) * uMaster, 1.0);
}
