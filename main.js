const { app, BrowserWindow, ipcMain, screen, Menu, Tray, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');

const APP_ID = 'com.rdlucklydangle.pet';

// The app name changed to "RD Luckly Dangle", which would move the userData
// folder (and lose the saved pet, position and settings). Pin it to the
// original folder so existing installs keep everything.
app.setPath('userData', path.join(app.getPath('appData'), 'danglepet'));

let petWin = null;
let settingsWin = null;
let tray = null;
let petVisible = true;
let clickThroughEnabled = false;
// Position lock: by default the anchor (and the window with it) never moves.
// Only while unlocked — via Settings, the pet's right-click menu or the tray —
// can the pet be dragged to a new position. Dragging while locked just tugs
// the pet on its rope.
let positionUnlocked = false;
// Ground shadow under the pet (on by default, toggle from Settings).
let groundShadowOn = true;
// Launch automatically when the user signs in to Windows (on by default).
let autoStartEnabled = true;
let mouseOverPet = false;
// True while a renderer drag is in flight (in either locked or unlocked mode).
// The mouse-ignore decision must NEVER flip the window to click-through
// mid-drag, or the pointer stops reaching us and the drag silently dies.
let dragActive = false;
let springTimer = null;
let ropeStyle = null;

let prefsFile = null;
let petImageFile = null;
let savedPrefs = {
  petImage: null,
  clickThrough: null,
  positionUnlocked: null,
  groundShadow: null,
  autoStart: null,
  anim: null,
  size: null,
  speed: null,
  ropeStyle: null,
  ropeLength: null,
  position: null,
  physics: null
};

// Defaults for the elastic rubber-rope physics system. The renderer sanitizes
// its own copy too, so either side staying in range is guaranteed no matter
// who sends what.
const DEFAULT_PHYSICS = {
  enabled: true,
  elasticity: 50,
  mass: 1,          // dangle mass
  ropeMass: 0.5,    // mass of the rope itself, shared across its nodes
  segments: 12,     // springs in the cord
  gravity: 9.81,
  damping: 35,
  maxStretch: 200,
  ropeSwing: true,
  ropeBounce: true,
  ropeBending: true,
  ropeCompression: true,
  preset: 'realistic'
};

function sanitizePhysics(p) {
  // Merge with the current saved physics first, so partial updates (e.g. just
  // toggling the enable switch) never wipe the other settings back to defaults.
  const prev = savedPrefs.physics && typeof savedPrefs.physics === 'object' ? savedPrefs.physics : {};
  const base = Object.assign({}, prev, (p && typeof p === 'object') ? p : {});
  const c = {};
  const f = (v, lo, hi, d) => (Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : d);
  const b = (v, d) => (typeof v === 'boolean' ? v : d);
  c.enabled = b(base.enabled, DEFAULT_PHYSICS.enabled);
  c.elasticity = f(base.elasticity, 0, 100, DEFAULT_PHYSICS.elasticity);
  c.mass = f(base.mass, 0.1, 10, DEFAULT_PHYSICS.mass);
  c.ropeMass = f(base.ropeMass, 0.1, 2, DEFAULT_PHYSICS.ropeMass);
  c.segments = Math.round(f(base.segments, 4, 30, DEFAULT_PHYSICS.segments));
  c.gravity = f(base.gravity, 0, 30, DEFAULT_PHYSICS.gravity);
  c.damping = f(base.damping, 0, 100, DEFAULT_PHYSICS.damping);
  c.maxStretch = f(base.maxStretch, 100, 400, DEFAULT_PHYSICS.maxStretch);
  c.ropeSwing = b(base.ropeSwing, DEFAULT_PHYSICS.ropeSwing);
  c.ropeBounce = b(base.ropeBounce, DEFAULT_PHYSICS.ropeBounce);
  c.ropeBending = b(base.ropeBending, DEFAULT_PHYSICS.ropeBending);
  c.ropeCompression = b(base.ropeCompression, DEFAULT_PHYSICS.ropeCompression);
  c.preset = typeof base.preset === 'string' ? base.preset : DEFAULT_PHYSICS.preset;
  return c;
}

function physicsConfig() {
  const p = savedPrefs.physics && typeof savedPrefs.physics === 'object' ? savedPrefs.physics : {};
  const c = sanitizePhysics(p);
  // Rope length lives in its own preference (it predates the physics panel) but
  // is part of the same physical rig, so it travels with the physics config and
  // the panel's Rope Length slider always mirrors the real rope.
  c.ropeLength = (typeof savedPrefs.ropeLength === 'number')
    ? Math.max(40, Math.min(160, savedPrefs.ropeLength))
    : 100;
  return c;
}

function broadcastPhysics() {
  const cfg = physicsConfig();
  if (petWin) petWin.webContents.send('physics', cfg);
  if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send('physics', cfg);
}

// Position is saved with a trailing debounce while dragging (many move events)
// and flushed on graceful quit, so "drag & leave" keeps the pet where you
// dropped it without writing to disk on every drag frame.
let posSaveTimer = null;
function persistPosition() {
  if (posSaveTimer) clearTimeout(posSaveTimer);
  posSaveTimer = setTimeout(() => {
    posSaveTimer = null;
    if (!petWin) return;
    const [px, py] = petWin.getPosition();
    savedPrefs.position = { x: px, y: py };
    savePrefs();
  }, 400);
}

// Restore a persisted, on-screen-validated start position (same clamps as move-pet).
function petStartPos() {
  const saved = savedPrefs.position;
  const hasPos = saved && typeof saved.x === 'number' && typeof saved.y === 'number';
  // Validate against the display the pet was last on, so multi-monitor layouts survive restarts.
  const d = hasPos
    ? screen.getDisplayMatching({ x: saved.x, y: saved.y, width: 300, height: 400 })
    : screen.getPrimaryDisplay();
  const wa = d.workArea;
  if (hasPos) {
    return {
      x: Math.min(wa.x + wa.width - 40, Math.max(wa.x - 60, saved.x)),
      y: Math.min(wa.y + wa.height - 60, Math.max(wa.y - 2000, saved.y))
    };
  }
  return { x: d.x + d.width - 340, y: d.y + 30 };
}

function loadPrefs() {
  try {
    const raw = fs.readFileSync(prefsFile, 'utf8');
    savedPrefs = Object.assign(savedPrefs, JSON.parse(raw));
  } catch (e) { /* first run or unreadable prefs */ }
  // Migrate pets saved by older versions (image embedded in prefs JSON) to
  // their own file, so frequent pref writes stay tiny.
  if (savedPrefs.petImage && typeof savedPrefs.petImage === 'string' && savedPrefs.petImage.startsWith('data:')) {
    try { fs.writeFileSync(petImageFile, savedPrefs.petImage); } catch (e) { /* keep in prefs */ }
  }
}

function readPetImage() {
  try {
    const raw = fs.readFileSync(petImageFile, 'utf8');
    return raw || null;
  } catch (e) { return null; }
}

function savePrefs() {
  try {
    // The pet image lives in its own file; keep the prefs JSON small so the
    // throttled position saves during drag never serialize megabytes of base64.
    const lean = Object.assign({}, savedPrefs, { petImage: undefined });
    fs.writeFileSync(prefsFile, JSON.stringify(lean));
  } catch (e) { /* ignoring write failures is fine */ }
}

const SUPPORTED_FORMATS = [
  '.svg', '.png', '.jpg', '.jpeg', '.gif', '.webp',
  '.bmp', '.ico', '.apng', '.avif'
];

// --- Single instance lock: prevents duplicate pets when launched again ---
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (petWin) {
      if (!petVisible) {
        petWin.showInactive();
        petVisible = true;
      }
      petWin.webContents.send('interaction', 'click');
    }
    createSettings();
  });
  app.whenReady().then(() => {
    app.setAppUserModelId(APP_ID);
    prefsFile = path.join(app.getPath('userData'), 'pet-prefs.json');
    petImageFile = path.join(app.getPath('userData'), 'pet-image.txt');
    const firstRun = !fs.existsSync(prefsFile);
    loadPrefs();
    clickThroughEnabled = !!savedPrefs.clickThrough;
    positionUnlocked = !!savedPrefs.positionUnlocked;
    groundShadowOn = savedPrefs.groundShadow !== false;
    autoStartEnabled = savedPrefs.autoStart === null ? true : !!savedPrefs.autoStart;
    applyAutoStart();
    savedPrefs.petImage = readPetImage();
    createPet();
    createTray();
    // Stay out of the way on everyday launches: just the pet. The settings
    // panel (and a welcome balloon) appears on first run and re-launches.
    if (firstRun) {
      createSettings();
      tray.displayBalloon({
        iconType: 'none',
        title: 'RD Luckly Dangle',
        content: 'Your pet is hanging around! Right-click the pet for its menu — Unlock Position to move it, Click-Through to stay out of your way.'
      });
    }
  });
}

