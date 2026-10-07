// Renderer introfilmen (film.html) til MP4 i to formater. Ingen npm-pakker.
//
//   node render.mjs                  begge formater, ét ad gangen
//   node render.mjs --format 1x1     kun det ene
//   node render.mjs --preview        kun stillbilleder direkte fra film.html (hurtigt gennemsyn)
//   node render.mjs --no-wait        spring ventetiden på hukommelse og rustc over
//
// Metode: én Edge headless med sin egen profil i temp-mappen, styret over DevTools-protokollen
// med Nodes indbyggede WebSocket. For hvert billede kaldes seek(t), og lærredet hentes som PNG
// med canvas.toDataURL. Det er valgt frem for Page.captureScreenshot, fordi det ikke går gennem
// kompositoren: billedet er præcis det, seek(t) tegnede, og aldrig et billede for sent.
// Lydsporet syntetiseres her ud fra FILM.events i film.html, altså de samme tider som tegningen.
// Ingen lydfiler udefra. Filmen virker uden lyd.
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir, freemem } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HER = dirname(fileURLToPath(import.meta.url));
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9347;
const STILLS = [6.9, 13.4, 17.4, 21.4, 27.4, 33.1, 37.6, 42.9, 48.2, 53.6, 59.5];
const arg = (n) => process.argv.includes(n);
const val = (n) => { const i = process.argv.indexOf(n); return i > -1 ? process.argv[i + 1] : null; };
const formats = val('--format') ? [val('--format')] : ['1x1', '16x9'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- vent på plads: pc'en har lidt hukommelse, og Rust bygger måske ----------
function rustcRunning() {
  try { return /rustc\.exe/i.test(execFileSync('tasklist', ['/FI', 'IMAGENAME eq rustc.exe', '/NH'], { encoding: 'utf8' })); }
  catch { return false; }
}
async function waitForRoom() {
  if (arg('--no-wait')) return;
  for (let i = 0; i < 240; i++) {
    const gb = freemem() / 2 ** 30, rust = rustcRunning();
    if (!rust && gb >= 1.5) return;
    if (i % 4 === 0) console.log(`venter: ${gb.toFixed(1)} GB fri${rust ? ', rustc kører' : ''}`);
    await sleep(15000);
  }
  throw new Error('Gav op efter en time: for lidt hukommelse, eller rustc kører stadig.');
}

// ---------- Edge over DevTools-protokollen ----------
async function startEdge() {
  const profile = mkdtempSync(join(tmpdir(), 'gt-film-edge-'));
  const proc = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-gpu', '--mute-audio',
    '--hide-scrollbars', '--disable-background-networking', 'about:blank'], { stdio: 'ignore' });
  let page = null;
  for (let i = 0; i < 80 && !page; i++) {
    await sleep(250);
    try { page = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((p) => p.type === 'page'); } catch { /* ikke klar */ }
  }
  if (!page) { proc.kill(); throw new Error('Edge svarede ikke på DevTools-porten.'); }
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('WebSocket til Edge fejlede.')); });
  let id = 0; const pending = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); }
  };
  const send = (method, params = {}) => new Promise((res, rej) => { pending.set(++id, { res, rej }); ws.send(JSON.stringify({ id, method, params })); });
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error('Fejl i film.html: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result.value;
  };
  const close = async () => {
    try { await Promise.race([send('Browser.close'), sleep(3000)]); } catch { /* lukket */ }
    try { ws.close(); } catch { /* lukket */ }
    await sleep(800);
    try { proc.kill(); } catch { /* lukket */ }
    await sleep(500);
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* Edge holder måske en fil et øjeblik */ }
  };
  return { send, evaluate, close };
}

async function openFilm(edge, format) {
  const [w, h] = format === '16x9' ? [1920, 1080] : [1080, 1080];
  await edge.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
  await edge.send('Page.enable');
  await edge.send('Page.navigate', { url: pathToFileURL(join(HER, 'film.html')).href + `?format=${format}&t=0` });
  for (let i = 0; i < 100; i++) { await sleep(100); if (await edge.evaluate('!!window.ready').catch(() => false)) break; }
  await edge.evaluate('window.ready');
  const film = JSON.parse(await edge.evaluate('JSON.stringify(window.FILM)'));
  if (film.W !== w || film.H !== h) throw new Error('film.html har en anden størrelse end ventet.');
  return film;
}
async function frame(edge, t) {
  const url = await edge.evaluate(`(seek(${t}), document.getElementById('c').toDataURL('image/png'))`);
  return Buffer.from(url.slice(url.indexOf(',') + 1), 'base64');
}

