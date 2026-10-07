import { mat4, vec3 } from 'gl-matrix';
import type { Volume } from './nifti';
import type { Geometry } from './manip/common';
import type { BodyMesh, Scene } from './scene';
import { silhouette } from './silhouette';
import { DEFAULT_VIEW, type ViewOptions } from './view-options';
import type { DepthMode, LineBatch, PlaneWidget } from './widget';

export interface Rect {
  /** CSS pixels, measured from the top-left of the canvas. */
  x: number;
  y: number;
  w: number;
  h: number;
}

const SLICE_VS = `#version 300 es
in vec2 aQuad;
uniform vec3 uOrigin;
uniform vec3 uHalfU;
uniform vec3 uHalfV;
uniform mat4 uMVP;
uniform bool uUse3D;
out vec3 vWorld;
void main() {
  vWorld = uOrigin + uHalfU * aQuad.x + uHalfV * aQuad.y;
  gl_Position = uUse3D ? uMVP * vec4(vWorld, 1.0) : vec4(aQuad, 0.0, 1.0);
}`;

/**
 * The whole reslice happens here: for every pixel we have a world position,
 * we map it into the volume's texture space with the inverse of the NIfTI
 * affine, and let the hardware do the trilinear interpolation. An oblique
 * plane costs exactly the same as an axis-aligned one.
 */
/** Ceiling on the warp knots; the shader loop needs a constant bound. */
export const MAX_KNOTS = 8;
/** Ceiling on the pinned level lines, for the same reason. */
export const MAX_PINS = 8;

const SLICE_FS = `#version 300 es
precision highp float;
precision highp sampler3D;
#define MAX_KNOTS ${MAX_KNOTS}
#define MAX_PINS ${MAX_PINS}
in vec3 vWorld;
uniform sampler3D uVol;
uniform mat4 uWorldToTex;
uniform vec3 uNormal;
uniform float uSlabHalf;
uniform int uSlabSteps;
uniform int uSlabMode;     // 0 = MIP, 1 = mean, 2 = MinIP
uniform float uWinLo;
uniform float uWinHi;
uniform vec4 uUnder;   // rgb, and a = 1 when the colour is in use
uniform vec4 uOver;
uniform bool uDiscardOutside;
uniform int uKnotN;
uniform float uKnotX[MAX_KNOTS];
uniform float uKnotY[MAX_KNOTS];
uniform bool uIsoLiveOn;
uniform float uIsoLive;
uniform int uPinN;
uniform float uPins[MAX_PINS];
uniform int uPinHot;       // index of the highlighted pin, or -1
out vec4 fragColor;

const vec3 ISO_INK = vec3(0.95);
const vec3 ISO_HOT = vec3(0.898, 0.651, 0.353);   // the bar's orange, --cb-live

/**
 * A level line of half-width w pixels, with a dark halo, over colour c. The
 * distance to the level is measured in pixels by dividing by the value's
 * screen-space rate of change, which keeps the line the same width however
 * steep the field is.
 */
vec3 isoLine(vec3 c, float v, float fw, float level, vec3 ink, float w) {
  float d = abs(v - level) / max(fw, 1e-6);
  float halo = 1.0 - smoothstep(w + 0.9, w + 1.9, d);
  float core = 1.0 - smoothstep(w - 0.5, w + 0.5, d);
  c = mix(c, vec3(0.0), halo * 0.6);
  return mix(c, ink, core);
}

/** The transfer function: piecewise linear through the knots, (0,0) to (1,1). */
float warp(float t) {
  float px = 0.0;
  float py = 0.0;
  for (int i = 0; i < MAX_KNOTS; i++) {
    if (i >= uKnotN) break;
    float kx = uKnotX[i];
    float ky = uKnotY[i];
    if (t <= kx) return py + (t - px) * (ky - py) / max(1e-9, kx - px);
    px = kx;
    py = ky;
  }
  return py + (t - px) * (1.0 - py) / max(1e-9, 1.0 - px);
}

bool sampleAt(vec3 w, out float val) {
  vec3 t = (uWorldToTex * vec4(w, 1.0)).xyz;
  if (any(lessThan(t, vec3(0.0))) || any(greaterThan(t, vec3(1.0)))) return false;
  val = texture(uVol, t).r;
  return true;
}

void main() {
  float acc = 0.0;
  int count = 0;
  for (int s = 0; s < uSlabSteps; ++s) {
    float t = uSlabSteps == 1
      ? 0.0
      : ((float(s) / float(uSlabSteps - 1)) * 2.0 - 1.0) * uSlabHalf;
    float v;
    if (!sampleAt(vWorld + uNormal * t, v)) continue;
    if (count == 0) acc = v;
    else if (uSlabMode == 0) acc = max(acc, v);
    else if (uSlabMode == 2) acc = min(acc, v);
    else acc += v;
    count++;
  }
  float v = count == 0 ? 0.0 : (uSlabMode == 1 ? acc / float(count) : acc);
  // Derivatives before any discard or return, while the whole quad is still
  // running. Where the quad straddles the edge of the volume the rate of
  // change is the jump to outside, not the field, so no line is drawn there.
  float fw = fwidth(v);
  float edge = fwidth(count > 0 ? 1.0 : 0.0);
  if (count == 0) {
    if (uDiscardOutside) discard;
    fragColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }
  float g = warp(clamp((v - uWinLo) / max(uWinHi - uWinLo, 1e-6), 0.0, 1.0));
  vec3 c = vec3(g);
  if (v < uWinLo && uUnder.a > 0.5) c = uUnder.rgb;
  else if (v > uWinHi && uOver.a > 0.5) c = uOver.rgb;
  if (edge == 0.0) {
    for (int i = 0; i < MAX_PINS; i++) {
      if (i >= uPinN) break;
      bool hot = i == uPinHot;
      c = isoLine(c, v, fw, uPins[i], hot ? ISO_HOT : ISO_INK, hot ? 1.1 : 0.6);
    }
    if (uIsoLiveOn) c = isoLine(c, v, fw, uIsoLive, ISO_INK, 0.75);
  }
  fragColor = vec4(c, 1.0);
}`;

