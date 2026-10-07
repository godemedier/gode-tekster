// tekster.godemedier.dk: opdateringer, feedback og fejlrapporter til Gode Tekster (delbar udgave 3/10,
// plan punkt 12 og 13). Ingen afhængigheder, kun Node selv.
//
//   GET  /                          301 til godemedier.dk/apps/gode-tekster/, hvor siden om programmet bor (5/10)
//   GET  /privatliv                 privatlivserklæringen (server/sider/)
//   GET  /api/health                husets kontrakt (REGISTRY §10)
//   GET  /opdatering/latest.json    manifestet, programmet spørger efter (updater.rs)
//   GET  /hent                      den nyeste installer (til downloadsiden)
//   GET  /hent/portable             den nyeste udgave uden installation (én exe, 5/10)
//   GET  /hent/<fil>                en bestemt fil
//   PUT  /udgivelse/<fil>           udgivelsesscriptet lægger filer op (kræver UPLOAD_TOKEN)
//   POST /feedback                  »Skriv til Gode Medier« → mail
//   POST /fejl                      fejllog efter et nedbrud, kun med brugerens ja → mail
//
// Privatliv: intet gemmes. Beskeder sendes videre som mail og glemmes. IP-adresser bruges kun til
// at begrænse antallet af beskeder, som et hash med et salt, der skifter hvert døgn, og kun i
// hukommelsen. Ingen adgangslog med IP.

import { createServer } from "node:http";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

const PORT = Number(process.env.PORT ?? 3000);
const DATA = process.env.DATA_DIR ?? "/data";
const FILES = join(DATA, "filer");
const MANIFEST = join(DATA, "latest.json");
const UPLOAD_TOKEN = process.env.UPLOAD_TOKEN ?? "";
const MAILERSEND_TOKEN = process.env.MAILERSEND_KEY ?? "";
const MAIL_TO = process.env.MAIL_TO ?? "troels@godemedier.dk";
const MAIL_FROM = process.env.MAIL_FROM ?? "tekster@godemedier.dk";
const COMMIT = process.env.SOURCE_COMMIT || null;
mkdirSync(FILES, { recursive: true });

const NAME = /^[A-Za-z0-9._-]{1,100}$/;
const page = (n) => readFileSync(new URL(`./sider/${n}`, import.meta.url), "utf8");
const PAGE_PRIVACY = page("privatliv.html").replace("{{CSS}}", page("side.css"));
// Siden om programmet bor ét sted: på godemedier.dk, i samme skabelon som husets andre værktøjer.
// Serveren her er maskinrummet (download, opdatering, beskeder) og sender forsiden videre (5/10).
const PRODUCT_PAGE = "https://godemedier.dk/apps/gode-tekster/";
const ASSETS = {
  "/ikon.png": ["image/png", readFileSync(new URL("./sider/ikon.png", import.meta.url))],
};
const EMAIL = /^[^\s@<>]{1,100}@[^\s@<>]{1,100}\.[a-z]{2,}$/i;

// --- begrænsning ---------------------------------------------------------------------------------
let salt = randomBytes(16);
let saltDay = new Date().toISOString().slice(0, 10);
const hits = new Map();
let mailsToday = 0;
const MAILS_PER_DAY = 200;

function limited(req, kind, max, windowMs) {
  const day = new Date().toISOString().slice(0, 10);
  if (day !== saltDay) {
    salt = randomBytes(16);
    saltDay = day;
    hits.clear();
    mailsToday = 0;
  }
  if (mailsToday >= MAILS_PER_DAY) return true;
  // Bag Coolifys proxy: første adresse i X-Forwarded-For. Kan forfalskes, men så rammer man bare
  // døgnloftet, der beskytter mailkvoten.
  const ip = String(req.headers["x-forwarded-for"] ?? req.socket.remoteAddress ?? "").split(",")[0].trim();
  const key = kind + createHash("sha256").update(salt).update(ip).digest("hex").slice(0, 16);
  const now = Date.now();
  const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
  if (recent.length >= max) return true;
  recent.push(now);
  hits.set(key, recent);
  return false;
}

