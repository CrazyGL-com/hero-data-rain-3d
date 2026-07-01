import * as React from 'react';
import CrazyGLWrapper, {
	useContent,
	useHeroReady,
	type HeroComponentProps,
} from '@crazygl/core';
import metadata from './metadata.json';
import './style.css';

/* ─────────────────────────────────────────────────────────────────────────
   Data Rain 3D — "Streams of data."

   Characters / digits / symbols fall through a real 3D PERSPECTIVE volume
   (not a flat Matrix sheet). A PerspectiveCamera makes near glyphs loom large
   and bright while far ones shrink and dissolve into exponential depth fog.
   The pointer projects into the volume and applies a smooth radial repulsion
   to nearby glyphs, so the falling stream curves AROUND the cursor like rain
   off an invisible umbrella.

   Default palette is a cool pale-blue-white on near-black — deliberately NOT
   the cliché green Matrix look.

   • Input mode is `pointer`. input.x / input.y are projected onto a plane in
     the middle of the rain volume; glyphs within `umbrellaRadius` of that
     point get pushed out radially in X/Z.
     In 'none' mode (or reducedMotion) the umbrella rests at a flattering
     off-centre position and ambient motion is frozen to a settled frame so
     the static capture / gallery thumbnail still reads as a finished poster.
   • The Three.js scene lives in RainStage.tsx and is React.lazy'd so the rest
     of the gallery isn't penalised with the three.js bundle weight.
   ───────────────────────────────────────────────────────────────────────── */

const RainStage = React.lazy(() => import('./RainStage'));

function DataRain3DHero(props: HeroComponentProps) {
	const {
		rootRef,
		input,
		reducedMotion,
		charset = 'symbols',
		customChars = '',
		count = 3000,
		fallSpeed = 0.1,
		glyphSize = 0.6,
		symbolColor = '#bcd8ff',
		headColor = '#ffffff',
		backgroundColor = '#04060a',
		depthRange = 40,
		fogDensity = 1.0,
		cameraFov = 55,
		umbrellaRadius = 0.4,
		umbrellaStrength = 1.4,
		transparent = false,
	} = props as any;

	const content = useContent(props as any);
	useHeroReady(props);

	const inputMode = input?.mode ?? 'pointer';
	const inputActive = !!input?.active;
	const inputX = typeof input?.x === 'number' ? input.x : 0.5;
	const inputY = typeof input?.y === 'number' ? input.y : 0.5;
	const isStatic = !!reducedMotion || inputMode === 'none' || !inputActive;

	const stageProps = {
		charset,
		customChars,
		count,
		fallSpeed,
		glyphSize,
		symbolColor,
		headColor,
		backgroundColor,
		depthRange,
		fogDensity,
		cameraFov,
		umbrellaRadius,
		umbrellaStrength,
		transparent: !!transparent,
		// Pointer state — the stage smooths internally so we don't need a ref.
		pointerX: inputX,
		pointerY: inputY,
		isStatic,
		reducedMotion: !!reducedMotion,
		rootRef,
	};

	return (
		<>
			<crazygl-stage />
			<React.Suspense fallback={null}>
				<RainStage {...(stageProps as any)} />
			</React.Suspense>
			{/* Soft side scrim so the heading copy stays legible over the busy
			    rain without dimming the effect itself. Hidden when the backdrop
			    is transparent (the host page controls contrast then). */}
			{!transparent ? (
				<crazygl-overlay
					aria-hidden="true"
					className="crazygl-datarain-scrim"
					style={{ ['--cgl-datarain-bg' as any]: backgroundColor }}
				/>
			) : null}
			<crazygl-content>
				<div className="crazygl-datarain-copy">{content.node}</div>
			</crazygl-content>
		</>
	);
}

export default function DataRain3D(props: any) {
	return <CrazyGLWrapper hero={DataRain3DHero} metadata={metadata as any} {...props} />;
}
export { metadata };
