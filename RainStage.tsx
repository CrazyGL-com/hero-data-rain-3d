import * as React from 'react';

/* ─────────────────────────────────────────────────────────────────────────
   RainStage — the Three.js scene for the Data Rain 3D hero.
   Lazy-loaded via React.lazy so the rest of the gallery isn't penalised with
   the three.js bundle. 'import * as THREE' happens inside this module.

   Physics statement
     • Particle field — N instanced glyph quads scattered through a 3D box
       volume. Each instance carries a fixed (x, z), a per-instance fall phase
       and speed, a glyph index, and a column "leadiness". Every frame the
       quad's Y is computed from time and wrapped within the volume height, so
       glyphs continuously fall and re-emit at the top. Ref: classic instanced
       particle-field (three.js InstancedMesh + instanced attributes; the
       drawArrays(POINTS) field pattern from the catalog, generalised to
       textured quads so we can show real glyphs).
     • Perspective depth — a PerspectiveCamera looks down the -Z axis into the
       volume. Near glyphs subtend a larger solid angle (the 1/z perspective
       scale), so they render large and bright; far glyphs shrink. Quads are
       camera-facing billboards so the glyph always reads flat-on.
     • Depth fog — Beer-Lambert extinction, I = I0 * exp(-sigma * d). Distant
       glyphs fade toward the background colour (and toward alpha 0 when the
       backdrop is transparent). Implemented per-fragment in the shader off the
       view-space depth, so it is continuous and resolution-independent. Ref:
       Beer-Lambert law; three.js FogExp2 (same exp(-density*d) curve), done
       inline so we can also drive alpha for the transparent backdrop.
     • Near-plane fade — MANDATORY for particle fields. As a glyph's view-space
       depth approaches the camera it would explode in size and pop; instead we
       smoothstep its alpha to 0 over the nearest slab so it dissolves in
       gracefully rather than clipping the near plane. Pairs the perspective
       size with an alpha fade rather than a hard clamp.
     • Umbrella repulsion (pointer) — input.x/input.y are projected onto a
       plane at the middle of the volume to get a world-space cursor point.
       Each frame, for the repulsion we pass the cursor (x, z) + radius +
       strength to the shader; in the vertex shader each instance within the
       radius is pushed radially outward in the X/Z plane with a smooth
       falloff (smoothstep), easing back as it leaves the radius. The stream
       therefore curves AROUND the cursor like rain off an invisible umbrella.
       This is a smooth radial repulsion field, the same shape used for pointer
       attractors/repulsors in particle heroes.

   Coordinate spaces
     • atlas px   — offscreen canvas pixels for the glyph atlas, Y-down.
     • atlas UV   — [0..1]^2 into the CanvasTexture; flipY=false so V grows the
                    same way as atlas px (top row of canvas = V 0). The quad UVs
                    are authored to match, so glyphs render right-way-up.
     • instance   — per-instance (x, z) in world units, fixed; y derived per
                    frame from time, speed and the volume height.
     • world      — three.js world; volume centred at origin, camera on +Z
                    looking toward -Z.
     • view       — camera space; -z is depth into the screen. Fog + near-fade
                    read off -mvPosition.z.
     • u_pointer  — runtime input in 0..1 (top-left origin). Projected to a
                    world point on the mid-volume plane; Y is FLIPPED vs world Y.
   ───────────────────────────────────────────────────────────────────────── */

export type RainStageProps = {
	charset: string;        // 'digits' | 'hex' | 'katakana' | 'symbols'
	customChars: string;    // overrides charset when non-empty
	count: number;          // 800..6000
	fallSpeed: number;      // 0.2..3
	glyphSize: number;      // 0.5..3
	symbolColor: string;
	headColor: string;
	backgroundColor: string;
	depthRange: number;     // 10..80
	fogDensity: number;     // 0..2
	cameraFov: number;      // 30..80
	umbrellaRadius: number; // 0.1..1
	umbrellaStrength: number; // 0..3
	transparent: boolean;
	pointerX: number;       // 0..1
	pointerY: number;       // 0..1
	isStatic: boolean;
	reducedMotion: boolean;
	rootRef: React.RefObject<HTMLElement>;
};

