/**
 * Inserta auth-shell.css dentro de styles.css (después de los @import globales).
 * Ejecutar tras editar auth-shell.css: node scripts/inline-auth-shell.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(__dirname, '..', 'src');
const stylesPath = path.join(src, 'styles.css');
const authPath = path.join(src, 'auth-shell.css');

let styles = fs.readFileSync(stylesPath, 'utf8');
const auth = fs.readFileSync(authPath, 'utf8');
const marker = '/* === auth-shell: login, register, verify2fa, reset-password (inline para ng serve) === */';
const block = `\n${marker}\n${auth}\n\n`;

if (styles.includes(marker)) {
  const start = styles.indexOf(marker);
  const end = styles.indexOf(':root {', start);
  if (end < 0) throw new Error(':root not found after auth marker');
  styles = styles.slice(0, start) + block.trimStart() + '\n\n' + styles.slice(end);
  fs.writeFileSync(stylesPath, styles);
  console.log('Replaced existing auth-shell block in styles.css');
  process.exit(0);
}

const anchor = "@import url('./public-premium.css');\n\n";
const a = styles.indexOf(anchor);
if (a < 0) {
  console.error('Anchor after public-premium not found');
  process.exit(1);
}
const insertAt = a + anchor.length;
const rootAt = styles.indexOf(':root {', insertAt);
if (rootAt < 0) {
  console.error(':root not found');
  process.exit(1);
}
styles = styles.slice(0, insertAt) + block + styles.slice(rootAt);
fs.writeFileSync(stylesPath, styles);
console.log('Inserted auth-shell into styles.css');