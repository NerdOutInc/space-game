# Zenith Space Program

A Kerbal Space Program–inspired rocketry game that runs in the browser.
Build a rocket from stackable parts, launch it off the planet Gaia, and try
to reach a stable orbit — then push on to the moon Luna, or further.

Built with **TypeScript + Three.js + Vite**. No game engine, no backend.

## Running

```bash
npm install
npm run dev      # opens on http://localhost:5173
```

## How to play

1. **VAB (Vehicle Assembly)** — click parts to stack them (top → bottom).
   A valid rocket needs a capsule and at least one engine. Decouplers split
   the stack into stages; the parts *below* a decoupler are dropped when you
   stage. The panel on the right shows per-stage Δv and TWR. "Load sample
   rocket" gives you a proven two-stage orbital launcher.
2. **Launch** — press `Space` to ignite. Once your thrust exceeds gravity,
   you're flying.
3. **Fly to orbit** — climb, then pitch east (`W`) starting around 8–10 km
   into a gravity turn. Watch apoapsis on the HUD; cut the engine (`X`) when
   Ap reads ~80 km, coast to Ap, then burn prograde until periapsis rises
   above the atmosphere (70 km). Orbit!
4. **Map view** (`M`) — see your conic orbit, apoapsis/periapsis markers,
   and every body in the Helios system. Use time warp (`,` / `.`) to skip
   the boring parts (rails warp above 4× requires coasting in vacuum).
5. **Come home** — burn retrograde until Pe dips into the atmosphere, and
   pop the parachute (`P`) below 40 km. Touchdowns under ~12 m/s survive.

### Controls

| Key | Action |
| --- | --- |
| `Space` | Ignite engines / activate next stage |
| `Shift` / `Ctrl` | Throttle up / down (`Z` full, `X` cut) |
| `W`/`S`, `A`/`D`, `Q`/`E` | Pitch, yaw, roll |
| `T` | Toggle SAS (rotation damping) |
| `,` / `.` | Time warp down / up |
| `M` | Toggle map view |
| `P` | Deploy parachute |
| `R` | Revert to launch |
| `Esc` | Back to the VAB |
| Mouse drag / scroll | Camera |

## The Helios system

KSP-style scaled-down worlds (small radii, low orbital speeds — orbit in
minutes, not hours):

| Body | Role | Radius | Notes |
| --- | --- | --- | --- |
| Helios | star | 261,600 km | don't land here |
| Ember | inner planet | 700 km | thick purple atmosphere |
| **Gaia** | home planet | 600 km | 70 km atmosphere, 6 h day, 9.81 m/s² |
| **Luna** | Gaia's moon | 200 km | ~2,430 km SOI — your first target |
| Ares | outer planet | 320 km | thin atmosphere, red |

## How it works

- **Physics** (`src/sim/simulation.ts`) — single-body Newtonian gravity with
  patched-conic sphere-of-influence transitions (Gaia → Luna → interplanetary).
  Semi-implicit Euler integration under thrust/drag; exact universal-variable
  Kepler propagation (`src/math/kepler.ts`) for high time warp "on rails".
- **Atmosphere** — exponential density model, drag against the co-rotating
  air mass, Isp that degrades at sea level (vacuum engines are bad down low).
- **Rendering** (`src/scenes/flight.ts`) — vessel-centered floating origin so
  600 km planets and 2 m capsules coexist without float32 jitter; procedural
  canvas planet textures; a separate scaled scene for the map view.
- **Vessel** (`src/vessel/`) — stack of parts split into stages by
  decouplers; per-stage fuel pooling, SRBs carry their own propellant;
  Tsiolkovsky Δv readouts in the VAB.

## Stretch ideas

- Maneuver nodes and transfer-window hints for Luna/Ember/Ares trips
- Radial boosters and free-form part attachment
- Landing legs, terrain height variation, surface scatter
- Persistent save / multiple simultaneous flights
- Crew portraits and a proper navball
