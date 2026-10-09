import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

const file = join(process.cwd(), 'film.html');
let html = readFileSync(file, 'utf8');

// 1) Opdater arrays:
html = html.replace(/const T = \[.*?\];/, "const T = [0, 6.0, 13.0, 22.0, 30.0, 38.0, 45.0];");
html = html.replace(/const TR = \[.*?\];/, "const TR = ['feed', 'side', 'feed', 'wipe', 'feed'];");

// 2) S1A og S1B:
html = html.replace(/const S1A = makeTyped\(.*?\);/s, "const S1A = makeTyped(is169 ? ['Vi skriver for', 'at tænke.'] : ['Vi skriver for', 'at tænke.'], 0.4, 20, 1);");
html = html.replace(/const S1B = makeTyped\(.*?\);/s, "const S1B = makeTyped([' '], 99, 24, 0);"); // skjult

// 3) SC array:
const newSC = `const SC = [
  { kind: 'intro' },
  { kind: 'std', lay: 'split', pic: 'essence2', cap: cap(1, is169 ? ['Derfor har du', 'brug for ro.'] : ['Derfor har du brug for ro.'], ['Ingen forstyrrende valg.', 'Bare dig og teksten.']) },
  { kind: 'std', lay: 'flip', pic: 'status', cap: cap(2, is169 ? ['Følg tanken hele', 'vejen i mål.'] : ['Følg tanken hele vejen i mål.'], ['Styr på status, og fuldt', 'overblik over ændringerne.']) },
  { kind: 'std', lay: 'split', pic: 'fakta2', cap: cap(3, is169 ? ['Lad maskinen', 'tjekke fakta.'] : ['Lad maskinen tjekke fakta.'], ['Men behold altid det', 'sidste ord selv.']) },
  { kind: 'std', lay: 'flip', pic: 'print', cap: cap(4, is169 ? ['Og send den ud ad', 'døren med stil.'] : ['Og send den ud ad døren med stil.'], ['Dit eget trykdesign,', 'lige ved hånden.']) },
  { kind: 'end' },
];`;
html = html.replace(/const SC = \[[\s\S]*?\];/, newSC);

// 4) S11 og indices
html = html.replace(/const S11 = makeTyped\(.*?\);/, "const S11 = makeTyped(['Gode Tekster'], T[5] + 0.6, 11, 1);");
html = html.replace(/T\[10\]/g, "T[5]");

// 5) Indsæt de nye PIC funktioner
const newPics = `
  essence2(s) {
    const p = Math.min(1, Math.max(0, s - 1));
    alpha(1 - easeIO(p), () => {
      box(0, 0, 900, 430, C.pynt, 3);
      line(0, 386, 900, 386, C.pynt, 3);
    });
    const W = [500, 600, 450, 520, 300];
    W.forEach((w, i) => {
      rect(40, 60 + i * 62, w, 20, C.ink);
    });
  },
  status(s) {
    const W = [540, 500, 520, 460];
    W.forEach((w, i) => { rect(20, 44 + i * 62, w, 20, C.ink); });
    
    // Sidebar animeres ind
    const bx = 550, bw = 320;
    const p = Math.min(1, Math.max(0, s));
    alpha(p, () => {
      box(bx, 20, bw, 390, C.pynt, 3);
      text('Tags', bx + 20, 60, 24, C.soft, 700);
      
      const sp = easeIO(prog(s, 2.0, 2.8)); 
      rect(bx + 20, 80, bw - 40, 40, mix('#f0f0f0', '#d4edda', sp));
      text('Kladde', bx + 40, 108, 22, mix(C.ink, C.bg, sp), 400);
      alpha(sp, () => text('Færdig', bx + 40, 108, 22, C.ink, 400));
      
      text('Versioner', bx + 20, 180, 24, C.soft, 700);
      const vp = easeIO(prog(s, 3.5, 4.5));
      alpha(vp, () => {
        rect(bx + 20, 200, bw - 40, 70, '#f9f9f9');
        text('1 minut siden', bx + 35, 230, 18, C.soft, 400);
        text('+84 nye ord, 12 fjernet', bx + 35, 256, 18, C.blue, 700);
      });
    });
  },
  fakta2(s) {
    const W = [700, 650, 680, 500];
    W.forEach((w, i) => { rect(20, 44 + i * 62, w, 20, C.ink); });
    
    const fp = easeIO(prog(s, 1.5, 2.5));
    alpha(fp, () => {
      rect(20, 44 + 2 * 62 - 14, 320, 48, C.fund);
      const bx = 120, by = 44 + 2 * 62 + 40;
      box(bx, by, 420, 130, C.line, 2);
      rect(bx, by, 420, 130, C.white);
      text('Faktatjek', bx + 20, by + 35, 22, C.ink, 700);
      rect(bx + 20, by + 60, 300, 12, C.pynt);
      rect(bx + 20, by + 84, 250, 12, C.pynt);
      
      const sealP = easeIO(prog(s, 3.0, 3.8));
      alpha(sealP, () => {
        ctx.beginPath(); ctx.arc(bx + 380, by + 35, 18, 0, 2*Math.PI); ctx.fillStyle = C.blue; ctx.fill();
        text('AI', bx + 370, by + 41, 14, C.white, 700);
      });
      
      const chkP = easeIO(prog(s, 4.5, 5.2));
      alpha(chkP, () => {
        line(bx + 20, by + 105, bx + 30, by + 115, '#28a745', 4);
        line(bx + 30, by + 115, bx + 50, by + 85, '#28a745', 4);
      });
    });
  },
  print(s) {
    const W = [500, 600, 450];
    W.forEach((w, i) => { rect(40, 60 + i * 62, w, 20, C.pynt); });

    const p = easeIO(prog(s, 1.0, 2.0));
    alpha(p, () => {
      const px = 200, py = 10, pw = 300, ph = 410;
      box(px, py, pw, ph, C.pynt, 2);
      rect(px, py, pw, ph, C.white);
      
      const headP = easeIO(prog(s, 2.5, 3.5));
      rect(px + 30, lerp(py - 20, py + 30, headP), 100, 8, C.soft);
      rect(px + pw - 60, lerp(py - 20, py + 30, headP), 30, 8, C.soft);
      rect(px + 30, py + 70, 180, 16, C.ink);
      
      for(let i=0; i<6; i++) rect(px + 30, py + 120 + i*30, pw - 60, 10, C.ink);
    });
  },
`;

html = html.replace(/const PIC = \{/, "const PIC = {" + newPics);

// 6) Design tokens (vermilion og Recursive)
html = html.replace(/blue: '#1aa3ff'/g, "blue: '#db5230'"); // Skift alle de steder blue bruges til vermilion
html = html.replace(/const MONO = 'GTMono', SERIF = 'GTSerif';/, "const MONO = 'Recursive', SERIF = 'Recursive';");
const fontPath = join(process.cwd(), '../src/assets/fonts/RecursiveHalvmono.woff2');
try {
  const recursiveBase64 = readFileSync(fontPath, 'base64');
  html = html.replace(/window\.ASSETS = \{[\s\S]*?\};/, `window.ASSETS = { mono400: "${recursiveBase64}", mono700: "${recursiveBase64}", serif400: "${recursiveBase64}", serif700: "${recursiveBase64}" };`);
} catch (e) {
  console.log("Kunne ikke indlæse Recursive font: ", e.message);
}

writeFileSync(join(process.cwd(), 'promo2.html'), html);
console.log('Done');