/** uOffset nudges the line in clip space, which is how thick lines are faked. */
const LINE_VS = `#version 300 es
in vec3 aPos;
uniform mat4 uMVP;
uniform vec2 uOffset;
void main() {
  vec4 p = uMVP * vec4(aPos, 1.0);
  p.xy += uOffset * p.w;
  gl_Position = p;
}`;

/**
 * A polyline drawn as a screen-space ribbon, shaded as a tube. Width, opacity
 * and fog come in per vertex, so a curve tapers and fades continuously with
 * depth instead of in the visible steps you get from batching by width, and
 * the fragment stage lights it across its width so it reads as a cylinder
 * rather than a flat band.
 */
const RIBBON_VS = `#version 300 es
in vec3 aPos;
in vec3 aOther;      // the other end of this segment
in float aSide;      // -1 or +1, which edge of the ribbon
in float aDirSign;   // +1 when aOther is ahead, -1 when behind
in float aWidth;     // pixels
in float aAlpha;
in float aFog;       // 0 near, up to 1 far
uniform mat4 uMVP;
uniform vec2 uHalfViewport;
out float vAlpha;
out float vFog;
out float vAcross;   // -1 to +1 across the width of the tube
void main() {
  vec4 p = uMVP * vec4(aPos, 1.0);
  vec4 o = uMVP * vec4(aOther, 1.0);
  vec2 ps = (p.xy / p.w) * uHalfViewport;
  vec2 os = (o.xy / o.w) * uHalfViewport;
  vec2 d = (os - ps) * aDirSign;
  float len = length(d);
  vec2 n = len > 1e-5 ? vec2(-d.y, d.x) / len : vec2(0.0, 1.0);
  p.xy += (n * aSide * aWidth * 0.5) / uHalfViewport * p.w;
  gl_Position = p;
  vAlpha = aAlpha;
  vFog = aFog;
  vAcross = aSide;
}`;

const RIBBON_FS = `#version 300 es
precision highp float;
in float vAlpha;
in float vFog;
in float vAcross;
uniform vec3 uColor;
uniform vec3 uFogColor;
out vec4 fragColor;

// The light, in the ribbon's own 2D frame: x across the width, y towards the
// viewer. Slightly off centre, which is what gives the tube a round highlight.
const vec2 LIGHT = vec2(-0.40, 0.92);

void main() {
  float a = clamp(vAcross, -1.0, 1.0);
  // Surface of a cylinder seen side on: the component facing the camera.
  float nz = sqrt(max(0.0, 1.0 - a * a));
  float diff = max(0.0, a * LIGHT.x + nz * LIGHT.y);
  float spec = pow(diff, 28.0) * 0.55;
  vec3 lit = uColor * (0.32 + 0.68 * diff) + vec3(spec);
  // Soften the silhouette, which also helps it read as round.
  float edge = 1.0 - smoothstep(0.86, 1.0, abs(a));
  // Sink the far end into the background as well as thinning and fading it.
  fragColor = vec4(mix(lit, uFogColor, vFog), vAlpha * edge);
}`;

/**
 * The body surface, drawn as a ghost: lit from the eye, faint where it faces
 * the camera and stronger where it turns away, at the outline. So the volume
 * and its slice stay visible through it, and the body still reads as a shape.
 */
const BODY_VS = `#version 300 es
in vec3 aPos;
in vec3 aNormal;
uniform mat4 uMVP;
uniform mat3 uRot;
out vec3 vNormal;
void main() {
  vNormal = uRot * aNormal;
  gl_Position = uMVP * vec4(aPos, 1.0);
}`;