function createPet() {
  const start = petStartPos();

  petWin = new BrowserWindow({
    width: 380,
    height: 400,
    x: start.x,
    y: start.y,
    frame: false,
    transparent: true,
    resizable: false,
    hasShadow: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    // Never steal focus from the app the user is working in; the pet reacts
    // to the mouse fine without being focusable.
    focusable: false,
    show: false,
    backgroundColor: '#00000000',
    icon: path.join(__dirname, 'assets', 'icon-256.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // The pet is (almost) always a background window; without this Electron
      // throttles its timers/rAF and the rope animation stutters.
      backgroundThrottling: false
    }
  });

  petWin.loadFile('pet.html');
  petWin.setAlwaysOnTop(true, 'floating');
  petWin.once('ready-to-show', () => petWin.showInactive());
  syncMouseIgnore();
  petWin.on('closed', () => { petWin = null; });

  petWin.webContents.on('did-finish-load', () => {
    petWin.webContents.send('animation', savedPrefs.anim || 'swing');
    petWin.webContents.send('clickthrough', clickThroughEnabled);
    petWin.webContents.send('position-lock', positionUnlocked);
    petWin.webContents.send('ground-shadow', groundShadowOn);
    if (savedPrefs.ropeStyle || ropeStyle) {
      petWin.webContents.send('rope-style', savedPrefs.ropeStyle || ropeStyle);
    }
    if (savedPrefs.ropeLength) petWin.webContents.send('rope-length', savedPrefs.ropeLength);
    petWin.webContents.send('physics', physicsConfig());
    if (savedPrefs.speed) petWin.webContents.send('speed', savedPrefs.speed);
    if (savedPrefs.size) petWin.webContents.send('size', savedPrefs.size);
    if (savedPrefs.petImage) petWin.webContents.send('pet-image', savedPrefs.petImage);
  });
}

function createSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.focus();
    return;
  }

  const wa = screen.getPrimaryDisplay().workArea;
  const height = Math.max(540, Math.min(860, wa.height - 48));
  const width = Math.min(600, wa.width - 40);

  settingsWin = new BrowserWindow({
    width,
    height,
    resizable: false,
    title: 'RD Luckly Dangle - Settings',
    backgroundColor: '#14112b',
    icon: path.join(__dirname, 'assets', 'icon-256.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  settingsWin.loadFile('index.html');
  settingsWin.on('closed', () => { settingsWin = null; });
}

function trayMenuTemplate() {
  return [
    {
      label: petVisible ? 'Hide Pet' : 'Show Pet',
      click: () => (petVisible ? hidePet() : showPet())
    },
    {
      label: 'Click-Through Mode',
      type: 'checkbox',
      checked: clickThroughEnabled,
      click: (item) => setClickThrough(item.checked, true)
    },
    {
      label: 'Unlock Position (Move Pet)',
      type: 'checkbox',
      checked: positionUnlocked,
      click: (item) => setPositionLock(item.checked, true)
    },
    {
      label: 'Start with Windows',
      type: 'checkbox',
      checked: autoStartEnabled,
      click: (item) => setAutoStart(item.checked)
    },
    {
      label: 'Settings',
      click: () => createSettings()
    },
    {
      label: 'Reset Position',
      click: () => resetPosition()
    },
    { type: 'separator' },
    {
      label: 'Quit RD Luckly Dangle',
      click: () => app.quit()
    }
  ];
}

function refreshTray() {
  if (tray) tray.setContextMenu(Menu.buildFromTemplate(trayMenuTemplate()));
}

function createTray() {
  const trayIcon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'icon-32.png'));
  tray = new Tray(trayIcon.resize({ width: 16, height: 16 }));
  tray.setToolTip('RD Luckly Dangle');

  tray.setContextMenu(Menu.buildFromTemplate(trayMenuTemplate()));
  tray.on('click', () => {
    if (petVisible) createSettings();
    else showPet();
  });
}