// --- hjælpere ------------------------------------------------------------------------------------
function send(res, status, body, type = "application/json; charset=utf-8", extra = {}) {
  res.writeHead(status, {
    "Content-Type": type,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
    "Referrer-Policy": "no-referrer",
    ...extra,
  });
  res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function readJson(req, max = 100 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > max) {
        reject(new Error("for stor"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("ikke json"));
      }
    });
    req.on("error", reject);
  });
}

const text = (v, max) => (typeof v === "string" ? v.slice(0, max) : "");

async function mail(subject, body, replyTo) {
  if (!MAILERSEND_TOKEN) throw new Error("MAILERSEND_KEY mangler");
  mailsToday++;
  const r = await fetch("https://api.mailersend.com/v1/email", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${MAILERSEND_TOKEN}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      // Uden en rigtig User-Agent svarer Cloudflare 403 foran MailerSend (REGISTRY, 2026-08-24).
      "User-Agent": "gode-tekster-server/1",
    },
    body: JSON.stringify({
      from: { email: MAIL_FROM, name: "Gode Tekster" },
      to: [{ email: MAIL_TO }],
      ...(replyTo ? { reply_to: { email: replyTo } } : {}),
      subject,
      text: body,
    }),
  });
  if (!r.ok) throw new Error(`MailerSend ${r.status}: ${(await r.text()).slice(0, 200)}`);
}

function authorized(req) {
  const given = Buffer.from(String(req.headers.authorization ?? "").replace(/^Bearer /, ""));
  const want = Buffer.from(UPLOAD_TOKEN);
  return UPLOAD_TOKEN.length >= 32 && given.length === want.length && timingSafeEqual(given, want);
}

function currentInstaller(platform = "windows-x86_64") {
  try {
    const m = JSON.parse(readFileSync(MANIFEST, "utf8"));
    const name = m.platforms?.[platform]?.url?.split("/").pop();
    return name && NAME.test(name) ? name : null;
  } catch {
    return null;
  }
}

