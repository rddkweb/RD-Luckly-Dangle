# Lucky Dangle 🐾

A Windows desktop companion pet that hangs around on your screen. Features rich animations, full image format support, and deep user interactions.

## Run

1. Install **Node.js LTS**
2. In this folder:
   ```
   npm install
   npm start
   ```
3. Build installer:
   ```
   npm run build
   ```

## Features

### Image Format Support
- **All common formats**: SVG, PNG, JPG/JPEG, GIF, WebP, BMP, ICO, APNG, AVIF
- Drag-and-drop or click-to-browse upload
- Live preview before applying
- GIF animations play in the pet window

### Animations
- 8 base animations: **Swing, Bounce, Float, Pulse, Wiggle, Nod, Spin, Wobble**
- Reaction animations triggered by interaction: **Shake, Jump, Punch, Celebrate, Confused**
- Adjustable speed (0.2x–3x)
- Adjustable size (60px–300px)
- Position setting — snap to any screen corner, center, or set exact X/Y in Settings
- Real Verlet rope physics — a constraint-solved chain of rope segments hangs the pet (Hangly-style); each texture is a *different set of solver values* (segment count, stiffness, drag, gravity), not just a different picture
- Wooden knot at the end of the rope that follows the physics
- Idle efficiency — the rope physics ticker sleeps when the pet settles, so an idle pet costs almost nothing
- Bouncy reactions — every click pops with squash & stretch; double-click triggers a spinning celebration with a ring burst and hearts; right-click head-tilts in confusion
- Customize the rope — 6 colors and 4 textures (Braided, Cord, Twist, Ribbon) in Settings, applied with a smooth flash
- Settings window auto-fits small screens; smooth floating glide between screen positions

### User Interactions
| Action | Result |
|---|---|
| **Click pet** | Random reaction + particle burst |
| **Double-click** | Spinning celebration + ring burst + star & heart waves |
| **Right-click** | Confused head-tilt + question ring |
| **Drag pet** | Reposition — reactively squashes/stretches with drag speed & direction and shakes when you jiggle it; the rope follows and drags; springs back on release; a fast flick whips it into a big swing |
| **Hover** | Brightens + shadow effect |
| **Idle dangle** | Real rope physics — gravity + inertia drive a constraint-solved rope; yanking or flicking the rope makes it swing, then it settles silently and the physics sleeps |

### Mood System
- 10 moods: Happy, Excited, Sleepy, Love, Silly, Cool, Hungry, Angry, Confused, Dancing
- Mood bubble appears above the pet
- Mood can be set from the settings panel or via interactions

### Built-in Characters
- 8 preset characters: Kitty, Doggo, Bunny, Bear, Penguin, Owl, Frog, Ghost

### System Integration
- Transparent, always-on-top, frameless window
- Pet window buttons (top-right): **─ minimize to tray**, **⚙ settings**, **✕ quit**
- Single-instance lock — launching again never creates a duplicate pet
- System tray icon with quick menu (Show Pet / Settings / Reset Position / Quit)
- Click-through mode (the pet ignores mouse clicks on the rest of your desktop, but is still grabbable — hovering the pet temporarily turns the interaction back on so you can drag it)
- Works with Windows taskbar / desktop

## Controls

- **Pet window**: drag to move, click/double-click/right-click to interact
- **Tray icon**: right-click for menu, click to open settings
- **Settings panel**: opens automatically on launch

## Project Structure

```
main.js      - Electron main process (windows, tray, single-instance, IPC)
preload.js   - Secure IPC bridge
pet.html     - The desktop pet renderer
index.html   - Settings panel
assets/      - App icon (icon.ico, icon-*.png)
```

## Troubleshooting

### Duplicate pets on re-launch
Lucky Dangle uses a **single-instance lock**. If the app is already running,
launching it again will simply focus the existing pet and settings window —
it will never create a duplicate. If you still see two pets, check for multiple
old copies of the app running in Task Manager (End each `danglepet`/`Lucky Dangle`
process), then launch again.

### SmartScreen / antivirus ("unknown publisher")
Windows SmartScreen and antivirus engines (K7, etc.) warn on **unsigned**
installers. win-builders rewrite the `.exe` resources to embed the icon and
version info, and one-click NSIS installers are auto-flagged — this is normal
for every unsigned Electron app and does **not** mean the file is malicious.

The fork to permanently fix this is code signing, and Lucky Dangle uses the
**SignPath Foundation** program (free signing for open-source projects).

#### SignPath Foundation setup (one-time)
1. Push this project to a **GitHub repository** (the program requires a public
   OSS repo with a license file — `LICENSE` is included).
2. Apply to the foundation and wait for onboarding: they create a SignPath
   **organization**, **project**, and **signing policy** for the repo, and grant
   a code-signing certificate for release builds.
3. Install the **SignPath GitHub App** and allow it access to the repository.
4. Add these repository **secrets** (Settings → Secrets and variables →
   Actions), matching `.github/workflows/build-and-sign.yml`:
   - `SIGNPATH_API_TOKEN`
   - `SIGNPATH_ORGANIZATION_ID`
   - `SIGNPATH_PROJECT_SLUG`
   - `SIGNPATH_SIGNING_POLICY_SLUG`

Once the secrets exist, run **Build and Sign** from the Actions tab (or push
a `v*` tag). The workflow builds the installer, uploads it to SignPath, waits
for signing, and downloads the signed `.exe` — a future tag can attach it to a
GitHub Release automatically.

> Note: even a signed app shows SmartScreen the first few hundred times it is
> downloaded — certificate reputation is earned with real usage, so keep
> releasing signed builds.

Until then, the pragmatic workarounds for an unsigned build:
```
npm run build          # NSIS installer
npm run build:portable # single portable .exe (often the safest for AVs)
```
Install via "More info → Run anyway", or add an exclusion for the app folder.
Running from source (`npm start`) uses the standard Electron binary and is
generally accepted by AVs.

### Pet hidden / not visible
- The pet hides to the **tray** when you press the `─` button. Click the tray
  icon to bring it back.
- Use the **minimize** button on the top-right of the pet window for the same.
- If click-through mode is on, turn it off from the settings panel.