function broadcastVisibility() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.webContents.send('visibility', petVisible);
  }
}

function showPet() {
  if (!petWin) return;
  if (!petWin.isVisible()) {
    petWin.showInactive();
  }
  petVisible = true;
  refreshTray();
  broadcastVisibility();
  petWin.webContents.send('interaction', 'click');
}

function hidePet() {
  if (!petWin) return;
  petWin.hide();
  petVisible = false;
  refreshTray();
  broadcastVisibility();
}

function resetPosition() {
  const display = screen.getPrimaryDisplay();
  const { x, y, width } = display.bounds;
  if (petWin) {
    smoothMoveTo(x + width - (petWin.getSize()[0] + 40), y + 30, 320);
  }
}

// --- IPC Handlers ---

ipcMain.on('set-pet-image', (_, imageData) => {
  if (imageData) {
    // Big base64 payloads go to a dedicated file so prefs writes stay tiny.
    try { fs.writeFileSync(petImageFile, imageData); } catch (e) { /* keep in memory only */ }
    savedPrefs.petImage = imageData;
  }
  if (petWin) petWin.webContents.send('pet-image', imageData);
});

ipcMain.on('set-animation', (_, anim) => {
  savedPrefs.anim = anim;
  savePrefs();
  if (petWin) petWin.webContents.send('animation', anim);
});

ipcMain.on('set-size', (_, size) => {
  savedPrefs.size = size;
  savePrefs();
  if (petWin) {
    const wa = screen.getPrimaryDisplay().workArea;
    // Wide enough that a hard swing on a long rope can't clip the pet at the
    // window edges (the swing arc can span ~2x the rope length).
    const sw = Math.min(Math.max(340, size + 240), Math.max(240, wa.width - 24));
    const sh = Math.min(Math.max(380, size + 250), Math.max(300, wa.height - 24));
    petWin.setSize(sw, sh);
    petWin.webContents.send('size', size);
  }
});

ipcMain.on('set-speed', (_, v) => {
  savedPrefs.speed = v;
  savePrefs();
  if (petWin) petWin.webContents.send('speed', v);
});

ipcMain.on('set-bg-color', (_, color) => {
  if (petWin) petWin.webContents.send('bg-color', color);
});

ipcMain.on('set-mood', (_, mood) => {
  if (petWin) petWin.webContents.send('mood', mood);
});

// Single source of truth for how the pet window consumes mouse input.
// interactionMode is owned by the renderer and mirrored here via three
// signals: set-mouse-over-pet (hover), begin-drag / end-drag (dragging).
// Summary: click-through applies only when both
//   clickThroughEnabled === true   AND   dragActive === false
// while otherwise hover (mouseOverPet) refines it to the pet body itself.
// A mid-drag state change can never turn ignore on.
function syncMouseIgnore() {
  if (!petWin) return;
  const ignore = clickThroughEnabled && !dragActive && !mouseOverPet;
  petWin.setIgnoreMouseEvents(ignore, { forward: true });
}

ipcMain.on('set-mouse-over-pet', (_, over) => {
  mouseOverPet = !!over;
  syncMouseIgnore();
});