/** The body as a shell: light from the eye, faint where the surface faces the
 *  camera and stronger at the rim. The outline uses the same program to draw
 *  the surface into depth only. */
const BODY_FS = `#version 300 es
precision highp float;
in vec3 vNormal;
uniform vec3 uToEye;
uniform vec3 uColor;
uniform float uOpacity;
out vec4 fragColor;
void main() {
  float facing = abs(dot(normalize(vNormal), uToEye));
  float rim = pow(1.0 - facing, 2.0);
  vec3 c = uColor * (0.4 + 0.6 * facing) + vec3(0.18) * rim;
  fragColor = vec4(c, (0.05 + 0.55 * rim) * uOpacity);
}`;

/** The line where the body surface crosses the slice. */
const CONTOUR_RGB: [number, number, number] = [0.95, 0.22, 0.2];
const CONTOUR_WIDTH = 2;

/** The body's outline: its colour, its width in pixels, and how faint the
 *  stretches hidden behind the body itself or behind the slice are drawn. */
const BODY_RGB: [number, number, number] = [1.0, 0.6, 0.18];
const BODY_HIDDEN_ALPHA = 0.22;
/** The shell's tint and overall opacity. */
const SHELL_RGB: [number, number, number] = [1.0, 0.58, 0.2];
const SHELL_OPACITY = 0.9;

const LINE_FS = `#version 300 es
precision highp float;
uniform vec4 uColor;
out vec4 fragColor;
void main() { fragColor = uColor; }`;

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type)!;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error(`Error compilando shader: ${log}`);
  }
  return sh;
}

function link(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const p = gl.createProgram()!;
  const v = compile(gl, gl.VERTEX_SHADER, vs);
  const f = compile(gl, gl.FRAGMENT_SHADER, fs);
  gl.attachShader(p, v);
  gl.attachShader(p, f);
  gl.linkProgram(p);
  gl.deleteShader(v);
  gl.deleteShader(f);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(p);
    gl.deleteProgram(p);
    throw new Error(`Error enlazando programa: ${log}`);
  }
  return p;
}

function uniforms(gl: WebGL2RenderingContext, p: WebGLProgram): Record<string, WebGLUniformLocation | null> {
  const out: Record<string, WebGLUniformLocation | null> = {};
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS) as number;
  for (let i = 0; i < n; i++) {
    const info = gl.getActiveUniform(p, i);
    if (info) out[info.name] = gl.getUniformLocation(p, info.name);
  }
  return out;
}

/** Floats per ribbon vertex: pos, other, side, dirSign, width, alpha, fog. */
export const RIBBON_STRIDE = 11;

/** Matches the clear colour, so fogged geometry sinks into the background. */
const FOG_RGB: [number, number, number] = [0.06, 0.06, 0.07];

const BOX_RGB: [number, number, number] = [0.5, 0.54, 0.63];
const BOX_ALPHA = 0.07;

export class Renderer {
  /** What to show and how, from the panel. */
  options: ViewOptions = { ...DEFAULT_VIEW };
  readonly gl: WebGL2RenderingContext;
  private canvas: HTMLCanvasElement;

  private sliceProg: WebGLProgram;
  private sliceU: Record<string, WebGLUniformLocation | null>;
  private lineProg: WebGLProgram;
  private lineU: Record<string, WebGLUniformLocation | null>;

  private quadVao: WebGLVertexArrayObject;
  private lineVao: WebGLVertexArrayObject;
  private lineBuf: WebGLBuffer;
  private lineData = new Float32Array(4096);

  private ribbonProg: WebGLProgram;
  private ribbonU: Record<string, WebGLUniformLocation | null>;
  private ribbonVao: WebGLVertexArrayObject;
  private ribbonBuf: WebGLBuffer;
  private ribbonData = new Float32Array(8192);

  private bodyProg: WebGLProgram;
  private bodyU: Record<string, WebGLUniformLocation | null>;
  private bodyVao: WebGLVertexArrayObject | null = null;
  private bodyCount = 0;
  private bodyMesh: BodyMesh | null = null;

  private tex: WebGLTexture | null = null;
  private worldToTex = mat4.create();

  /** Device-pixel size of the viewport currently set, for line thickness. */
  private vpW = 1;
  private vpH = 1;