// --- ruterne -------------------------------------------------------------------------------------
async function handle(req, res) {
  const url = new URL(req.url ?? "/", "http://x");
  const path = url.pathname;

  if (req.method === "GET" && path === "/api/health") return send(res, 200, { ok: true, app: "gode-tekster", commit: COMMIT });

  if (req.method === "GET" && path === "/opdatering/latest.json") {
    if (!existsSync(MANIFEST)) return send(res, 404, { fejl: "ingen udgivelse endnu" });
    return send(res, 200, readFileSync(MANIFEST));
  }

  if (req.method === "GET" && (path === "/hent" || path === "/hent/" || path === "/hent/portable")) {
    const name = currentInstaller(path === "/hent/portable" ? "windows-x86_64-portable" : "windows-x86_64");
    if (!name) return send(res, 404, "Der er ingen udgivelse endnu.", "text/plain; charset=utf-8");
    return send(res, 302, "", "text/plain", { Location: `/hent/${name}` });
  }

  if ((req.method === "GET" || req.method === "HEAD") && path.startsWith("/hent/")) {
    const name = decodeURIComponent(path.slice("/hent/".length));
    const file = join(FILES, name);
    if (!NAME.test(name) || !existsSync(file)) return send(res, 404, "Filen findes ikke.", "text/plain; charset=utf-8");
    const size = statSync(file).size;
    res.writeHead(200, {
      "Content-Type": name.endsWith(".exe") ? "application/vnd.microsoft.portable-executable" : "application/octet-stream",
      "Content-Length": size,
      "Content-Disposition": `attachment; filename="${name}"`,
      "Cache-Control": "public, max-age=3600",
      "X-Content-Type-Options": "nosniff",
    });
    return createReadStream(file).pipe(res);
  }

  if (req.method === "PUT" && path.startsWith("/udgivelse/")) {
    if (!authorized(req)) return send(res, 401, { fejl: "ikke tilladt" });
    const name = path.slice("/udgivelse/".length);
    if (!NAME.test(name)) return send(res, 400, { fejl: "ugyldigt navn" });
    const target = name === "latest.json" ? MANIFEST : join(FILES, name);
    const tmp = `${target}.upload`;
    let size = 0;
    const out = createWriteStream(tmp);
    req.on("data", (c) => {
      size += c.length;
      if (size > 150 * 1024 * 1024) {
        req.destroy();
        out.destroy();
      }
    });
    req.pipe(out);
    out.on("finish", () => {
      renameSync(tmp, target);
      console.log(`udgivelse: ${name} (${size} byte)`);
      send(res, 201, { ok: true, name, size });
    });
    out.on("error", () => {
      try {
        unlinkSync(tmp);
      } catch {}
      send(res, 500, { fejl: "kunne ikke gemme" });
    });
    return;
  }

  if (req.method === "POST" && path === "/feedback") {
    if (limited(req, "f", 5, 10 * 60 * 1000)) return send(res, 429, { fejl: "for mange beskeder" });
    const b = await readJson(req);
    const besked = text(b.besked, 5000).trim();
    if (!besked) return send(res, 400, { fejl: "tom besked" });
    const svar = text(b.svar, 200).trim();
    const replyTo = EMAIL.test(svar) ? svar : "";
    const log = text(b.log, 60000);
    await mail(
      `Gode Tekster: feedback (${text(b.version, 20)})`,
      `${besked}\n\n--\nSvar til: ${svar || "(ingen mail)"}\nVersion: ${text(b.version, 20)}\nWindows: ${text(b.windows, 100)}` +
        (log ? `\n\nFejllog:\n${log}` : ""),
      replyTo,
    );
    console.log("feedback sendt");
    return send(res, 204, "");
  }

  if (req.method === "POST" && path === "/fejl") {
    if (limited(req, "e", 3, 60 * 60 * 1000)) return send(res, 429, { fejl: "for mange rapporter" });
    const b = await readJson(req);
    const log = text(b.log, 60000);
    if (!log) return send(res, 400, { fejl: "ingen log" });
    await mail(`Gode Tekster: fejlrapport (${text(b.version, 20)})`, `Version: ${text(b.version, 20)}\nWindows: ${text(b.windows, 100)}\n\n${log}`);
    console.log("fejlrapport sendt");
    return send(res, 204, "");
  }

  if (req.method === "GET" && ASSETS[path]) {
    const [type, body] = ASSETS[path];
    return send(res, 200, body, type, { "Cache-Control": "public, max-age=86400" });
  }

  // HEAD også: nogle link-forhåndsvisninger spørger med HEAD, før de henter siden.
  if ((req.method === "GET" || req.method === "HEAD") && path === "/") {
    return send(res, 301, "", "text/plain", { Location: PRODUCT_PAGE, "Cache-Control": "public, max-age=3600" });
  }

  if (req.method === "GET" && path === "/privatliv") {
    return send(res, 200, PAGE_PRIVACY, "text/html; charset=utf-8", {
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
      "Cache-Control": "public, max-age=300",
      "Strict-Transport-Security": "max-age=31536000",
    });
  }
  return send(res, 404, { fejl: "findes ikke" });
}

createServer((req, res) => {
  handle(req, res).catch((e) => {
    // Kun fejlens art i loggen, aldrig indholdet af en besked.
    console.error(`fejl: ${String(e.message).slice(0, 200)}`);
    if (!res.headersSent) send(res, e.message === "for stor" || e.message === "ikke json" ? 400 : 502, { fejl: "kunne ikke sendes" });
  });
}).listen(PORT, () => console.log(`gode-tekster-server på ${PORT}`));