// Single entry point for toggling click-through, so the pet window, prefs,
// tray menu and (optionally) a hint balloon always stay in sync.
function setClickThrough(v, hint) {
  clickThroughEnabled = !!v;
  savedPrefs.clickThrough = clickThroughEnabled;
  savePrefs();
  mouseOverPet = false;
  if (petWin) {
    syncMouseIgnore();
    petWin.webContents.send('clickthrough', clickThroughEnabled);
  }
  refreshTray();
  if (hint && clickThroughEnabled && tray) {
    tray.displayBalloon({
      iconType: 'none',
      title: 'RD Luckly Dangle',
      content: 'Click-through is on: clicks pass through to other apps. Hover the pet to grab it; right-click it or use the tray icon for controls.'
    });
  }
}

ipcMain.on('toggle-clickthrough', (_, v) => setClickThrough(v, true));

// Single entry point for the position lock, so the pet window, prefs, tray
// menu and settings panel always stay in sync.
function setPositionLock(unlocked, hint) {
  positionUnlocked = !!unlocked;
  savedPrefs.positionUnlocked = positionUnlocked;
  savePrefs();
  refreshTray();
  if (petWin) petWin.webContents.send('position-lock', positionUnlocked);
  if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send('position-lock', positionUnlocked);
  if (hint && tray) {
    tray.displayBalloon({
      iconType: 'none',
      title: 'RD Luckly Dangle',
      content: positionUnlocked
        ? 'Position unlocked — drag the pet anywhere, then lock it again from the same menu.'
        : 'Position locked — the anchor stays put; dragging now just tugs the pet.'
    });
  }
}

ipcMain.on('set-position-lock', (_, v) => setPositionLock(!!v, true));

ipcMain.on('set-ground-shadow', (_, v) => {
  groundShadowOn = !!v;
  savedPrefs.groundShadow = groundShadowOn;
  savePrefs();
  if (petWin) petWin.webContents.send('ground-shadow', groundShadowOn);
});

// --- Start with Windows ---
// Registers the running executable in the user's HKCU Run key so the pet is
// back on screen after every sign-in. Re-applied on each launch, so the
// registration always points at the exe the user is actually running
// (portable folder or installed copy). Dev runs (electron.exe) are skipped.
function applyAutoStart() {
  if (!app.isPackaged) return;
  try {
    app.setLoginItemSettings({
      openAtLogin: autoStartEnabled,
      path: process.execPath,
      args: ['--hidden']
    });
  } catch (e) { /* registration failure is non-fatal */ }
}

function setAutoStart(v) {
  autoStartEnabled = !!v;
  savedPrefs.autoStart = autoStartEnabled;
  savePrefs();
  applyAutoStart();
  refreshTray();
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.webContents.send('autostart', autoStartEnabled);
  }
}

ipcMain.on('set-autostart', (_, v) => setAutoStart(!!v));

ipcMain.handle('get-autostart', () => autoStartEnabled);

ipcMain.on('pet-context-menu', () => {
  if (!petWin || petWin.isDestroyed()) return;
  Menu.buildFromTemplate([
    {
      label: 'Settings',
      click: () => createSettings()
    },
    {
      label: 'Click-Through Mode',
      type: 'checkbox',
      checked: clickThroughEnabled,
      click: (item) => setClickThrough(item.checked, true)
    },
    {
      label: 'Unlock Position (Move Pet)',
      type: 'checkbox',
      checked: positionUnlocked,
      click: (item) => setPositionLock(item.checked, true)
    },
    {
      label: 'Settings',
      click: () => createSettings()
    },
    {
      label: 'Reset Position',
      click: () => resetPosition()
    },
    {
      label: petVisible ? 'Hide Pet (to tray)' : 'Show Pet',
      click: () => (petVisible ? hidePet() : showPet())
    },
    { type: 'separator' },
    {
      label: 'Quit RD Luckly Dangle',
      click: () => app.quit()
    }
  ]).popup({ window: petWin });
});

ipcMain.on('open-settings', () => createSettings());

ipcMain.on('hide-pet', () => hidePet());
ipcMain.on('show-pet', () => showPet());
ipcMain.on('minimize-pet', () => {
  hidePet();
  tray.displayBalloon({
    iconType: 'none',
    title: 'RD Luckly Dangle',
    content: 'Pet is resting in the tray. Click the tray icon to bring it back!'
  });
});

ipcMain.on('reset-position', () => {
  resetPosition();
  if (petWin) petWin.webContents.send('interaction', 'click');
});