  /** Texture internal format actually in use, for the info panel. */
  readonly textureFormat: string;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', {
      antialias: true,
      depth: true,
      preserveDrawingBuffer: false,
      powerPreference: 'high-performance',
    });
    if (!gl) throw new Error('Este navegador no soporta WebGL2.');
    this.gl = gl;

    this.textureFormat = gl.getExtension('OES_texture_float_linear') ? 'R32F' : 'R16F';

    this.sliceProg = link(gl, SLICE_VS, SLICE_FS);
    this.sliceU = uniforms(gl, this.sliceProg);
    this.lineProg = link(gl, LINE_VS, LINE_FS);
    this.lineU = uniforms(gl, this.lineProg);

    this.quadVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.quadVao);
    const qb = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, qb);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
      gl.STATIC_DRAW,
    );
    const aQuad = gl.getAttribLocation(this.sliceProg, 'aQuad');
    gl.enableVertexAttribArray(aQuad);
    gl.vertexAttribPointer(aQuad, 2, gl.FLOAT, false, 0, 0);

    this.lineVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.lineVao);
    this.lineBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.lineBuf);
    gl.bufferData(gl.ARRAY_BUFFER, this.lineData.byteLength, gl.DYNAMIC_DRAW);
    const aPos = gl.getAttribLocation(this.lineProg, 'aPos');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, 0, 0);

    this.bodyProg = link(gl, BODY_VS, BODY_FS);
    this.bodyU = uniforms(gl, this.bodyProg);

    this.ribbonProg = link(gl, RIBBON_VS, RIBBON_FS);
    this.ribbonU = uniforms(gl, this.ribbonProg);
    this.ribbonVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.ribbonVao);
    this.ribbonBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.ribbonBuf);
    gl.bufferData(gl.ARRAY_BUFFER, this.ribbonData.byteLength, gl.DYNAMIC_DRAW);
    const stride = RIBBON_STRIDE * 4;
    const attrs: [string, number, number][] = [
      ['aPos', 3, 0],
      ['aOther', 3, 12],
      ['aSide', 1, 24],
      ['aDirSign', 1, 28],
      ['aWidth', 1, 32],
      ['aAlpha', 1, 36],
      ['aFog', 1, 40],
    ];
    for (const [name, size, offset] of attrs) {
      const loc = gl.getAttribLocation(this.ribbonProg, name);
      if (loc < 0) continue;
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride, offset);
    }

    gl.bindVertexArray(null);
    gl.clearColor(0.06, 0.06, 0.07, 1);
    // LEQUAL rather than LESS, so geometry coplanar with the slice still draws.
    gl.depthFunc(gl.LEQUAL);
  }

  /** Upload the body surface: positions and normals interleaved, and indices. */
  setBody(mesh: BodyMesh): void {
    const gl = this.gl;
    const n = mesh.positions.length / 3;
    const inter = new Float32Array(n * 6);
    for (let i = 0; i < n; i++) {
      inter.set(mesh.positions.subarray(i * 3, i * 3 + 3), i * 6);
      inter.set(mesh.normals.subarray(i * 3, i * 3 + 3), i * 6 + 3);
    }
    this.bodyVao = gl.createVertexArray();
    gl.bindVertexArray(this.bodyVao);
    const vb = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vb);
    gl.bufferData(gl.ARRAY_BUFFER, inter, gl.STATIC_DRAW);
    const aPos = gl.getAttribLocation(this.bodyProg, 'aPos');
    const aNormal = gl.getAttribLocation(this.bodyProg, 'aNormal');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, 24, 0);
    // The depth pass may let the compiler drop the normals.
    if (aNormal >= 0) {
      gl.enableVertexAttribArray(aNormal);
      gl.vertexAttribPointer(aNormal, 3, gl.FLOAT, false, 24, 12);
    }
    const ib = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    this.bodyCount = mesh.indices.length;
    this.bodyMesh = mesh;
  }

  /**
   * The body as its outline, placed by the body's model: the line where its
   * surface turns from facing the eye to facing away, worked out for the view
   * as it is now (see silhouette.ts). The whole outline is drawn faint first,
   * so what the body or the slice hides still shows, as hidden lines do on a
   * drawing. Then the surface is drawn into depth only, pushed back a little,
   * and the outline again, solid, where nothing is in front of it.
   *
   * It comes last: its depth would otherwise hide whatever is drawn after it
   * behind a surface that is not drawn.
   */
  private drawBodyOutline(scene: Scene, mvp: mat4): void {
    const mesh = this.bodyMesh;
    if (!mesh || !this.bodyVao || !this.bodyCount) return;
    const gl = this.gl;
    const m = scene.bodyModel;
    const bodyMvp = mat4.mul(mat4.create(), mvp, m);
    // Towards the eye, in the body's space: the rotation's transpose.
    const f = scene.cameraBasis().forward;
    const toEye = [
      -(m[0] * f[0] + m[1] * f[1] + m[2] * f[2]),
      -(m[4] * f[0] + m[5] * f[1] + m[6] * f[2]),
      -(m[8] * f[0] + m[9] * f[1] + m[10] * f[2]),
    ];
    const lines = silhouette(mesh, toEye);
    if (this.options.hiddenLines) this.drawLines(lines, BODY_RGB, bodyMvp, 1, BODY_HIDDEN_ALPHA, false, 'off');

    gl.useProgram(this.bodyProg);
    gl.uniformMatrix4fv(this.bodyU['uMVP'] ?? null, false, bodyMvp);
    gl.uniformMatrix3fv(this.bodyU['uRot'] ?? null, false, [m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]]);
    gl.colorMask(false, false, false, false);
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(true);
    // Pushed back, so the outline, which lies on the surface, is not hidden
    // by the surface it lies on.
    gl.enable(gl.POLYGON_OFFSET_FILL);
    gl.polygonOffset(1, 4);
    gl.bindVertexArray(this.bodyVao);
    gl.drawElements(gl.TRIANGLES, this.bodyCount, gl.UNSIGNED_SHORT, 0);
    gl.bindVertexArray(null);
    gl.disable(gl.POLYGON_OFFSET_FILL);
    gl.colorMask(true, true, true, true);

    this.drawLines(lines, BODY_RGB, bodyMvp, this.options.outlineWidth, 1, false, 'test');
  }

  /** The body as a translucent shell, over what is already drawn and without
   *  hiding anything drawn after it. */
  private drawBodyShell(scene: Scene, mvp: mat4): void {
    if (!this.bodyVao || !this.bodyCount) return;
    const gl = this.gl;
    const m = scene.bodyModel;
    gl.useProgram(this.bodyProg);
    gl.uniformMatrix4fv(this.bodyU['uMVP'] ?? null, false, mat4.mul(mat4.create(), mvp, m));
    // The rotation part of a rigid move turns its normals.
    gl.uniformMatrix3fv(this.bodyU['uRot'] ?? null, false, [m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]]);
    const f = scene.cameraBasis().forward;
    gl.uniform3f(this.bodyU['uToEye'] ?? null, -f[0], -f[1], -f[2]);
    gl.uniform3f(this.bodyU['uColor'] ?? null, SHELL_RGB[0], SHELL_RGB[1], SHELL_RGB[2]);
    gl.uniform1f(this.bodyU['uOpacity'] ?? null, SHELL_OPACITY);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.bindVertexArray(this.bodyVao);
    gl.drawElements(gl.TRIANGLES, this.bodyCount, gl.UNSIGNED_SHORT, 0);
    gl.bindVertexArray(null);
    gl.disable(gl.BLEND);
    gl.disable(gl.CULL_FACE);
    gl.depthMask(true);
  }

  setVolume(vol: Volume): void {
    const gl = this.gl;
    // Drain stale errors so the check below only sees this upload's.
    for (let i = 0; i < 16 && gl.getError() !== gl.NO_ERROR; i++) {
      /* drain */
    }
    // Build the new texture beside the old one, which is only dropped once the
    // upload has worked: a volume that fails leaves the current one on screen.
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_3D, tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
    const internal = this.textureFormat === 'R32F' ? gl.R32F : gl.R16F;
    gl.texImage3D(
      gl.TEXTURE_3D,
      0,
      internal,
      vol.dims[0],
      vol.dims[1],
      vol.dims[2],
      0,
      gl.RED,
      gl.FLOAT,
      vol.data,
    );
    const err = gl.getError();
    if (err !== gl.NO_ERROR) {
      gl.deleteTexture(tex);
      gl.bindTexture(gl.TEXTURE_3D, this.tex);
      throw new Error(`No se pudo subir el volumen a la GPU (error GL ${err}). Puede ser demasiado grande.`);
    }
    if (this.tex) gl.deleteTexture(this.tex);
    this.tex = tex;

    // world mm -> texture coords in [0,1]^3
    const m = mat4.create();
    mat4.scale(m, m, [1 / vol.dims[0], 1 / vol.dims[1], 1 / vol.dims[2]]);
    mat4.translate(m, m, [0.5, 0.5, 0.5]);
    mat4.mul(m, m, vol.worldToVoxel);
    this.worldToTex = m;
  }

  private syncSize(): [number, number] {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cssH = this.canvas.clientHeight || 1;
    const w = Math.max(1, Math.round((this.canvas.clientWidth || 1) * dpr));
    const h = Math.max(1, Math.round(cssH * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    return [cssH, dpr];
  }

  private setViewport(r: Rect, cssH: number, dpr: number): void {
    const gl = this.gl;
    const x = Math.round(r.x * dpr);
    const y = Math.round((cssH - (r.y + r.h)) * dpr);
    this.vpW = Math.max(1, Math.round(r.w * dpr));
    this.vpH = Math.max(1, Math.round(r.h * dpr));
    gl.viewport(x, y, this.vpW, this.vpH);
    gl.scissor(x, y, this.vpW, this.vpH);
  }

  /** How a batch takes part in depth: ignore it, respect it, or add to it. */
  private setDepth(mode: DepthMode): void {
    const gl = this.gl;
    if (mode === 'off') {
      gl.disable(gl.DEPTH_TEST);
      gl.depthMask(false);
      return;
    }
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(mode === 'write');
  }

  private drawLines(
    verts: number[],
    color: [number, number, number],
    mvp: mat4,
    width = 1,
    alpha = 1,
    strip = false,
    depth: DepthMode = 'off',
    nudge = 0,
    triangles = false,
  ): void {
    if (verts.length === 0) return;
    // Below one pixel there is no thinner line to draw, so a fractional width
    // is drawn as one pixel covering that fraction: the same ink, spread
    // fainter, which the eye reads as a finer line.
    if (width < 1 && !strip) {
      alpha *= Math.max(0, width);
      width = 1;
    }
    const gl = this.gl;
    if (verts.length > this.lineData.length) this.lineData = new Float32Array(verts.length * 2);
    this.lineData.set(verts);
    gl.bindVertexArray(this.lineVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.lineBuf);
    gl.bufferData(gl.ARRAY_BUFFER, this.lineData.byteLength, gl.DYNAMIC_DRAW);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.lineData, 0, verts.length);
    gl.useProgram(this.lineProg);
    gl.uniformMatrix4fv(this.lineU['uMVP'] ?? null, false, mvp);
    this.setDepth(depth);
    // Polygon offset only acts on filled triangles, which is what a nudged
    // strip is; a step or two settles a coplanar tie either way.
    if (nudge) {
      gl.enable(gl.POLYGON_OFFSET_FILL);
      gl.polygonOffset(nudge, 2 * nudge);
    }

    const blend = alpha < 1;
    if (blend) {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    }

    const count = verts.length / 3;
    if (strip || triangles) {
      gl.uniform4f(this.lineU['uColor'] ?? null, color[0], color[1], color[2], alpha);
      gl.uniform2f(this.lineU['uOffset'] ?? null, 0, 0);
      gl.drawArrays(triangles ? gl.TRIANGLES : gl.TRIANGLE_STRIP, 0, count);
    } else {
      // WebGL caps hardware line width at 1 px, so widen by redrawing offset.
      const k = Math.max(1, Math.round(width));
      // The passes overlap, so thin each one to land on the requested alpha
      // where they all coincide instead of compounding to opaque.
      const passAlpha = blend && k > 1 ? 1 - Math.pow(1 - alpha, 1 / (k * k)) : alpha;
      gl.uniform4f(this.lineU['uColor'] ?? null, color[0], color[1], color[2], passAlpha);
      const px = 2 / this.vpW;
      const py = 2 / this.vpH;
      const off = (i: number) => i - (k - 1) / 2;
      for (let i = 0; i < k; i++) {
        for (let j = 0; j < k; j++) {
          gl.uniform2f(this.lineU['uOffset'] ?? null, off(i) * px, off(j) * py);
          gl.drawArrays(gl.LINES, 0, count);
        }
      }
      gl.uniform2f(this.lineU['uOffset'] ?? null, 0, 0);
    }

    if (blend) gl.disable(gl.BLEND);
    if (nudge) gl.disable(gl.POLYGON_OFFSET_FILL);
  }

  /** Draw a packed ribbon: see RIBBON_STRIDE for the vertex layout. */
  private drawRibbon(
    verts: number[],
    color: [number, number, number],
    mvp: mat4,
    depth: DepthMode,
    nudge = 0,
  ): void {
    if (verts.length < RIBBON_STRIDE * 3) return;
    const gl = this.gl;
    if (verts.length > this.ribbonData.length) this.ribbonData = new Float32Array(verts.length * 2);
    this.ribbonData.set(verts);
    gl.bindVertexArray(this.ribbonVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.ribbonBuf);
    gl.bufferData(gl.ARRAY_BUFFER, this.ribbonData.byteLength, gl.DYNAMIC_DRAW);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.ribbonData, 0, verts.length);
    gl.useProgram(this.ribbonProg);
    gl.uniformMatrix4fv(this.ribbonU['uMVP'] ?? null, false, mvp);
    gl.uniform2f(this.ribbonU['uHalfViewport'] ?? null, this.vpW / 2, this.vpH / 2);
    gl.uniform3f(this.ribbonU['uColor'] ?? null, color[0], color[1], color[2]);
    gl.uniform3f(this.ribbonU['uFogColor'] ?? null, FOG_RGB[0], FOG_RGB[1], FOG_RGB[2]);
    this.setDepth(depth);
    // See LineBatch.nudge: settles a tie with the slice a ribbon lies in.
    if (nudge) {
      gl.enable(gl.POLYGON_OFFSET_FILL);
      gl.polygonOffset(nudge, 2 * nudge);
    }
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.drawArrays(gl.TRIANGLES, 0, verts.length / RIBBON_STRIDE);
    gl.disable(gl.BLEND);
    if (nudge) gl.disable(gl.POLYGON_OFFSET_FILL);
  }

  /** `handles` are the body's manipulator: one list drawn in the body's
   *  space, placed by the body's model, and one in the scene. */
  render(scene: Scene, widget: PlaneWidget, rect: Rect, handles: Geometry = { body: [], scene: [] }): void {
    const gl = this.gl;
    const [cssH, dpr] = this.syncSize();

    gl.disable(gl.SCISSOR_TEST);
    gl.disable(gl.DEPTH_TEST);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    if (!scene.vol || !this.tex) return;
    if (rect.w < 2 || rect.h < 2) return;

    gl.enable(gl.SCISSOR_TEST);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_3D, this.tex);

    this.draw3D(scene, widget, rect, cssH, dpr, this.slabSteps(scene), handles);

    gl.disable(gl.SCISSOR_TEST);
    gl.bindVertexArray(null);
  }

  private slabSteps(scene: Scene): number {
    if (scene.slabMm <= 0 || !scene.vol) return 1;
    const minSpacing = Math.max(0.05, Math.min(...scene.vol.spacing));
    return Math.min(64, Math.max(2, Math.round(scene.slabMm / minSpacing) + 1));
  }

  private drawSlice(
    scene: Scene,
    o: {
      origin: vec3;
      halfU: vec3;
      halfV: vec3;
      slabSteps: number;
      use3D: boolean;
      mvp: mat4;
      discardOutside: boolean;
    },
  ): void {
    const gl = this.gl;
    gl.useProgram(this.sliceProg);
    gl.bindVertexArray(this.quadVao);
    gl.uniform1i(this.sliceU['uVol'] ?? null, 0);
    gl.uniformMatrix4fv(this.sliceU['uWorldToTex'] ?? null, false, this.worldToTex);
    gl.uniform3fv(this.sliceU['uOrigin'] ?? null, o.origin as Float32Array);
    gl.uniform3fv(this.sliceU['uHalfU'] ?? null, o.halfU as Float32Array);
    gl.uniform3fv(this.sliceU['uHalfV'] ?? null, o.halfV as Float32Array);
    gl.uniform3fv(this.sliceU['uNormal'] ?? null, scene.n as Float32Array);
    gl.uniform1f(this.sliceU['uSlabHalf'] ?? null, scene.slabMm / 2);
    gl.uniform1i(this.sliceU['uSlabSteps'] ?? null, o.slabSteps);
    gl.uniform1i(this.sliceU['uSlabMode'] ?? null, scene.slabMode);
    gl.uniform1f(this.sliceU['uWinLo'] ?? null, scene.windowLo);
    gl.uniform1f(this.sliceU['uWinHi'] ?? null, scene.windowHi);
    const un = scene.underColor;
    const ov = scene.overColor;
    gl.uniform4f(this.sliceU['uUnder'] ?? null, un?.[0] ?? 0, un?.[1] ?? 0, un?.[2] ?? 0, un ? 1 : 0);
    gl.uniform4f(this.sliceU['uOver'] ?? null, ov?.[0] ?? 0, ov?.[1] ?? 0, ov?.[2] ?? 0, ov ? 1 : 0);
    const knots = scene.warpKnots.slice(0, MAX_KNOTS);
    gl.uniform1i(this.sliceU['uKnotN'] ?? null, knots.length);
    if (knots.length) {
      gl.uniform1fv(this.sliceU['uKnotX[0]'] ?? null, knots.map((k) => k.x));
      gl.uniform1fv(this.sliceU['uKnotY[0]'] ?? null, knots.map((k) => k.y));
    }
    gl.uniform1i(this.sliceU['uIsoLiveOn'] ?? null, scene.isoLive === null ? 0 : 1);
    gl.uniform1f(this.sliceU['uIsoLive'] ?? null, scene.isoLive ?? 0);
    const pins = scene.isoPins.slice(0, MAX_PINS);
    gl.uniform1i(this.sliceU['uPinN'] ?? null, pins.length);
    if (pins.length) gl.uniform1fv(this.sliceU['uPins[0]'] ?? null, pins);
    gl.uniform1i(this.sliceU['uPinHot'] ?? null, scene.isoHot);
    gl.uniform1i(this.sliceU['uUse3D'] ?? null, o.use3D ? 1 : 0);
    gl.uniform1i(this.sliceU['uDiscardOutside'] ?? null, o.discardOutside ? 1 : 0);
    gl.uniformMatrix4fv(this.sliceU['uMVP'] ?? null, false, o.mvp);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  /** The only view: the volume, the plane, and the plane's manipulator. */
  private draw3D(
    scene: Scene,
    widget: PlaneWidget,
    r: Rect,
    cssH: number,
    dpr: number,
    slabSteps: number,
    handles: Geometry,
  ): void {
    const gl = this.gl;
    this.setViewport(r, cssH, dpr);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    const { mvp } = scene.cameraMatrix(r.w / r.h);
    const ext = scene.radius() + Math.abs(scene.distance) + vec3.distance(scene.pivot, scene.volumeCentre());

    // The slice lays down the depth every widget part is then measured against.
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(true);
    this.drawSlice(scene, {
      origin: scene.planePoint(),
      halfU: vec3.scale(vec3.create(), scene.u, ext),
      halfV: vec3.scale(vec3.create(), scene.v, ext),
      slabSteps,
      use3D: true,
      mvp,
      discardOutside: true,
    });

    // The bounding box fades in while the pointer is over the image, and out
    // as soon as it leaves it: scaffolding, shown only while reading the slice.
    const c = scene.corners();
    // Always: never fainter than a steady, light trace of it.
    const box = this.options.box;
    const boxAlpha =
      box === 'never' ? 0
      : box === 'always' ? Math.max(BOX_ALPHA * 2.5, BOX_ALPHA * widget.boxShown)
      : BOX_ALPHA * widget.boxShown;
    if (c.length === 8 && boxAlpha > 0.002) {
      // corners() enumerates i fastest, then j, then k.
      const edges = [
        [0, 1], [2, 3], [4, 5], [6, 7],
        [0, 2], [1, 3], [4, 6], [5, 7],
        [0, 4], [1, 5], [2, 6], [3, 7],
      ];
      const verts: number[] = [];
      for (const [a, b] of edges) verts.push(c[a][0], c[a][1], c[a][2], c[b][0], c[b][1], c[b][2]);
      this.drawLines(verts, BOX_RGB, mvp, 1, boxAlpha, false, 'test');
    }


    const poly = scene.planeOutline();
    if (poly.length >= 2) {
      const verts: number[] = [];
      for (let k = 0; k < poly.length; k++) {
        const a = poly[k];
        const b = poly[(k + 1) % poly.length];
        verts.push(a[0], a[1], a[2], b[0], b[1], b[2]);
      }
      // Thin while oblique, thick once the plane lands on one of the grid's
      // own cartesian planes: the weight of the border says it is aligned.
      const w = scene.alignedToGrid() ? 3 : 0.5;
      this.drawLines(verts, scene.normalColor(), mvp, w, 1, false, 'off');
    }

    // Where the body surface crosses the slice, in red over the image. The
    // lines lie in the slice itself, so they are drawn over it rather than
    // made to fight it for depth.
    // The shell, after the slice so the slice shows through it.
    const style = this.options.bodyStyle;
    if (style === 'shell' || style === 'both') this.drawBodyShell(scene, mvp);

    const contour = this.options.contour ? scene.bodyContour() : [];
    if (contour.length) {
      this.drawLines(contour, CONTOUR_RGB, mvp, CONTOUR_WIDTH, 1, false, 'off');
    }

    // The manipulator lives partly in the body's space; the widget, in the scene's.
    const bodyMvp = mat4.mul(mat4.create(), mvp, scene.bodyModel);
    const batches: [LineBatch, mat4][] = [
      ...handles.body.map((b): [LineBatch, mat4] => [b, bodyMvp]),
      ...handles.scene.map((b): [LineBatch, mat4] => [b, mvp]),
      ...(widget.geometry() as LineBatch[]).map((b): [LineBatch, mat4] => [b, mvp]),
    ];
    for (const [batch, m] of batches) {
      if (batch.ribbon) {
        this.drawRibbon(batch.verts, batch.color, m, batch.depth ?? 'off', batch.nudge);
      } else {
        this.drawLines(
          batch.verts,
          batch.color,
          m,
          batch.width,
          batch.alpha ?? 1,
          batch.strip,
          batch.depth ?? 'off',
          batch.nudge,
          batch.triangles,
        );
      }
    }

    // The outline last: see drawBodyOutline.
    if (style === 'outline' || style === 'both') this.drawBodyOutline(scene, mvp);

    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(true);

    if (this.options.triad) this.drawTriad(scene, r.w / r.h);
  }

  /** RAS axis marker in the corner, so the patient's orientation is readable. */
  private drawTriad(scene: Scene, aspect: number): void {
    const t = scene.orientationTriad(aspect);
    const identity = mat4.create();
    // Back to front, so the axis pointing away is drawn under the others.
    const ordered = [...t.axes].sort((a, b) => b.depth - a.depth);
    for (const ax of ordered) {
      this.drawLines(
        [t.origin[0], t.origin[1], 0, ax.tip[0], ax.tip[1], 0],
        ax.color,
        identity,
        ax.depth > 0 ? 2 : 3,
      );
    }
  }
}