const CHARSETS: Record<string, string> = {
	digits: '0123456789',
	hex: '0123456789ABCDEF',
	// A spread of katakana — the classic look, without the green.
	katakana: 'アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヲンabc',
	symbols: '+-*/=<>{}[]()#$%&@!?:;~^|\\',
};

function parseHex(hex: string): [number, number, number] {
	const h = String(hex || '').replace('#', '');
	const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
	const n = parseInt(full || '000000', 16);
	return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

// Frame-rate-independent exponential approach.
function approach(cur: number, target: number, dt: number, response = 0.18) {
	const k = 1 - Math.exp(-dt / Math.max(1e-3, response));
	return cur + (target - cur) * k;
}

// Small deterministic PRNG (mulberry32) so the field layout is stable across
// renders / SSR — no Math.random() in the scattered positions.
function mulberry32(seed: number) {
	let a = seed >>> 0;
	return function () {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/* Build a glyph atlas: lay the unique characters out in a square-ish grid on
   an offscreen canvas, one glyph per cell, and return a CanvasTexture plus the
   grid dimensions. Cells are square; glyphs are drawn centred with a glow so
   they read crisply against the dark background. */
function buildAtlas(
	THREE: any,
	chars: string[],
	fontFamily: string
): { texture: any; cols: number; rows: number; count: number } {
	const count = Math.max(1, chars.length);
	const cols = Math.ceil(Math.sqrt(count));
	const rows = Math.ceil(count / cols);
	const cell = 64; // px per glyph cell
	const cv = document.createElement('canvas');
	cv.width = cols * cell;
	cv.height = rows * cell;
	const ctx = cv.getContext('2d')!;
	ctx.clearRect(0, 0, cv.width, cv.height);
	ctx.textAlign = 'center';
	ctx.textBaseline = 'middle';
	const fam = fontFamily && fontFamily !== 'Inherit'
		? `"${fontFamily}", ui-monospace, monospace`
		: 'ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace';
	ctx.font = `600 ${Math.floor(cell * 0.72)}px ${fam}`;
	// White glyphs — the per-instance colour is applied in the shader, so the
	// atlas stays a neutral luminance mask. A soft glow gives the glyph a halo
	// so near symbols bloom slightly.
	for (let i = 0; i < count; i++) {
		const c = chars[i];
		const cx = (i % cols) * cell + cell * 0.5;
		const cy = Math.floor(i / cols) * cell + cell * 0.5;
		ctx.shadowColor = 'rgba(255,255,255,0.85)';
		ctx.shadowBlur = cell * 0.16;
		ctx.fillStyle = '#ffffff';
		ctx.fillText(c, cx, cy);
		// Second pass with no shadow for a crisp core.
		ctx.shadowBlur = 0;
		ctx.fillText(c, cx, cy);
	}
	const texture = new THREE.CanvasTexture(cv);
	// Canvas2D is Y-down; we author quad UVs to match (top row = V 0), so keep
	// flipY false to avoid an extra vertical flip that would mirror the glyphs.
	texture.flipY = false;
	texture.minFilter = THREE.LinearFilter; // NPOT-safe, no mipmaps
	texture.magFilter = THREE.LinearFilter;
	texture.generateMipmaps = false;
	texture.colorSpace = THREE.SRGBColorSpace;
	texture.needsUpdate = true;
	return { texture, cols, rows, count };
}

export default function RainStage(props: RainStageProps) {
	const canvasRef = React.useRef<HTMLCanvasElement | null>(null);

	// Live props read inside the rAF loop without re-subscribing the loop.
	const propsRef = React.useRef(props);
	propsRef.current = props;

	const stateRef = React.useRef<any>({
		ready: false,
		THREE: null,
		renderer: null,
		scene: null,
		camera: null,
		mesh: null,
		geometry: null,
		material: null,
		atlasTex: null,
		volumeW: 0,
		volumeH: 0,
		// Smoothed cursor in 0..1 viewport coords. Rest pose = off-centre right.
		cursorX: 0.66,
		cursorY: 0.4,
		lastT: 0,
		// Time we feed the shader. Frozen advance when static so the captured
		// frame is settled rather than mid-stream.
		shaderTime: 0,
		raycastPlane: null,
		resizeObserver: null as ResizeObserver | null,
		rafHandle: 0,
		// Scratch objects (allocate-once, mutate-in-place).
		_ndc: null,
		_ray: null,
		_hit: null,
	});

	const [ready, setReady] = React.useState(false);

	/* ── Three.js init ───────────────────────────────────────────────── */
	React.useEffect(() => {
		let cancelled = false;
		const canvas = canvasRef.current;
		if (!canvas) return;

		(async () => {
			let THREE: any;
			try {
				THREE = await import('three');
			} catch (err) {
				console.error('[data-rain-3d] three import failed:', err);
				return;
			}
			if (cancelled) return;

			const state = stateRef.current;
			state.THREE = THREE;

			const renderer = new THREE.WebGLRenderer({
				canvas,
				antialias: true,
				alpha: true,
				premultipliedAlpha: false,
				powerPreference: 'high-performance',
			});
			renderer.outputColorSpace = THREE.SRGBColorSpace;
			renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
			state.renderer = renderer;

			const scene = new THREE.Scene();
			scene.background = null;
			state.scene = scene;

			const camera = new THREE.PerspectiveCamera(55, 16 / 9, 0.1, 200);
			// Camera sits just in front of the volume looking down -Z. The
			// volume is centred at origin; we pull the camera back so the near
			// slab of glyphs rushes past close to the lens.
			camera.position.set(0, 0, 18);
			camera.lookAt(0, 0, 0);
			state.camera = camera;

			// Scratch vectors / ray for pointer projection.
			state._ndc = new THREE.Vector2();
			state._ray = new THREE.Raycaster();
			state._hit = new THREE.Vector3();
			// Plane at z=0 (mid-volume), facing the camera, for projecting the
			// pointer into world space.
			state.raycastPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);

			state.ready = true;
			state.lastT = performance.now();
			setReady(true);
		})();

		return () => {
			cancelled = true;
			const state = stateRef.current;
			if (state.rafHandle) cancelAnimationFrame(state.rafHandle);
			disposeField(state);
			if (state.atlasTex?.dispose) state.atlasTex.dispose();
			if (state.renderer?.dispose) state.renderer.dispose();
			state.ready = false;
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	/* ── Build / rebuild the instanced field ─────────────────────────── */
	// Rebuilt only when the topology actually changes (count or glyph set);
	// every style / colour / speed slider is a uniform mutation in the rAF.
	React.useEffect(() => {
		const state = stateRef.current;
		if (!state.ready) return;
		buildField(state, propsRef.current);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [ready, props.count, props.charset, props.customChars]);

	/* ── Resize observer ─────────────────────────────────────────────── */
	React.useEffect(() => {
		const state = stateRef.current;
		const root = props.rootRef?.current;
		if (!state.ready || !root) return;
		const apply = () => {
			const w = root.clientWidth || 1;
			const h = root.clientHeight || 1;
			state.renderer.setSize(w, h, false);
			state.camera.aspect = w / h;
			state.camera.updateProjectionMatrix();
		};
		const ro = new ResizeObserver(apply);
		ro.observe(root);
		state.resizeObserver = ro;
		apply();
		return () => { ro.disconnect(); state.resizeObserver = null; };
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [props.rootRef, ready]);

	/* ── Animation frame loop ────────────────────────────────────────── */
	React.useEffect(() => {
		const state = stateRef.current;
		if (!state.ready) return;
		const THREE = state.THREE;

		const tick = (now: number) => {
			state.rafHandle = requestAnimationFrame(tick);
			const dt = Math.min(0.05, Math.max(0, (now - state.lastT) / 1000));
			state.lastT = now;
			const p = propsRef.current;

			if (!state.material || !state.mesh) {
				state.renderer.render(state.scene, state.camera);
				return;
			}
			const u = state.material.uniforms;

			// Advance the shader clock. When static (none mode / reduced
			// motion), freeze it at a flattering settled offset so the captured
			// frame looks like a finished poster, not paused at t=0.
			if (p.reducedMotion || p.isStatic) {
				state.shaderTime = 12.7; // a settled, well-distributed frame
			} else {
				state.shaderTime += dt * p.fallSpeed;
			}
			u.u_time.value = state.shaderTime;
			u.u_fallSpeed.value = p.fallSpeed;
			u.u_glyphSize.value = p.glyphSize;

			// Camera FOV slider.
			if (Math.abs(state.camera.fov - p.cameraFov) > 1e-3) {
				state.camera.fov = p.cameraFov;
				state.camera.updateProjectionMatrix();
			}

			// Colours.
			const sym = parseHex(p.symbolColor);
			const head = parseHex(p.headColor);
			const bg = parseHex(p.backgroundColor);
			u.u_symbolColor.value.setRGB(sym[0], sym[1], sym[2]);
			u.u_headColor.value.setRGB(head[0], head[1], head[2]);
			u.u_bgColor.value.setRGB(bg[0], bg[1], bg[2]);
			u.u_transparent.value = p.transparent ? 1 : 0;

			// Depth / fog.
			u.u_depthRange.value = p.depthRange;
			u.u_fogDensity.value = p.fogDensity;

			// ── Pointer → world projection (umbrella centre) ────────────
			// Smooth the cursor for buttery tracking. Rest pose off-centre right.
			const tx = p.isStatic ? 0.66 : p.pointerX;
			const ty = p.isStatic ? 0.40 : p.pointerY;
			state.cursorX = approach(state.cursorX, tx, dt, 0.12);
			state.cursorY = approach(state.cursorY, ty, dt, 0.12);

			// NDC: x in [-1,1], y flipped (input is top-left origin).
			state._ndc.set(state.cursorX * 2 - 1, -(state.cursorY * 2 - 1));
			state._ray.setFromCamera(state._ndc, state.camera);
			// Intersect the mid-volume plane (z=0) to get a world cursor point.
			const hit = state._ray.ray.intersectPlane(state.raycastPlane, state._hit);
			if (hit) {
				u.u_pointer.value.set(hit.x, hit.y, hit.z);
			}
			// World-space umbrella radius: scale the 0..1 slider by the volume
			// half-width so radius 1.0 spans the whole field width.
			const worldRadius = Math.max(0.1, p.umbrellaRadius) * state.volumeW * 0.5;
			u.u_umbRadius.value = worldRadius;
			u.u_umbStrength.value = p.umbrellaStrength;

			// Background clear.
			u.u_time.value = state.shaderTime;
			state.renderer.setClearColor(
				new THREE.Color(bg[0], bg[1], bg[2]),
				p.transparent ? 0 : 1
			);
			state.renderer.render(state.scene, state.camera);
		};

		state.lastT = performance.now();
		state.rafHandle = requestAnimationFrame(tick);
		return () => { cancelAnimationFrame(state.rafHandle); state.rafHandle = 0; };
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [ready]);

	return (
		<canvas
			ref={canvasRef}
			className="crazygl-datarain-canvas"
			aria-hidden="true"
		/>
	);
}

/* ─── Field build + dispose ──────────────────────────────────────────── */

function disposeField(state: any) {
	if (state.mesh && state.scene) state.scene.remove(state.mesh);
	if (state.geometry?.dispose) state.geometry.dispose();
	if (state.material?.dispose) state.material.dispose();
	state.mesh = null;
	state.geometry = null;
	state.material = null;
}

function buildField(state: any, p: RainStageProps) {
	const THREE = state.THREE;

	// Resolve the glyph set.
	const raw = (p.customChars && p.customChars.trim().length > 0)
		? p.customChars
		: (CHARSETS[p.charset] || CHARSETS.hex);
	// Unique characters, drop whitespace.
	const seen: Record<string, boolean> = {};
	const chars: string[] = [];
	for (const ch of Array.from(raw)) {
		if (ch === ' ' || ch === '\n' || ch === '\t') continue;
		if (!seen[ch]) { seen[ch] = true; chars.push(ch); }
	}
	if (chars.length === 0) chars.push('0');

	// (Re)build the atlas. Dispose the old one first.
	if (state.atlasTex?.dispose) state.atlasTex.dispose();
	const atlas = buildAtlas(THREE, chars, '');
	state.atlasTex = atlas.texture;

	// Dispose the previous field.
	disposeField(state);

	const count = Math.max(50, Math.floor(p.count));

	// Volume dimensions. Width/height derived to roughly fill a 16:9-ish frame
	// at the default camera distance; depth is driven live by depthRange but we
	// reserve a generous span here so the slider has room without a rebuild.
	const volumeW = 34;
	const volumeH = 24;
	state.volumeW = volumeW;
	state.volumeH = volumeH;

	// Base quad — a unit plane centred at origin, UVs spanning the FULL atlas;
	// the per-instance glyph cell is selected in the vertex shader by writing
	// vUv into the right cell. We author UVs 0..1 top-left origin to match the
	// flipY=false atlas (top row of canvas = V 0).
	const base = new THREE.PlaneGeometry(1, 1);
	// PlaneGeometry default UVs put V=1 at the TOP. Our atlas (flipY=false) has
	// the glyph's top row at V=0, so flip V here once: V -> 1 - V.
	const uvAttr = base.attributes.uv;
	for (let i = 0; i < uvAttr.count; i++) {
		uvAttr.setY(i, 1 - uvAttr.getY(i));
	}
	uvAttr.needsUpdate = true;

	const geometry = new THREE.InstancedBufferGeometry();
	geometry.index = base.index;
	geometry.attributes.position = base.attributes.position;
	geometry.attributes.uv = base.attributes.uv;
	geometry.instanceCount = count;

	// Per-instance attributes.
	const aOffset = new Float32Array(count * 3);   // x, z, fallPhase (0..1)
	const aMeta = new Float32Array(count * 3);      // speedJitter, glyphIndex, sizeJitter
	const rng = mulberry32(0x9e3779b1 ^ (count * 2654435761));
	const cols = atlas.cols;
	const rows = atlas.rows;
	const glyphCount = atlas.count;
	for (let i = 0; i < count; i++) {
		const x = (rng() - 0.5) * volumeW;
		const z = (rng() - 0.5) * volumeW; // depth spread; clamped to depthRange in shader
		const phase = rng();               // start position within the column
		aOffset[i * 3 + 0] = x;
		aOffset[i * 3 + 1] = z;
		aOffset[i * 3 + 2] = phase;
		// Speed jitter so columns don't fall in lockstep.
		const speedJ = 0.55 + rng() * 0.9;
		const glyph = Math.floor(rng() * glyphCount);
		const sizeJ = 0.7 + rng() * 0.7;
		aMeta[i * 3 + 0] = speedJ;
		aMeta[i * 3 + 1] = glyph;
		aMeta[i * 3 + 2] = sizeJ;
	}
	geometry.setAttribute('aOffset', new THREE.InstancedBufferAttribute(aOffset, 3));
	geometry.setAttribute('aMeta', new THREE.InstancedBufferAttribute(aMeta, 3));
	state.geometry = geometry;

	const sym = parseHex(p.symbolColor);
	const head = parseHex(p.headColor);
	const bg = parseHex(p.backgroundColor);

	const material = new THREE.ShaderMaterial({
		uniforms: {
			u_atlas: { value: atlas.texture },
			u_time: { value: 12.7 },
			u_fallSpeed: { value: p.fallSpeed },
			u_glyphSize: { value: p.glyphSize },
			u_atlasCols: { value: cols },
			u_atlasRows: { value: rows },
			u_glyphCount: { value: glyphCount },
			u_volumeH: { value: volumeH },
			u_depthRange: { value: p.depthRange },
			u_fogDensity: { value: p.fogDensity },
			u_symbolColor: { value: new THREE.Color(sym[0], sym[1], sym[2]) },
			u_headColor: { value: new THREE.Color(head[0], head[1], head[2]) },
			u_bgColor: { value: new THREE.Color(bg[0], bg[1], bg[2]) },
			u_transparent: { value: p.transparent ? 1 : 0 },
			u_pointer: { value: new THREE.Vector3(0, 0, 0) },
			u_umbRadius: { value: p.umbrellaRadius * volumeW * 0.5 },
			u_umbStrength: { value: p.umbrellaStrength },
		},
		vertexShader: VERT,
		fragmentShader: FRAG,
		transparent: true,
		depthTest: true,
		depthWrite: false,
		// Additive over the dark background gives the rain its glow stacking;
		// near glyphs bloom where they overlap. With a transparent backdrop we
		// fall back to normal alpha so the rain composites cleanly onto the
		// host page (additive over arbitrary content reads as a wash).
		blending: p.transparent ? THREE.NormalBlending : THREE.AdditiveBlending,
	});
	state.material = material;

	const mesh = new THREE.Mesh(geometry, material);
	mesh.frustumCulled = false; // instances move in the shader; bbox is stale
	state.scene.add(mesh);
	state.mesh = mesh;
}

/* ─────────────────────────────────────────────────────────────────────────
   Shaders. NOTE: no backticks anywhere inside these template literals (not
   even in comments) — a backtick would terminate the literal. Reserved GLSL
   words (input, output, layout, sample, ...) are avoided as identifiers.
   ───────────────────────────────────────────────────────────────────────── */

const VERT = /* glsl */ `
	precision highp float;

	// Per-instance.
	attribute vec3 aOffset;  // x, z, fallPhase
	attribute vec3 aMeta;    // speedJitter, glyphIndex, sizeJitter

	uniform float u_time;
	uniform float u_fallSpeed;
	uniform float u_glyphSize;
	uniform float u_atlasCols;
	uniform float u_atlasRows;
	uniform float u_volumeH;
	uniform float u_depthRange;
	uniform vec3  u_pointer;     // world-space cursor on the mid-volume plane
	uniform float u_umbRadius;   // world units
	uniform float u_umbStrength;

	varying vec2  vUv;
	varying float vDepth;        // view-space depth into the screen ( -mvPosition.z )
	varying float vLead;         // 0..1 how 'fresh' / leading this glyph is

	void main() {
		float speedJ = aMeta.x;
		float glyphIndex = aMeta.y;
		float sizeJ = aMeta.z;

		// ── Vertical fall ──────────────────────────────────────────────
		// Continuous fall: total distance travelled, wrapped to the volume
		// height so glyphs re-emit at the top. fract gives the 0..1 column
		// phase; map to [+H/2 .. -H/2] (top to bottom).
		float halfH = u_volumeH * 0.5;
		float travel = u_time * speedJ + aOffset.z;
		float ph = fract(travel);                 // 0 at top, 1 at bottom
		float y = halfH - ph * u_volumeH;         // world Y
		// 'Lead' brightness: freshest at the top of each fall (ph small),
		// trailing off as it descends — the hot leading edge of the stream.
		vLead = 1.0 - smoothstep(0.0, 0.55, ph);

		// ── Base world position of this instance ───────────────────────
		// Depth (z) is clamped to the depthRange so the slider controls how far
		// back the field runs without a geometry rebuild. aOffset.y holds z.
		float zSpread = clamp(aOffset.y, -0.5 * u_depthRange, 0.5 * u_depthRange);
		vec3 ipos = vec3(aOffset.x, y, zSpread);

		// ── Umbrella repulsion ─────────────────────────────────────────
		// Push instances radially outward in the X/Z plane around the cursor,
		// with a smooth falloff inside the radius. Easing back to rest as the
		// instance leaves the radius gives the 'curve around it' read.
		vec2 toC = ipos.xz - u_pointer.xz;
		float dist = length(toC + 1e-4);          // guard divide-by-zero
		float infl = 1.0 - smoothstep(0.0, u_umbRadius, dist);
		// Quadratic ease so the core is firmly cleared, edges feather.
		infl = infl * infl;
		float push = infl * u_umbStrength * u_umbRadius * 0.9;
		vec2 dir = toC / dist;
		ipos.xz += dir * push;

		// ── Camera-facing billboard ────────────────────────────────────
		// Build the quad in view space so each glyph faces the camera flat-on.
		float baseSize = u_glyphSize * sizeJ;
		vec4 mvCenter = modelViewMatrix * vec4(ipos, 1.0);
		// position.xy is the unit-quad corner in [-0.5, 0.5].
		mvCenter.xy += position.xy * baseSize;
		vDepth = -mvCenter.z;

		gl_Position = projectionMatrix * mvCenter;

		// ── Atlas cell UV ──────────────────────────────────────────────
		// Map the quad's [0..1] uv into the glyph's cell within the atlas grid.
		float gi = clamp(glyphIndex, 0.0, u_atlasCols * u_atlasRows - 1.0);
		float col = mod(gi, u_atlasCols);
		float row = floor(gi / u_atlasCols);
		vec2 cellSize = vec2(1.0 / u_atlasCols, 1.0 / u_atlasRows);
		vUv = (vec2(col, row) + uv) * cellSize;
	}
`;

const FRAG = /* glsl */ `
	precision highp float;

	uniform sampler2D u_atlas;
	uniform float u_depthRange;
	uniform float u_fogDensity;
	uniform vec3  u_symbolColor;
	uniform vec3  u_headColor;
	uniform vec3  u_bgColor;
	uniform float u_transparent;

	varying vec2  vUv;
	varying float vDepth;
	varying float vLead;

	void main() {
		// Glyph mask from the atlas (white glyph on transparent cell).
		vec4 tex = texture2D(u_atlas, vUv);
		float mask = tex.a * tex.r;     // luminance * coverage
		if (mask < 0.01) discard;

		// ── Colour: blend symbol -> head by 'lead' freshness ───────────
		// The leading (freshest) glyphs read as a hot near-white head; the
		// trailing body settles to the cooler symbol tint.
		float lead = vLead;
		vec3 col = mix(u_symbolColor, u_headColor, lead);
		// Extra punch on the very leading edge for the hot 'cursor' of each fall.
		col += u_headColor * lead * lead * 0.45;

		// ── Depth fog (Beer-Lambert: I = I0 * exp(-sigma * d)) ─────────
		// Normalise depth across the configured range so fogDensity reads the
		// same regardless of how deep the field runs. depthRef is the back of
		// the usable volume relative to the camera.
		float depthRef = u_depthRange * 0.5;
		float d = max(0.0, vDepth - 4.0);                 // start fogging past the near slab
		float sigma = u_fogDensity * 1.6 / max(1.0, depthRef);
		float fog = exp(-sigma * d);                       // 1 near -> 0 far

		// ── Near-plane fade (mandatory) ────────────────────────────────
		// As a glyph approaches the lens it would explode in size; dissolve it
		// in over the nearest slab instead of hard-clipping the near plane.
		float nearFade = smoothstep(2.0, 7.5, vDepth);

		float alpha = mask * fog * nearFade;
		// A touch brighter on the very nearest glyphs for the 'rush past' pop.
		col *= mix(1.0, 1.35, nearFade);

		if (u_transparent > 0.5) {
			// Composite onto the host page: premultiply-safe straight alpha,
			// fog fades toward transparent rather than toward the bg colour.
			gl_FragColor = vec4(col, alpha);
		} else {
			// Over the dark backdrop: fade the colour toward the bg with fog so
			// far glyphs melt into the depth, then carry alpha for additive glow.
			vec3 outCol = mix(u_bgColor, col, fog);
			gl_FragColor = vec4(outCol, alpha);
		}
	}
`;
