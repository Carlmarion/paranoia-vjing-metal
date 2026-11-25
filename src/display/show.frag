#version 300 es
// FERRO show pass (design 2026-11-25 §4.4): the scene buffer → the canvas, with grain and the master fade.
// These two are applied here so that grain never piles up in the echoes and a blackout stays clean.
precision highp float;

uniform sampler2D uBuf; // rgb = picture, a = luminance
uniform float uGrain, uMaster, uFrame;

out vec4 fragColor;

// Same integer hash as shader.frag.
float hash(vec2 p) {
  uvec2 q = uvec2(ivec2(floor(p))) * uvec2(1597334673u, 3812015801u);
  uint n = (q.x ^ q.y) * 1597334673u;
  return float(n) * (1.0 / 4294967296.0);
}

void main() {
  vec4 b = texelFetch(uBuf, ivec2(gl_FragCoord.xy), 0);
  vec3 col = b.rgb + (hash(gl_FragCoord.xy + vec2(127.0, 311.0) * uFrame) - 0.5) * uGrain * (0.15 + b.a);
  fragColor = vec4(clamp(col, 0.0, 1.0) * uMaster, 1.0);
}
