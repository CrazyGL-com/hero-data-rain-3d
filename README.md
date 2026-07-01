<sub>*Hero made by [@ybouane](https://x.com/ybouane).*</sub>
<p align="center">
  <img src="https://crazygl.com/heroes/hero-data-rain-3d/banner-full.png" alt="Data Rain 3D" width="640">
</p>

# @crazygl/hero-data-rain-3d

Characters, digits and small symbols fall through a real 3D perspective volume. Near glyphs are large and bright, far ones shrink and dissolve into depth fog. Move the cursor and the falling stream curves around it, like rain hitting an invisible umbrella.

## Demo
[Data Rain 3D](https://crazygl.com/hero/data-rain-3d)

## Install

```bash
npm install @crazygl/hero-data-rain-3d
```

## Usage

```tsx
import DataRain3D from '@crazygl/hero-data-rain-3d';

export default function Page() {
  return (
    <DataRain3D
      heading="Streams of data."
      charset="symbols"
      count={3000}
      symbolColor="#bcd8ff"
    />
  );
}
```

## Customise

- **Rain** — `charset` (digits / hex / katakana / symbols), `customChars`, `count`, `fallSpeed`, `glyphSize`.
- **Color** — `symbolColor`, `headColor` (hot leading edge), `backgroundColor`.
- **Depth** — `depthRange`, `fogDensity`, `cameraFov`.
- **Pointer** — `umbrellaRadius`, `umbrellaStrength` (the clear zone the cursor carves).
- **Backdrop** — `transparent` to composite over your own page background.

## Best for

- Developer tools and AI/ML platforms.
- Cybersecurity, data-infrastructure and fintech landing pages.
- Any product wanting a "live data" feel without the tired Matrix green.



This hero is part of [CrazyGL](https://crazygl.com), a collection of production-ready WebGL, canvas, 3D, and typography effects. Every CrazyGL hero ships with an agent-ready `SKILL.md` file that helps developers and coding agents adapt the effect into custom landing pages and interactive experiences.