ipcMain.on('set-position', (_, opts) => {
  if (!petWin) return;
  opts = opts || {};
  // Snap within the display the pet currently lives on, so presets keep
  // working on second monitors instead of teleporting the pet to the primary.
  const wa = screen.getDisplayMatching(petWin.getBounds()).workArea;
  const [w, h] = petWin.getSize();
  let px, py;
  if (opts.mode === 'top-left') { px = wa.x + 16; py = wa.y + 16; }
  else if (opts.mode === 'top-right') { px = wa.x + wa.width - w - 28; py = wa.y + 16; }
  else if (opts.mode === 'bottom-left') { px = wa.x + 16; py = wa.y + wa.height - h - 12; }
  else if (opts.mode === 'bottom-right') { px = wa.x + wa.width - w - 40; py = wa.y + wa.height - h - 24; }
  else if (opts.mode === 'center') { px = wa.x + Math.round((wa.width - w) / 2); py = wa.y + Math.round((wa.height - h) / 2); }
  else if (typeof opts.x === 'number' && typeof opts.y === 'number') { px = Math.round(opts.x); py = Math.round(opts.y); }
  else return;
  smoothMoveTo(px, py, 320);
});

function smoothMoveTo(x, y, duration) {
  if (!petWin) return;
  if (springTimer) { clearInterval(springTimer); springTimer = null; }
  const [sx, sy] = petWin.getPosition();
  const start = Date.now();
  const ease = (t) => 1 - Math.pow(1 - t, 4);
  springTimer = setInterval(() => {
    if (!petWin) { clearInterval(springTimer); springTimer = null; return; }
    const t = Math.min(1, (Date.now() - start) / duration);
    const k = ease(t);
    const k2 = ease(Math.min(1, t + 0.016));
    petWin.setPosition(Math.round(sx + (x - sx) * k), Math.round(sy + (y - sy) * k));
    petWin.webContents.send('window-motion', { dx: (x - sx) * (k2 - k), dy: (y - sy) * (k2 - k) });
    if (t >= 1) { clearInterval(springTimer); springTimer = null; persistPosition(); }
  }, 16);
}

ipcMain.on('rope-style', (_, style) => {
  ropeStyle = (style && typeof style === 'object') ? { color: style.color, texture: style.texture } : null;
  savedPrefs.ropeStyle = ropeStyle;
  savePrefs();
  if (petWin) petWin.webContents.send('rope-style', ropeStyle || {});
});

ipcMain.on('set-rope-length', (_, pct) => {
  const v = Math.max(40, Math.min(160, Number(pct) || 100));
  savedPrefs.ropeLength = v;
  savePrefs();
  if (petWin) petWin.webContents.send('rope-length', v);
  // The physics panel mirrors rope length, so it has to follow live changes made
  // from the rope card too (and vice-versa) — one value, both windows.
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.webContents.send('physics', physicsConfig());
  }
});

ipcMain.on('set-physics', (_, cfg) => {
  // Reset re-seeds the persisted physics prefs from the app defaults and
  // broadcasts so both the pet and the panel pick the new config up live.
  if (cfg && typeof cfg === 'object' && cfg.reset) {
    savedPrefs.physics = Object.assign({}, DEFAULT_PHYSICS);
    savePrefs();
    broadcastPhysics();
    return;
  }
  const sanitized = sanitizePhysics((cfg && typeof cfg === 'object') ? cfg : {});
  savedPrefs.physics = sanitized;
  savePrefs();
  broadcastPhysics();
});

ipcMain.handle('get-physics', () => physicsConfig());

ipcMain.on('move-pet', (_, pos) => {
  if (!petWin || !pos || typeof pos.x !== 'number' || typeof pos.y !== 'number') return;
  const [cx, cy] = petWin.getPosition();
  const [nx, ny] = (() => { dragMoveTo(Math.round(pos.x), Math.round(pos.y)); return petWin.getPosition(); })();
  petWin.webContents.send('window-motion', { dx: nx - cx, dy: ny - cy });
});

