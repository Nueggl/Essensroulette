import fs from "node:fs";
import path from "node:path";

const rootDir = process.cwd();
const outDir = path.join(rootDir, "www");

const filesToCopy = [
  "index.html",
  "style.css",
  "app.js",
  "firebase-config.js",
  "firebase-service.js"
];

fs.mkdirSync(outDir, { recursive: true });

for (const file of filesToCopy) {
  const src = path.join(rootDir, file);
  const dest = path.join(outDir, file);
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, dest);
  }
}

// Media-Ordner (inkl. csgo_case_sound.m4a) nach www/media kopieren
const mediaSrc = path.join(rootDir, "media");
const mediaDest = path.join(outDir, "media");
if (fs.existsSync(mediaSrc)) {
  fs.cpSync(mediaSrc, mediaDest, { recursive: true });
}

console.log("✅ www/ Ordner für Capacitor aktualisiert.");
