import {
  initAuth,
  createNewList,
  joinList,
  addEntry,
  removeEntry,
  updateEntry,
  updateListTitle,
  listenToList,
  getActiveListCode,
  getSavedLists,
  isPlaceholderConfig
} from "./firebase-service.js";

/* ==========================================================================
   APP STATE & KONSTANTEN
   ========================================================================== */
const VIBRATION_STORAGE_KEY = "essensroulette_vibration";
const SOUND_STORAGE_KEY = "essensroulette_sound";
const MODE_STORAGE_KEY = "essensroulette_mode";

const WHEEL_COLORS = [
  "#6C5CE7",
  "#00CEC9",
  "#FD79A8",
  "#FDCB6E",
  "#0984E3",
  "#E17055",
  "#00B894",
  "#A29BFE"
];

const CSGO_RARITIES = [
  { name: "Mil-Spec", color: "#4b69ff", glow: "rgba(75, 105, 255, 0.38)", icon: "🍽️" },
  { name: "Restricted", color: "#8847ff", glow: "rgba(136, 71, 255, 0.38)", icon: "🔥" },
  { name: "Classified", color: "#d32ce6", glow: "rgba(211, 44, 230, 0.38)", icon: "✨" },
  { name: "Covert", color: "#eb4b4b", glow: "rgba(235, 75, 75, 0.42)", icon: "👑" },
  { name: "Rare Special", color: "#ffd700", glow: "rgba(255, 215, 0, 0.48)", icon: "🏆" }
];

let currentShareCode = null;
let currentListData = { title: "Essensroulette", entries: [] };
let unsubscribeSnapshot = null;

let selectedMode = localStorage.getItem(MODE_STORAGE_KEY) || "wheel"; // "wheel" | "case"
let vibrationEnabled = localStorage.getItem(VIBRATION_STORAGE_KEY) !== "false";
let soundEnabled = localStorage.getItem(SOUND_STORAGE_KEY) !== "false";

// Bearbeitungs-State für Eintrags-Modal & Listen-Modal
let editingEntryId = null;
let listModalMode = "create"; // "create" | "rename"

// Glücksrad State
let wheelAngle = 0; // Aktueller Drehwinkel in Radiant
let wheelSpinning = false;
let wheelAnimFrame = null;

// CS:GO Case State & Original-Audio
const caseAudio = new Audio("./media/csgo_case_sound.m4a");
caseAudio.preload = "auto";
let caseAnimFrame = null;
let caseTimeouts = [];
let caseRunning = false;

// Web Audio Context für dezente Glücksrad-Klicks
let audioCtx = null;

/* ==========================================================================
   DOM-ELEMENTE
   ========================================================================== */
const dom = {
  listTitle: document.getElementById("list-title"),
  headerCodeBadge: document.getElementById("header-code-badge"),
  btnEditTitle: document.getElementById("btn-edit-title"),
  btnMenu: document.getElementById("btn-menu"),
  btnShare: document.getElementById("btn-share"),
  demoBanner: document.getElementById("demo-banner"),

  entriesCount: document.getElementById("entries-count"),
  entriesList: document.getElementById("entries-list"),
  emptyState: document.getElementById("empty-state"),

  modeWheelBtn: document.getElementById("mode-wheel"),
  modeCaseBtn: document.getElementById("mode-case"),
  btnStartRandom: document.getElementById("btn-start-random"),
  startBtnText: document.getElementById("start-btn-text"),
  btnAddEntry: document.getElementById("btn-add-entry"),

  // Drawer
  drawerBackdrop: document.getElementById("drawer-backdrop"),
  sideDrawer: document.getElementById("side-drawer"),
  btnCloseDrawer: document.getElementById("btn-close-drawer"),
  btnNewList: document.getElementById("btn-new-list"),
  savedListsContainer: document.getElementById("saved-lists-container"),
  joinListForm: document.getElementById("join-list-form"),
  joinCodeInput: document.getElementById("join-code-input"),
  toggleVibration: document.getElementById("toggle-vibration"),
  toggleSound: document.getElementById("toggle-sound"),

  // Entry Modal
  entryModal: document.getElementById("entry-modal"),
  entryModalTitle: document.getElementById("entry-modal-title"),
  entryForm: document.getElementById("entry-form"),
  entryInput: document.getElementById("entry-input"),
  btnCancelEntry: document.getElementById("btn-cancel-entry"),

  // List Modal
  listModal: document.getElementById("list-modal"),
  listModalTitle: document.getElementById("list-modal-title"),
  listForm: document.getElementById("list-form"),
  listTitleInput: document.getElementById("list-title-input"),
  btnCancelList: document.getElementById("btn-cancel-list"),

  // Share Modal
  shareModal: document.getElementById("share-modal"),
  shareCodeDisplay: document.getElementById("share-code-display"),
  btnCloseShare: document.getElementById("btn-close-share"),
  btnCopyCode: document.getElementById("btn-copy-code"),

  // Wheel Overlay
  wheelOverlay: document.getElementById("wheel-overlay"),
  btnCloseWheel: document.getElementById("btn-close-wheel"),
  wheelLiveLabel: document.getElementById("wheel-live-label"),
  btnSpinAgainSide: document.getElementById("btn-spin-again-side"),
  wheelPointer: document.getElementById("wheel-pointer"),
  wheelCanvas: document.getElementById("wheel-canvas"),

  // CS:GO Case Overlay
  caseOverlay: document.getElementById("case-overlay"),
  csgoCaseName: document.getElementById("csgo-case-name"),
  csgoCrateWrapper: document.getElementById("csgo-crate-wrapper"),
  csgoLockAssembly: document.getElementById("csgo-lock-assembly"),
  csgoReelViewport: document.getElementById("csgo-reel-viewport"),
  csgoReelTrack: document.getElementById("csgo-reel-track"),
  csgoSpinnerRing: document.getElementById("csgo-spinner-ring"),
  btnCloseCase: document.getElementById("btn-close-case"),

  // Winner Modal
  winnerModal: document.getElementById("winner-modal"),
  winnerText: document.getElementById("winner-text"),
  btnWinnerClose: document.getElementById("btn-winner-close"),
  btnWinnerAgain: document.getElementById("btn-winner-again"),

  toast: document.getElementById("toast")
};

