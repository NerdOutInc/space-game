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

## Deploying to GitHub Pages

Pushes to `main` automatically build and deploy the Vite app to GitHub Pages
using the repository path (`/space-game/`).

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
| `G` | Toggle the ascent autopilot (target altitude set next to the AUTO button) |
| `` ` `` | Debug panel — teleport into a circular orbit of any body |
| `,` / `.` | Time warp down / up |
| `M` | Toggle map view |
| `P` | Deploy parachute |
| `R` | Revert to launch |
| `Esc` | Pause menu (resume · revert · recover · back to VAB · terminate) |
| Mouse drag / scroll | Camera |

### Navball

The ball at the bottom-center shows your attitude relative to the local
horizon: blue is sky, brown is ground, letters are compass headings
(launch east — `HDG 090°`). The yellow wings are your nose; ○ is prograde,
⊗ is retrograde. HDG/PIT readouts sit above the ball.

### Multiple flights

Leaving a flight (Esc → *Return to VAB*) keeps the vessel on rails: it
coasts, crosses SOIs, and stays exactly where physics says while you build
the next rocket. The **Mission Control** panel in the VAB lists every
active flight — click *FLY* to jump back aboard. Landed vessels on Gaia can
be *recovered* from the pause menu.

### Autopilot

Press `G` on the pad and the ship flies itself to orbit: ignition, an
east-facing gravity turn, staging on flameout, a time-warped coast, and a
circularization burn timed around apoapsis (Kepler time-to-Ap plus an
estimated burn duration, starting half the burn early). The sample rocket
reaches ~100 × 97 km against a 100 km target. Set a different target
altitude in the box next to the AUTO button. Watch the navball while it
flies — that profile is exactly what you should imitate by hand.

### Sound & music

Rocket engine audio follows your throttle; ambient music changes between
the menu/flight ("cosmic glow") and the VAB ("dunes"). Volume sliders live
on the main menu and in the pause menu (Esc); settings persist. Audio
credits: freesound community.

### Game modes

New games choose **Science Mode** (career: milestones earn ✦ to unlock
parts) or **Freedom Mode** (everything available from the start). Every new
game starts deterministically at the same coastal plateau at **dawn** — the
sun sits on the eastern horizon at T-0 and rises as Gaia spins.

### Docking

Put a **D-1 Magnetic Dock** on TOP of two craft, bring the ports within a
couple of meters nose-first and slow (< 1.5 m/s), and the magnets pull,
align, and capture. Docked pairs fly as one (combined mass; the partner
rides along through SOI changes and saves). `U` undocks with a gentle push
and a cooldown so the magnets don't immediately re-grab. First docking is
worth +80 ✦. Since the dock takes the top slot, mount recovery parachutes
radially (☂+ on capsule/tank/dock stack rows).

### Autopilot programs (MechJeb-lite)

The HUD's program row targets any body orbiting your current primary or
any vessel in your SOI:

- **ASCENT** — gravity turn to a circular parking orbit at the chosen altitude
- **TRANSFER** — Hohmann transfer: waits for the phase window, burns,
  coasts (auto-warp), corrects a too-low arrival periapsis, and captures
  into a closed orbit at the target body
- **RENDEZVOUS** — phased intercept of another vessel, velocity matching,
  and a proportional approach to ~250 m
- **DOCK** — rendezvous plus a nose-first port approach until the magnets take over

All programs stage automatically, ignite engines when they need thrust,
and manage time warp themselves.

### Reentry heat & parachute physics

Flying fast through atmosphere heats the skin (~ρ·v³ — watch the TEMP
readout). Past ~1100 K, parts start burning off the end that faces the
airflow; lose the capsule and the flight is over. The **AB-7 Heat Shield**
soaks up reentry heat when it leads the airflow (hold retrograde so it
does) and tolerates ~2600 K — a must for steep or high-speed entries, with
a plasma sheath to show you're committed. Parachutes now inflate over a
few seconds, tear off above ~18 kPa of dynamic pressure, and **armed**
chutes wait until the air is survivable (subsonic and below ~12 kPa)
before popping — so arm them and forget them.

### Career: science & unlocks

Exploration firsts earn **science** (✦): breaking 10 km, reaching space,
orbiting, entering new spheres of influence, landing on other worlds, and
recovering a spacefaring vessel. Spend it in the VAB to unlock the solid
booster, the big tank, and the vacuum engine. You start with just enough
hardware for a suborbital hop — fly it, recover it, and buy your way to
orbit. Progress **saves automatically** (universal time, every vessel in
flight, science, and unlocks) and the main menu offers Continue / New Game.

### Terrain & water

Every landable world has procedural heightmap terrain from a seeded noise
field — the same function drives the rendered mesh, the surface texture
(seabeds, beaches, snow lines), and ground collision, so what you see is
what you land on. Ocean worlds render a translucent water surface at the
datum over a displaced seabed, so depth reads through the shallows.
Gaia and Ember have seas (splashdowns are gentler than mountainsides);
Luna and Ares are all rock. Below 5 km the HUD altitude switches to height
above ground (AGL). The launch site sits on a flattened plateau on dry
land, found automatically on the sunlit side.

### Staging & side boosters

Space walks a KSP-style sequence — ignite → jettison spent boosters →
decouple (auto-igniting the next stage) → **arm the parachute** (it then
pops itself in atmosphere below 40 km while descending, so recovery is
just part of the staging). The `␣` chip above the throttle always shows
what the next press will do, and the VAB lists the full stage sequence.
Tanks can carry 2 or 4 radial **Anvil side boosters** (◎+ button on the
stack row) once the Anvil is unlocked. The VAB camera rotates (drag) and
zooms (scroll), and the parts palette is grouped by category.

### Debug tools

Press `` ` `` in flight to open the debug panel: pick any body and an
altitude and the active vessel teleports into a perfect circular orbit
(clamped above the atmosphere) — handy for testing moons and planets
without flying the whole transfer. There's also a `window.__step(seconds)`
console hook that advances the simulation deterministically.

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
