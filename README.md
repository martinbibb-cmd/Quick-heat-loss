# Quick Heat Loss Sketch

A standalone Progressive Web App (PWA) for fast, first-pass whole-house heat loss estimation.

## What it does

1. **Sketch** the house perimeter by clicking corner points on a gridded canvas
2. **Set** a handful of building assumptions (storeys, wall construction, loft insulation, glazing, floor type, dwelling type)
3. **Get** an instant whole-house design heat loss in kW — plus a full geometry summary and element-by-element breakdown

Designed for surveyors and heat-pump assessors who need a credible order-of-magnitude figure in under a minute, without typing geometry into a form.

## Features

- Top-down perimeter sketch with snap-to-½-metre grid
- Real-time edge-length labels and scale bar
- Zoom (scroll wheel / pinch) and pan (Alt+drag / two-finger drag)
- Drag existing corner points to refine the shape
- Heat loss breakdown: walls · glazing · roof/loft · floor · ventilation
- Offline-ready via service worker
- Installable as a home-screen app (PWA)

## Calculation method

The app uses a simplified shell model:

```
Fabric heat loss  = Σ (area × U-value) × ΔT
Ventilation loss  = volume × ACH × 0.33 × ΔT
Total design loss = fabric + ventilation
```

Design temperature difference `ΔT = 20 °C` (indoor 21 °C / outdoor 1 °C).  
Air changes per hour `ACH = 0.75` (typical UK existing dwelling).

This is a first-pass estimate with ±25–40 % accuracy. It is intended for early-stage sizing only — not for formal heat-loss reports or MCS calculations.

## Running locally

No build step required. Serve the root directory with any static file server:

```bash
npx serve .
# or
python3 -m http.server 8080
```

Then open `http://localhost:8080` in a browser.

## File structure

```
index.html        App shell
styles.css        Responsive styles (tablet-first)
app.js            Canvas drawing engine + heat loss calculation
manifest.json     PWA manifest
sw.js             Service worker (offline cache)
icon.svg          App icon
icon-maskable.svg Maskable app icon for Android
```