/* ==========================================================================
   INITIALISIERUNG
   ========================================================================== */
async function initApp() {
  setupEventListeners();
  applyModeUI(selectedMode);
  dom.toggleVibration.checked = vibrationEnabled;
  dom.toggleSound.checked = soundEnabled;

  if (isPlaceholderConfig()) {
    dom.demoBanner.classList.remove("hidden");
  }

  try {
    await initAuth();
    const existingCode = getActiveListCode();

    if (existingCode) {
      await switchToList(existingCode);
    } else {
      // Beim allerersten Start direkt eine Liste anlegen
      const newCode = await createNewList("Essensroulette");
      await switchToList(newCode);
    }
  } catch (error) {
    console.error("Fehler beim App-Start:", error);
    showToast("Fehler bei der Verbindung: " + error.message);
  }
}

/**
 * Wechselt auf eine Liste per Code und startet den Echtzeit-Listener (listenToList).
 * @param {string} shareCode
 */
async function switchToList(shareCode) {
  if (unsubscribeSnapshot) {
    unsubscribeSnapshot();
    unsubscribeSnapshot = null;
  }

  currentShareCode = shareCode.trim().toUpperCase();
  dom.headerCodeBadge.textContent = `#${currentShareCode}`;
  renderSavedListsDrawer();

  unsubscribeSnapshot = await listenToList(currentShareCode, (listData, error) => {
    if (error) {
      showToast("Synchronisationsfehler: " + error.message);
      return;
    }

    if (!listData) {
      // Falls die gespeicherte Liste nicht (mehr) existiert, neue erstellen
      createNewList("Essensroulette").then((freshCode) => switchToList(freshCode));
      return;
    }

    currentListData = {
      title: listData.title || `Liste #${currentShareCode}`,
      entries: Array.isArray(listData.entries) ? listData.entries : []
    };

    renderMainScreen();
    renderSavedListsDrawer();
  });
}

/* ==========================================================================
   UI RENDERING (HAUPTSCREEN & SEITENMENÜ)
   ========================================================================== */
function renderMainScreen() {
  const entries = currentListData.entries || [];
  dom.listTitle.textContent = currentListData.title || `Liste #${currentShareCode}`;
  dom.headerCodeBadge.textContent = `#${currentShareCode}`;
  dom.entriesCount.textContent =
    entries.length === 1 ? "1 Eintrag" : `${entries.length} Einträge`;

  dom.btnStartRandom.disabled = entries.length === 0;

  if (entries.length === 0) {
    dom.entriesList.innerHTML = "";
    dom.entriesList.classList.add("hidden");
    dom.emptyState.classList.remove("hidden");
    return;
  }

  dom.emptyState.classList.add("hidden");
  dom.entriesList.classList.remove("hidden");

  dom.entriesList.innerHTML = entries
    .map((entry, idx) => {
      const color = entry.color || WHEEL_COLORS[idx % WHEEL_COLORS.length];
      return `
        <div class="entry-card" data-id="${escapeHtml(entry.id)}">
          <div class="entry-left">
            <span class="entry-color-dot" style="color: ${color}; background: ${color};"></span>
            <span class="entry-text">${escapeHtml(entry.text)}</span>
          </div>
          <div class="entry-actions">
            <button class="entry-action-btn edit" data-action="edit" data-id="${escapeHtml(entry.id)}" aria-label="Eintrag bearbeiten" title="Bearbeiten">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M12 20h9"></path>
                <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path>
              </svg>
            </button>
            <button class="entry-action-btn delete" data-action="delete" data-id="${escapeHtml(entry.id)}" aria-label="Eintrag löschen" title="Löschen">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="3 6 5 6 21 6"></polyline>
                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
              </svg>
            </button>
          </div>
        </div>
      `;
    })
    .join("");
}