// ---------- lyd: syntetiseret, ingen filer udefra ----------
function synth(film) {
  const SR = 48000, N = Math.round(film.DUR * SR);
  const Lc = new Float32Array(N), Rc = new Float32Array(N);
  let seed = 1;
  const rnd = () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let x = Math.imul(seed ^ (seed >>> 15), 1 | seed); x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x; return ((x ^ (x >>> 14)) >>> 0) / 4294967296; };
  const noise = () => rnd() * 2 - 1;
  // Båndpasfilter (biquad), nulstilles for hver lyd.
  const bandpass = (f, q) => {
    const w = 2 * Math.PI * f / SR, a = Math.sin(w) / (2 * q), a0 = 1 + a;
    const b0 = a / a0, a1 = -2 * Math.cos(w) / a0, a2 = (1 - a) / a0;
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    return (x) => { const y = b0 * x - b0 * x2 - a1 * y1 - a2 * y2; x2 = x1; x1 = x; y2 = y1; y1 = y; return y; };
  };
  const put = (t0, len, pan, fn) => {
    const s0 = Math.round(t0 * SR), n = Math.round(len * SR);
    const gl = Math.cos((pan + 1) * Math.PI / 4), gr = Math.sin((pan + 1) * Math.PI / 4);
    for (let i = 0; i < n; i++) { const j = s0 + i; if (j < 0 || j >= N) continue; const v = fn(i / SR, i); Lc[j] += v * gl; Rc[j] += v * gr; }
  };
  // Enkelt lavpas (én pol), nulstilles for hver lyd.
  const lowpass = (f) => { const k = 1 - Math.exp(-2 * Math.PI * f / SR); let y = 0; return (x) => (y += k * (x - y)); };
  for (const e of film.events) {
    seed = Math.round(e.t * 1000) + (e.s || 0) * 7 + 1;
    if (e.k === 'key' || e.k === 'space' || e.k === 'soft') {
      // Blødt, dæmpet »thock« som en tast med filt under: en lav tone med kort krop og kun lidt
      // lavpasfiltreret støj i anslaget. Tonehøjde og styrke varierer lidt fra slag til slag.
      const sp = e.k === 'space', so = e.k === 'soft';
      const amp = (e.v ?? 1) * (0.7 + 0.5 * rnd()) * (so ? 0.6 : 1);
      const f0 = (sp ? 82 : so ? 128 : 108) * (0.88 + 0.24 * rnd()), body = sp ? 0.05 : so ? 0.028 : 0.038;
      const lp = lowpass(so ? 900 : 1300), bp = bandpass(420 + 160 * rnd(), 0.8);
      put(e.t, 0.22, e.pan || 0, (t) => {
        const att = Math.min(1, t / 0.003);
        const tone = Math.sin(2 * Math.PI * (f0 * (1 + 0.5 * Math.exp(-t / 0.012))) * t) * Math.exp(-t / body);
        const knock = bp(lp(noise())) * Math.exp(-t / 0.014) * 2.2;
        return amp * att * (tone * 0.85 + knock);
      });
    } else if (e.k === 'return') {
      // Linjeskift og vognretur: et blødt, mørkt strøg og et dæmpet stop.
      const bp = bandpass(380, 0.8), lp = lowpass(1200), len = 0.3;
      put(e.t, len, 0, (t) => (e.v ?? 1) * 0.9 * bp(lp(noise())) * Math.sin(Math.PI * t / len) ** 2);
      put(e.t + 0.26, 0.2, -0.2, (t) => (e.v ?? 1) * 0.3 * Math.sin(2 * Math.PI * 78 * t) * Math.exp(-t / 0.04) * Math.min(1, t / 0.004));
    } else if (e.k === 'scene') {
      // Sceneskift: papiret rykker en linje.
      const bp = bandpass(340, 0.7), lp = lowpass(1000), len = 0.5;
      put(e.t, len, 0, (t) => 0.8 * bp(lp(noise())) * Math.min(1, t / 0.12) * Math.exp(-Math.max(0, t - 0.12) / 0.12));
    } else if (e.k === 'tone') {
      // En enkelt blød tone på slutbilledet.
      put(e.t, 1.6, 0, (t) => 0.3 * Math.min(1, t / 0.02) * Math.exp(-t / 0.4) * (Math.sin(2 * Math.PI * e.f * t) + 0.2 * Math.sin(2 * Math.PI * e.f * 1.5 * t)));
    }
  }
  // Normalisér, så toppene ligger ved -20 dBFS. Derefter en næsten uhørlig rumtone.
  let peak = 0; for (let i = 0; i < N; i++) peak = Math.max(peak, Math.abs(Lc[i]), Math.abs(Rc[i]));
  const g = peak ? 10 ** (-20 / 20) / peak : 0;
  seed = 4242; let bl = 0, br = 0;
  for (let i = 0; i < N; i++) {
    bl = bl * 0.995 + noise() * 0.005; br = br * 0.995 + noise() * 0.005;   // brun støj
    const t = i / SR, fade = Math.min(1, t / 0.4, (film.DUR - t) / 0.4);
    Lc[i] = (Lc[i] * g + bl * 0.012) * fade; Rc[i] = (Rc[i] * g + br * 0.012) * fade;
  }
  const buf = Buffer.alloc(44 + N * 4);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + N * 4, 4); buf.write('WAVEfmt ', 8); buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22); buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 4, 28);
  buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(N * 4, 40);
  let pk = 0;
  for (let i = 0; i < N; i++) {
    pk = Math.max(pk, Math.abs(Lc[i]), Math.abs(Rc[i]));
    buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, Lc[i])) * 32767), 44 + i * 4);
    buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, Rc[i])) * 32767), 46 + i * 4);
  }
  return { buf, peakDb: 20 * Math.log10(pk) };
}