// --- Native-feel dragging ---
// While the pet is dragged, the MAIN process polls the cursor at 125 Hz and
// moves the window itself. There is no renderer->main IPC in the hot path
// (the old per-mousemove move-pet round-trip added 1-2 frames of lag and
// stutter); the renderer only streams pointer events locally to animate the
// rope and swing physics.
let dragPollTimer = null;

function stopDragPoll() {
  if (dragPollTimer) { clearInterval(dragPollTimer); dragPollTimer = null; }
}

function dragMoveTo(x, y) {
  if (!petWin) return;
  const [mw, mh] = petWin.getSize();
  // Clamp against the display nearest the drag target, so the pet can be
  // dragged freely across multi-monitor setups instead of being stuck on
  // the primary screen.
  const wa = screen.getDisplayNearestPoint({ x: x + Math.round(mw / 2), y: y + Math.round(mh / 2) }).workArea;
  const nx = Math.min(wa.x + wa.width - 40, Math.max(wa.x - 60, x));
  const ny = Math.min(wa.y + wa.height - 60, Math.max(wa.y - 2000, y));
  petWin.setPosition(Math.round(nx), Math.round(ny));
  persistPosition();
}

ipcMain.on('begin-drag', () => {
  if (springTimer) { clearInterval(springTimer); springTimer = null; }
  stopDragPoll();
  // While a drag runs, the window must stay interactive no matter what the
  // hover state says — a fast swipe can put the cursor off the pet body, but
  // the drag must not be killed by click-through.
  dragActive = true;
  syncMouseIgnore();
  // Position locked: the anchor (and window) must not move. The renderer
  // still runs its tug physics locally, so the pet leans and swings —
  // only the window stays put.
  if (!petWin || !positionUnlocked) return;
  // Grab offset computed where the press actually landed, in the same
  // coordinates setPosition consumes — no cross-process screenX conversion.
  const cursor = screen.getCursorScreenPoint();
  const [wx, wy] = petWin.getPosition();
  const offX = wx - cursor.x;
  const offY = wy - cursor.y;
  dragPollTimer = setInterval(() => {
    if (!petWin || petWin.isDestroyed()) { stopDragPoll(); return; }
    const c = screen.getCursorScreenPoint();
    dragMoveTo(c.x + offX, c.y + offY);
  }, 8);
});

ipcMain.on('end-drag', () => {
  stopDragPoll();
  dragActive = false;
  // Re-evaluate click-through with the drag gone. The renderer sends a fresh
  // set-mouse-over-pet just after end-drag, so this is usually a no-op that
  // keeps interactive state until the next hover message lands.
  syncMouseIgnore();
  persistPosition();
});

ipcMain.on('quit', () => app.quit());

ipcMain.handle('get-clickthrough', () => clickThroughEnabled);

ipcMain.handle('get-position-lock', () => positionUnlocked);

ipcMain.handle('get-ground-shadow', () => groundShadowOn);

ipcMain.handle('get-path', () => app.getPath('userData'));

ipcMain.handle('get-supported-formats', () => SUPPORTED_FORMATS);

ipcMain.handle('read-image-as-dataurl', async (_, filePath) => {
  try {
    const buffer = fs.readFileSync(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const mimeMap = {
      '.svg': 'image/svg+xml',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.bmp': 'image/bmp',
      '.ico': 'image/x-icon',
      '.apng': 'image/apng',
      '.avif': 'image/avif'
    };
    const mime = mimeMap[ext] || 'application/octet-stream';
    if (ext === '.svg') {
      return 'data:image/svg+xml;base64,' + buffer.toString('base64');
    }
    return `data:${mime};base64,` + buffer.toString('base64');
  } catch (e) {
    return null;
  }
});

app.on('window-all-closed', (e) => {
  e.preventDefault();
});

app.on('before-quit', () => {
  stopDragPoll();
  if (posSaveTimer) { clearTimeout(posSaveTimer); posSaveTimer = null; }
  if (petWin) {
    const [px, py] = petWin.getPosition();
    savedPrefs.position = { x: px, y: py };
    savePrefs();
  }
});

app.on('activate', () => {
  createSettings();
});