function renderSavedListsDrawer() {
  const lists = getSavedLists();
  if (lists.length === 0) {
    dom.savedListsContainer.innerHTML = `<p class="setting-desc">Noch keine gespeicherten Listen.</p>`;
    return;
  }

  dom.savedListsContainer.innerHTML = lists
    .map((item) => {
      const isActive = item.code === currentShareCode;
      return `
        <button class="saved-list-item ${isActive ? "active" : ""}" data-code="${escapeHtml(item.code)}">
          <span class="saved-list-name">${escapeHtml(item.title || `Liste #${item.code}`)}</span>
          <span class="saved-list-code">#${escapeHtml(item.code)}</span>
        </button>
      `;
    })
    .join("");
}

function applyModeUI(mode) {
  selectedMode = mode === "case" ? "case" : "wheel";
  localStorage.setItem(MODE_STORAGE_KEY, selectedMode);

  dom.modeWheelBtn.classList.toggle("active", selectedMode === "wheel");
  dom.modeWheelBtn.setAttribute("aria-selected", String(selectedMode === "wheel"));
  dom.modeCaseBtn.classList.toggle("active", selectedMode === "case");
  dom.modeCaseBtn.setAttribute("aria-selected", String(selectedMode === "case"));

  dom.startBtnText.textContent =
    selectedMode === "wheel" ? "Glücksrad drehen" : "CS:GO Case öffnen";
}

/* ==========================================================================
   VIBRATION & AUDIO HELFER
   ========================================================================== */
function triggerVibration(pattern = 80) {
  if (!vibrationEnabled) return;
  try {
    if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") {
      navigator.vibrate(pattern);
    }
  } catch {
    // Ignorieren falls Gerät keine Vibration unterstützt
  }
}

function playWheelTickSound() {
  if (!soundEnabled) return;
  try {
    if (!audioCtx) {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) return;
      audioCtx = new AudioContextClass();
    }
    if (audioCtx.state === "suspended") {
      audioCtx.resume();
    }
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = "triangle";
    osc.frequency.setValueAtTime(520, audioCtx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(140, audioCtx.currentTime + 0.028);

    gain.gain.setValueAtTime(0.12, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.028);

    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + 0.03);
  } catch {
    // Kein Audio verfügbar
  }
}

/* ==========================================================================
   ZUFALLSMECHANISMUS 1: SEITLICHES GLÜCKSRAD (RECHTS NEBEN DEM BILDSCHIRM)
   ========================================================================== */
function openWheelOverlayAndSpin() {
  const entries = currentListData.entries || [];
  if (entries.length === 0) {
    showToast("Füge zuerst mindestens einen Eintrag hinzu!");
    return;
  }

  dom.wheelOverlay.classList.remove("hidden");
  dom.wheelOverlay.setAttribute("aria-hidden", "false");
  drawWheel(wheelAngle);
  startWheelSpin();
}

/**
 * Zeichnet das Glücksrad auf das Canvas.
 * Da das Rad rechts außerhalb des Bildschirms liegt, ist auf dem Bildschirm das
 * linke Drittel (rund um Winkel PI = 180°) sichtbar.
 * Der Pfeil zeigt von links nach rechts genau auf den Winkel PI (9-Uhr-Position).
 */
function drawWheel(angleOffset) {
  const canvas = dom.wheelCanvas;
  const ctx = canvas.getContext("2d");
  const entries = currentListData.entries || [];
  if (entries.length === 0) return;

  const w = canvas.width;
  const h = canvas.height;
  const cx = w / 2;
  const cy = h / 2;
  const radius = w / 2 - 18;

  ctx.clearRect(0, 0, w, h);

  const count = entries.length;
  const arc = (Math.PI * 2) / count;

  for (let i = 0; i < count; i++) {
    const startAngle = angleOffset + i * arc;
    const endAngle = startAngle + arc;
    const midAngle = startAngle + arc / 2;
    const color = entries[i].color || WHEEL_COLORS[i % WHEEL_COLORS.length];

    // Segmentfläche zeichnen
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, radius, startAngle, endAngle);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();

    // Weiche Trennlinie
    ctx.lineWidth = 3;
    ctx.strokeStyle = "rgba(13, 15, 23, 0.45)";
    ctx.stroke();

    // Kleiner heller Pin am äußeren Rand (links sichtbar)
    const pinX = cx + Math.cos(startAngle) * (radius - 14);
    const pinY = cy + Math.sin(startAngle) * (radius - 14);
    ctx.beginPath();
    ctx.arc(pinX, pinY, 5, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(255, 255, 255, 0.85)";
    ctx.fill();

    // Text im linken Drittel (bei Winkel PI) aufrecht lesbar zeichnen:
    // Durch Rotation um (midAngle + Math.PI) steht der Text auf der linken Radseite (PI) exakt waagerecht (0°)!
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(midAngle + Math.PI);
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#ffffff";
    ctx.font = count > 12 ? "700 22px Inter, sans-serif" : "700 28px Inter, sans-serif";
    ctx.shadowColor = "rgba(0, 0, 0, 0.55)";
    ctx.shadowBlur = 6;

    const label = truncateText(entries[i].text, 20);
    ctx.fillText(label, radius * 0.34, 0);
    ctx.restore();
  }

  // Äußerer edler Ring
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.lineWidth = 12;
  ctx.strokeStyle = "rgba(255, 255, 255, 0.18)";
  ctx.stroke();

  // Radnabe in der Mitte
  ctx.beginPath();
  ctx.arc(cx, cy, 58, 0, Math.PI * 2);
  ctx.fillStyle = "#151926";
  ctx.fill();
  ctx.lineWidth = 6;
  ctx.strokeStyle = "#f6b93b";
  ctx.stroke();
}

/**
 * Ermittelt, welcher Eintrag sich aktuell am Zeiger (Winkel PI = 180°, linke Seite des Rades) befindet.
 */
function getEntryIndexAtPointer(currentAngle, count) {
  const arc = (Math.PI * 2) / count;
  const twoPi = Math.PI * 2;
  // Zeiger liegt bei Math.PI (links vom Radmittelpunkt)
  const relativeAngle = (((Math.PI - currentAngle) % twoPi) + twoPi) % twoPi;
  return Math.floor(relativeAngle / arc) % count;
}

function startWheelSpin() {
  const entries = currentListData.entries || [];
  if (entries.length === 0 || wheelSpinning) return;

  wheelSpinning = true;
  dom.btnSpinAgainSide.disabled = true;
  dom.winnerModal.classList.add("hidden");

  const count = entries.length;
  const arc = (Math.PI * 2) / count;

  // Zufälligen Gewinner-Index vorab fair bestimmen
  const randomBuffer = new Uint32Array(1);
  crypto.getRandomValues(randomBuffer);
  const winnerIndex = randomBuffer[0] % count;

  // Zufällige Position innerhalb des Gewinner-Segments (nicht zu nah an der Kante)
  const sliceInternalOffset = (0.2 + Math.random() * 0.6) * arc;
  // Damit winnerIndex bei Math.PI landet, muss gelten:
  // angle + winnerIndex * arc + sliceInternalOffset ≡ Math.PI (mod 2*PI)
  const targetMod =
    (((Math.PI - (winnerIndex * arc + sliceInternalOffset)) % (Math.PI * 2)) + Math.PI * 2) %
    (Math.PI * 2);
  const currentMod = ((wheelAngle % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);

  let deltaAngle = targetMod - currentMod;
  if (deltaAngle <= 0) {
    deltaAngle += Math.PI * 2;
  }

  // 6 bis 8 volle Umdrehungen + exakter Zielwinkel
  const extraSpins = (6 + Math.floor(Math.random() * 3)) * Math.PI * 2;
  const startAngle = wheelAngle;
  const finalAngle = startAngle + extraSpins + deltaAngle;

  const duration = 4800; // 4.8 Sekunden Drehzeit
  const startTime = performance.now();
  let lastSliceIndex = getEntryIndexAtPointer(startAngle, count);

  function step(now) {
    const elapsed = now - startTime;
    const t = Math.min(elapsed / duration, 1);

    // Quintic Ease-Out: erst schnell, dann sanft abbremsend
    const eased = 1 - Math.pow(1 - t, 4.2);
    wheelAngle = startAngle + (finalAngle - startAngle) * eased;

    drawWheel(wheelAngle);

    const activeIdx = getEntryIndexAtPointer(wheelAngle, count);
    dom.wheelLiveLabel.textContent = entries[activeIdx].text;

    if (activeIdx !== lastSliceIndex) {
      lastSliceIndex = activeIdx;
      playWheelTickSound();
      triggerVibration(10);
      dom.wheelPointer.classList.remove("tick-bounce");
      void dom.wheelPointer.offsetWidth;
      dom.wheelPointer.classList.add("tick-bounce");
    }

    if (t < 1) {
      wheelAnimFrame = requestAnimationFrame(step);
    } else {
      wheelSpinning = false;
      dom.btnSpinAgainSide.disabled = false;
      const winningEntry = entries[winnerIndex];
      dom.wheelLiveLabel.textContent = winningEntry.text;

      // Ergebnis ausgewählt -> Vibration + Ergebnis-Pop-up
      triggerVibration([90, 50, 150]);
      setTimeout(() => {
        showWinnerModal(winningEntry.text);
      }, 320);
    }
  }

  wheelAnimFrame = requestAnimationFrame(step);
}

function closeWheelOverlay() {
  if (wheelAnimFrame) {
    cancelAnimationFrame(wheelAnimFrame);
    wheelAnimFrame = null;
  }
  wheelSpinning = false;
  dom.btnSpinAgainSide.disabled = false;
  dom.wheelOverlay.classList.add("hidden");
  dom.wheelOverlay.setAttribute("aria-hidden", "true");
}

/* ==========================================================================
   ZUFALLSMECHANISMUS 2: CS:GO CASE OPENING (INKL. ORIGINAL SOUND-SYNCHRONISATION)
   ========================================================================== */
function openCaseOverlayAndStart() {
  const entries = currentListData.entries || [];
  if (entries.length === 0) {
    showToast("Füge zuerst mindestens einen Eintrag hinzu!");
    return;
  }

  stopCaseAnimation();
  dom.winnerModal.classList.add("hidden");
  dom.caseOverlay.classList.remove("hidden");
  dom.caseOverlay.setAttribute("aria-hidden", "false");
  dom.csgoCaseName.textContent = `${currentListData.title || "Essensroulette"} Case`;

  startCsgoCaseSequence(entries);
}

/**
 * Führt die komplette CS:GO Case-Opening Animation synchron zur Audiodatei
 * `media/csgo_case_sound.m4a` aus:
 * - 0.00s – 2.02s: Heranzoomen an die geschlossene Kiste + Schlüssel schließt ab ~0.95s das Schloss auf
 * - ~2.02s: Aufklapp-Sound -> Kiste klappt auf, wird im Hintergrund dunkel/unscharf, horizontale Boxen-Liste erscheint
 * - 2.05s – 7.62s: Die Boxen fahren erst schnell, dann immer langsamer nach links am gelben Mittelstrich vorbei
 * - 8.12s: Exakt beim "Boom / Reveal"-Sound in der Audiodatei blitzt das gezogene Item auf,
 *          das Handy vibriert kurz und das Gewinner-Popup öffnet sich!
 */
function startCsgoCaseSequence(entries) {
  caseRunning = true;

  // Zufälligen Gewinner bestimmen
  const randBuf = new Uint32Array(1);
  crypto.getRandomValues(randBuf);
  const winnerEntry = entries[randBuf[0] % entries.length];

  // 46 Boxen generieren, Gewinner liegt auf Index 39
  const TOTAL_BOXES = 46;
  const WIN_INDEX = 39;
  const CARD_WIDTH = 152;
  const CARD_GAP = 8;
  const CARD_STEP = CARD_WIDTH + CARD_GAP; // 160px pro Box

  const reelItems = [];
  for (let i = 0; i < TOTAL_BOXES; i++) {
    if (i === WIN_INDEX) {
      reelItems.push({
        entry: winnerEntry,
        rarity: CSGO_RARITIES[Math.floor(Math.random() * CSGO_RARITIES.length)]
      });
    } else {
      const randomEntry = entries[Math.floor(Math.random() * entries.length)];
      // Gewichtete CS:GO Rarity-Farben für authentischen Look
      const rRoll = Math.random();
      const rarity =
        rRoll < 0.55
          ? CSGO_RARITIES[0]
          : rRoll < 0.8
          ? CSGO_RARITIES[1]
          : rRoll < 0.93
          ? CSGO_RARITIES[2]
          : rRoll < 0.985
          ? CSGO_RARITIES[3]
          : CSGO_RARITIES[4];
      reelItems.push({ entry: randomEntry, rarity });
    }
  }

  // DOM für das horizontale Rollband aufbauen
  dom.csgoReelTrack.innerHTML = reelItems
    .map((item, idx) => {
      const shortWords = getFirstWords(item.entry.text, 5);
      return `
        <div class="csgo-item-box" data-idx="${idx}" style="--rarity-color: ${item.rarity.color}; --rarity-glow: ${item.rarity.glow};">
          <div class="csgo-box-emblem">${item.rarity.icon}</div>
          <div class="csgo-box-title">${escapeHtml(shortWords)}</div>
        </div>
      `;
    })
    .join("");

  // Anfangszustand der Kiste wiederherstellen
  dom.csgoReelViewport.classList.add("hidden");
  dom.csgoCrateWrapper.classList.remove("zooming", "opened-bg");
  dom.csgoLockAssembly.classList.remove("unlocking");
  dom.csgoSpinnerRing.classList.remove("hidden");

  // Audio starten (falls Sound in den Einstellungen aktiviert ist)
  let useAudioClock = false;
  caseAudio.pause();
  caseAudio.currentTime = 0;

  if (soundEnabled) {
    const playPromise = caseAudio.play();
    if (playPromise !== undefined) {
      playPromise
        .then(() => {
          useAudioClock = true;
        })
        .catch((err) => {
          console.warn("Audio-Wiedergabe konnte nicht gestartet werden:", err);
        });
    }
  }

  const fallbackStartPerf = performance.now();

  // Zufälliger Lande-Versatz innerhalb der Gewinner-Box (wie in CS:GO, manchmal knapp am Rand!)
  const randomLandingJitter = (Math.random() - 0.5) * (CARD_WIDTH * 0.68);

  let phaseOpened = false;
  let phaseUnlocked = false;
  let phaseRevealed = false;
  let lastPassedBoxIdx = 0;

  // Zeitpunkte exakt passend zu media/csgo_case_sound.m4a:
  const KEY_UNLOCK_TIME = 0.92; // Schlüssel im Schloss (Sekunde ~1.0)
  const CRATE_OPEN_TIME = 2.02; // Kiste klappt auf + Rollband erscheint
  const ROLL_START_TIME = 2.05; // Beginn des Ratterns
  const ROLL_END_TIME = 7.62;   // Letzter Tick / Ausrollen beendet (~5.57s Rolldauer)
  const REVEAL_BOOM_TIME = 8.12; // Der "Boom/Reveal"-Sound bei ~8.1s

  // Sofort leichtes Heranzoomen an die Kiste starten
  requestAnimationFrame(() => {
    dom.csgoCrateWrapper.classList.add("zooming");
  });

  function updateFrame() {
    if (!caseRunning) return;

    // Aktuelle Zeit in Sekunden (synchron zum Audio, falls aktiv)
    const elapsedSec =
      useAudioClock && !caseAudio.paused
        ? caseAudio.currentTime
        : (performance.now() - fallbackStartPerf) / 1000;

    // 1. Bei ~0.92s: Schlüssel schließt das Schloss an der Kiste auf
    if (elapsedSec >= KEY_UNLOCK_TIME && !phaseUnlocked) {
      phaseUnlocked = true;
      dom.csgoLockAssembly.classList.add("unlocking");
      triggerVibration(20);
    }

    // 2. Bei ~2.02s: Kiste klappt auf & horizontale Boxen-Liste erscheint
    if (elapsedSec >= CRATE_OPEN_TIME && !phaseOpened) {
      phaseOpened = true;
      dom.csgoCrateWrapper.classList.add("opened-bg");
      dom.csgoReelViewport.classList.remove("hidden");
      triggerVibration(35);
    }

    // 3. Zwischen 2.05s und 7.62s: Horizontales Rollen der Boxen nach links
    if (phaseOpened) {
      const viewportWidth = dom.csgoReelViewport.clientWidth || window.innerWidth;
      const centerX = viewportWidth / 2;

      // Startposition: Box 2 liegt in der Mitte
      const startTrackX = centerX - (2 * CARD_STEP + CARD_WIDTH / 2);
      // Zielposition: Box WIN_INDEX (39) liegt am gelben Mittelstrich (inkl. leichtem Jitter)
      const targetTrackX =
        centerX - (WIN_INDEX * CARD_STEP + CARD_WIDTH / 2 + randomLandingJitter);

      const rollDuration = ROLL_END_TIME - ROLL_START_TIME;
      const u = Math.min(Math.max((elapsedSec - ROLL_START_TIME) / rollDuration, 0), 1);

      // Steile Abbremskurve passend zum Rattern von csgo_case_sound.m4a
      const eased = 1 - Math.pow(1 - u, 2.95);
      const currentTrackX = startTrackX + (targetTrackX - startTrackX) * eased;

      dom.csgoReelTrack.style.transform = `translate3d(${currentTrackX.toFixed(2)}px, 0, 0)`;

      // Prüfen, welche Box gerade den gelben Mittelstrich passiert
      const currentBoxIdx = Math.floor((centerX - currentTrackX) / CARD_STEP);
      if (currentBoxIdx !== lastPassedBoxIdx && currentBoxIdx > lastPassedBoxIdx) {
        lastPassedBoxIdx = currentBoxIdx;
        // Bei den langsameren letzten Ticks leichtes haptisches Feedback geben
        if (u > 0.72) {
          triggerVibration(8);
        }
      }
    }

    // 4. Bei 8.12s: Der "Boom / Reveal"-Sound setzt ein -> Gewinner hervorheben & Popup öffnen!
    if (elapsedSec >= REVEAL_BOOM_TIME && !phaseRevealed) {
      phaseRevealed = true;
      dom.csgoSpinnerRing.classList.add("hidden");

      const winnerCardEl = dom.csgoReelTrack.querySelector(
        `.csgo-item-box[data-idx="${WIN_INDEX}"]`
      );
      if (winnerCardEl) {
        winnerCardEl.classList.add("winner-reveal");
      }

      // Kurze kräftige Vibration zum Ergebnis
      triggerVibration([90, 40, 160]);

      // Nach kurzem Aufleuchten der Box das Gewinner-Popup einblenden (während der Sound noch ~2s ausfaded)
      const modalTimer = setTimeout(() => {
        if (caseRunning) {
          showWinnerModal(winnerEntry.text);
        }
      }, 420);
      caseTimeouts.push(modalTimer);
      return;
    }

    if (!phaseRevealed) {
      caseAnimFrame = requestAnimationFrame(updateFrame);
    }
  }

  caseAnimFrame = requestAnimationFrame(updateFrame);
}

function stopCaseAnimation() {
  caseRunning = false;
  if (caseAnimFrame) {
    cancelAnimationFrame(caseAnimFrame);
    caseAnimFrame = null;
  }
  caseTimeouts.forEach((t) => clearTimeout(t));
  caseTimeouts = [];
  caseAudio.pause();
  caseAudio.currentTime = 0;
}

function closeCaseOverlay() {
  stopCaseAnimation();
  dom.caseOverlay.classList.add("hidden");
  dom.caseOverlay.setAttribute("aria-hidden", "true");
}

/* ==========================================================================
   ERGEBNIS-POP-UP & MODALS
   ========================================================================== */
function showWinnerModal(winnerName) {
  dom.winnerText.textContent = winnerName;
  dom.winnerModal.classList.remove("hidden");
}

function openEntryModal(editId = null, currentText = "") {
  editingEntryId = editId;
  dom.entryModalTitle.textContent = editId ? "Eintrag bearbeiten" : "Neuer Eintrag";
  dom.entryInput.value = currentText;
  dom.entryModal.classList.remove("hidden");
  setTimeout(() => dom.entryInput.focus(), 50);
}

function closeEntryModal() {
  editingEntryId = null;
  dom.entryForm.reset();
  dom.entryModal.classList.add("hidden");
}

function openListModal(mode = "create") {
  listModalMode = mode;
  if (mode === "rename") {
    dom.listModalTitle.textContent = "Liste umbenennen";
    dom.listTitleInput.value = currentListData.title || "";
  } else {
    dom.listModalTitle.textContent = "Neue Liste erstellen";
    dom.listTitleInput.value = "";
  }
  dom.listModal.classList.remove("hidden");
  setTimeout(() => dom.listTitleInput.focus(), 50);
}

function closeListModal() {
  dom.listForm.reset();
  dom.listModal.classList.add("hidden");
}

function toggleDrawer(open) {
  dom.sideDrawer.classList.toggle("open", open);
  dom.sideDrawer.setAttribute("aria-hidden", String(!open));
  dom.drawerBackdrop.classList.toggle("hidden", !open);
}

/* ==========================================================================
   EVENT LISTENERS
   ========================================================================== */
function setupEventListeners() {
  // Seitenmenü öffnen / schließen
  dom.btnMenu.addEventListener("click", () => {
    renderSavedListsDrawer();
    toggleDrawer(true);
  });
  dom.btnCloseDrawer.addEventListener("click", () => toggleDrawer(false));
  dom.drawerBackdrop.addEventListener("click", () => toggleDrawer(false));

  // Überschrift antippen -> Liste umbenennen
  dom.btnEditTitle.addEventListener("click", () => openListModal("rename"));

  // Teilen-Pop-up
  dom.btnShare.addEventListener("click", () => {
    dom.shareCodeDisplay.textContent = currentShareCode || "-----";
    dom.shareModal.classList.remove("hidden");
  });
  dom.btnCloseShare.addEventListener("click", () => dom.shareModal.classList.add("hidden"));
  dom.btnCopyCode.addEventListener("click", async () => {
    if (!currentShareCode) return;
    try {
      await navigator.clipboard.writeText(currentShareCode);
      showToast(`Code "${currentShareCode}" kopiert!`);
    } catch {
      showToast(`Teilen-Code: ${currentShareCode}`);
    }
    dom.shareModal.classList.add("hidden");
  });

  // Modus-Umschalter (Glücksrad vs. CS:GO Case)
  dom.modeWheelBtn.addEventListener("click", () => applyModeUI("wheel"));
  dom.modeCaseBtn.addEventListener("click", () => applyModeUI("case"));

  // Haupt-Startbutton für Zufallsmechanismus
  dom.btnStartRandom.addEventListener("click", () => {
    if (selectedMode === "wheel") {
      openWheelOverlayAndSpin();
    } else {
      openCaseOverlayAndStart();
    }
  });

  // Plus-Button unten rechts -> Eintrag hinzufügen
  dom.btnAddEntry.addEventListener("click", () => openEntryModal(null, ""));
  dom.btnCancelEntry.addEventListener("click", closeEntryModal);

  // Eintrag speichern (Neu oder Bearbeiten)
  dom.entryForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = dom.entryInput.value.trim();
    if (!text || !currentShareCode) return;

    const editId = editingEntryId;
    closeEntryModal();

    try {
      if (editId) {
        await updateEntry(currentShareCode, editId, { text });
        showToast("Eintrag aktualisiert");
      } else {
        await addEntry(currentShareCode, text);
      }
    } catch (error) {
      showToast("Fehler: " + error.message);
    }
  });

  // Eintrags-Aktionen (Bearbeiten / Löschen) via Event Delegation
  dom.entriesList.addEventListener("click", async (e) => {
    const btn = e.target.closest("button[data-action]");
    if (!btn || !currentShareCode) return;

    const action = btn.dataset.action;
    const entryId = btn.dataset.id;
    const entry = (currentListData.entries || []).find((item) => item.id === entryId);
    if (!entry) return;

    if (action === "edit") {
      openEntryModal(entry.id, entry.text);
    } else if (action === "delete") {
      try {
        await removeEntry(currentShareCode, entry.id);
      } catch (error) {
        showToast("Fehler beim Löschen: " + error.message);
      }
    }
  });

  // Schnell-Ideen im Empty State
  dom.emptyState.addEventListener("click", async (e) => {
    const chip = e.target.closest(".chip-btn");
    if (!chip || !currentShareCode) return;
    const text = chip.dataset.quick;
    try {
      await addEntry(currentShareCode, text);
    } catch (error) {
      showToast("Fehler: " + error.message);
    }
  });

  // Seitenmenü: Gespeicherte Liste auswählen
  dom.savedListsContainer.addEventListener("click", async (e) => {
    const item = e.target.closest(".saved-list-item");
    if (!item) return;
    const code = item.dataset.code;
    toggleDrawer(false);
    if (code && code !== currentShareCode) {
      await switchToList(code);
      showToast(`Gewechselt zu #${code}`);
    }
  });

  // Seitenmenü: Neue Liste erstellen
  dom.btnNewList.addEventListener("click", () => {
    toggleDrawer(false);
    openListModal("create");
  });
  dom.btnCancelList.addEventListener("click", closeListModal);

  dom.listForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const title = dom.listTitleInput.value.trim();
    if (!title) return;
    const mode = listModalMode;
    closeListModal();

    try {
      if (mode === "rename" && currentShareCode) {
        await updateListTitle(currentShareCode, title);
        showToast("Listenname gespeichert");
      } else {
        const newCode = await createNewList(title);
        await switchToList(newCode);
        showToast(`Liste "${title}" (#${newCode}) erstellt!`);
      }
    } catch (error) {
      showToast("Fehler: " + error.message);
    }
  });

  // Seitenmenü: Liste per Code beitreten
  dom.joinListForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const code = dom.joinCodeInput.value.trim().toUpperCase();
    if (!code) return;

    try {
      await joinList(code);
      dom.joinCodeInput.value = "";
      toggleDrawer(false);
      await switchToList(code);
      showToast(`Liste #${code} beigetreten!`);
    } catch (error) {
      showToast(error.message);
    }
  });

  // Einstellungen: Vibrationen & Sound
  dom.toggleVibration.addEventListener("change", () => {
    vibrationEnabled = dom.toggleVibration.checked;
    localStorage.setItem(VIBRATION_STORAGE_KEY, String(vibrationEnabled));
    if (vibrationEnabled) {
      triggerVibration(45);
    }
  });

  dom.toggleSound.addEventListener("change", () => {
    soundEnabled = dom.toggleSound.checked;
    localStorage.setItem(SOUND_STORAGE_KEY, String(soundEnabled));
    if (!soundEnabled) {
      caseAudio.pause();
    }
  });

  // Glücksrad Overlay Buttons
  dom.btnCloseWheel.addEventListener("click", closeWheelOverlay);
  dom.btnSpinAgainSide.addEventListener("click", startWheelSpin);

  // CS:GO Case Overlay Schließen-Button
  dom.btnCloseCase.addEventListener("click", closeCaseOverlay);

  // Gewinner-Popup Buttons
  dom.btnWinnerClose.addEventListener("click", () => {
    dom.winnerModal.classList.add("hidden");
    closeWheelOverlay();
    closeCaseOverlay();
  });

  dom.btnWinnerAgain.addEventListener("click", () => {
    dom.winnerModal.classList.add("hidden");
    if (selectedMode === "wheel") {
      startWheelSpin();
    } else {
      openCaseOverlayAndStart();
    }
  });
}

/* ==========================================================================
   HILFSFUNKTIONEN
   ========================================================================== */
function getFirstWords(text, maxWords = 4) {
  const words = (text || "").trim().split(/\s+/);
  if (words.length <= maxWords) return text;
  return words.slice(0, maxWords).join(" ") + "…";
}

function truncateText(text, maxLength = 20) {
  if (!text || text.length <= maxLength) return text;
  return text.slice(0, maxLength - 1) + "…";
}

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

let toastTimer = null;
function showToast(message) {
  dom.toast.textContent = message;
  dom.toast.classList.remove("hidden");
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    dom.toast.classList.add("hidden");
  }, 2800);
}

// App starten
initApp();