// ---------- ét format: billeder ind i ffmpeg, lyd ved siden af ----------
async function renderFormat(edge, format) {
  const film = await openFilm(edge, format);
  const stills = join(HER, 'stills'); mkdirSync(stills, { recursive: true });
  if (arg('--preview')) {
    for (const [i, t] of STILLS.entries()) writeFileSync(join(stills, `${format}-${String(i + 1).padStart(2, '0')}.png`), await frame(edge, t));
    console.log(`${format}: ${STILLS.length} stillbilleder (direkte fra film.html)`);
    return;
  }
  const tmp = mkdtempSync(join(tmpdir(), 'gt-film-lyd-'));
  const wav = join(tmp, 'lyd.wav');
  const { buf, peakDb } = synth(film);
  writeFileSync(wav, buf);
  console.log(`${format}: lydspor klar, top ${peakDb.toFixed(1)} dBFS, ${film.events.length} lyde`);
  const out = join(HER, `gode-tekster-${format}.mp4`);
  const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(film.FPS), '-c:v', 'png', '-i', '-',
    '-i', wav, '-map', '0:v', '-map', '1:a',
    '-vf', 'scale=out_color_matrix=bt709:out_range=tv,format=yuv420p', '-c:v', 'libx264', '-preset', 'slow', '-crf', '15',
    '-profile:v', 'high', '-r', String(film.FPS), '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709',
    '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-ac', '2', '-t', String(film.DUR), '-movflags', '+faststart', out],
  { stdio: ['pipe', 'inherit', 'inherit'] });
  const done = new Promise((res, rej) => { ff.on('close', (c) => (c === 0 ? res() : rej(new Error('ffmpeg fejlede med kode ' + c)))); ff.on('error', rej); });
  const total = film.DUR * film.FPS, start = Date.now();
  for (let i = 0; i < total; i++) {
    const png = await frame(edge, i / film.FPS);
    if (!ff.stdin.write(png)) await new Promise((r) => ff.stdin.once('drain', r));
    if (i % 150 === 0) console.log(`${format}: billede ${i}/${total}`);
  }
  ff.stdin.end();
  await done;
  rmSync(tmp, { recursive: true, force: true });
  // Stillbillederne tages fra den færdige MP4, så det er selve filmen, der ses efter.
  for (const [i, t] of STILLS.entries()) {
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-ss', String(t), '-i', out, '-frames:v', '1', join(stills, `${format}-${String(i + 1).padStart(2, '0')}.png`)]);
  }
  console.log(`${format}: færdig på ${((Date.now() - start) / 1000).toFixed(0)} sek. → ${out}`);
}

await waitForRoom();
const edge = await startEdge();
try {
  for (const f of formats) await renderFormat(edge, f);   // ét ad gangen, aldrig parallelt
} finally {
  await edge.close();
}
