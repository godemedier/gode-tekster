// Ikoner som faste SVG-strenge. Kun konstanter herfra må sættes med innerHTML, aldrig tekst udefra.

const svg = (d: string, extra = "") =>
  `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"${extra}>${d}</svg>`;

export const ICON = {
  // Pil op, ikke til siden (5/10): knappen går et niveau op i biblioteket.
  up: svg('<path d="M18 15l-6-6-6 6"></path>'),
  plus: svg('<path d="M12 5v14M5 12h14"></path>'),
  folder: svg('<path d="M3 6h7l2 2h9v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path>'),
  file: svg('<path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8z"></path><path d="M14 3v5h5"></path>'),
  chevronDown: svg('<path d="M6 9l6 6 6-6"></path>'),
  /** AI-hjælpen, i bjælken og ved en markering: en lup med flueben, der tjekker, ikke gnister (9/10).
   *  Før en pen, som lignede »skriv« og flød sammen med de andre streger i bjælken (21/10). */
  aiHelp: svg('<circle cx="10.5" cy="10.5" r="6.5"></circle><path d="m15.5 15.5 5 5"></path><path d="m7.8 10.6 1.9 1.9 3.6-3.8"></path>'),
  pin: svg('<path d="M9 4h6l-1 6 3 3H7l3-3z"></path><path d="M12 13v7"></path>'),
  close: svg('<path d="M6 6l12 12M18 6L6 18"></path>'),
  // Taleboble fra Lucide (»message-circle«, ISC): feedback til Gode Medier.
  feedback: svg('<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"></path>'),
  // Wifi og wifi slukket fra Lucide (»wifi«, »wifi-off«, ISC): knappen i Ro på (6/10).
  wifi: svg('<path d="M12 20h.01"></path><path d="M2 8.82a15 15 0 0 1 20 0"></path><path d="M5 12.86a10 10 0 0 1 14 0"></path><path d="M8.5 16.43a5 5 0 0 1 7 0"></path>'),
  wifiOff: svg('<path d="M12 20h.01"></path><path d="M8.5 16.43a5 5 0 0 1 7 0"></path><path d="M5 12.86a10 10 0 0 1 5.17-2.69"></path><path d="M19 12.86a10 10 0 0 0-2-1.52"></path><path d="M2 8.82a15 15 0 0 1 4.18-2.64"></path><path d="M22 8.82a15 15 0 0 0-11.29-3.76"></path><path d="M2 2l20 20"></path>'),
  // Tandhjul fra Lucide (»settings«, ISC). Det gamle lignede en sol (2/10).
  // Højrespaltens ikonbjælke (design 20/10, bud 2). Hver sin form, så de kan skelnes uden navnet
  // (21/10, bud A og B): saks, tekst med lille 1-tal, anførselstegn, A med flueben, to personer og
  // mikrofon. Saks, personer og mikrofon efter Lucide (ISC).
  scissors: svg('<circle cx="6" cy="6" r="3"></circle><circle cx="6" cy="18" r="3"></circle><path d="M8.1 8.1 20 20M8.1 15.9 20 4"></path>'),
  footnote: svg('<path d="M3 10h9M3 15h13M3 20h8"></path><path d="M17 4.5 19.5 3v7M17 10h5"></path>'),
  sources: svg('<path d="M4 7h6v6H7l-1.5 4H4zM14 7h6v6h-3l-1.5 4H14z"></path>'),
  structure: svg('<rect x="4" y="4" width="16" height="5" rx="1.5"></rect><rect x="4" y="11" width="16" height="4" rx="1.5"></rect><rect x="4" y="17" width="10" height="3" rx="1.5"></rect>'),
  language: svg('<path d="M3 16 7.5 4 12 16M4.8 12h5.4"></path><path d="m13 16.5 3 3 6-7"></path>'),
  people: svg('<circle cx="9" cy="8" r="3.5"></circle><path d="M2.5 20v-1a5 5 0 0 1 5-5h3a5 5 0 0 1 5 5v1"></path><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8M18.5 14.2a5 5 0 0 1 3 4.8v1"></path>'),
  mic: svg('<rect x="9" y="3" width="6" height="11" rx="3"></rect><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"></path>'),
  // Udskriv og eksportér nederst i højre spalte (26/10, Lucide »printer«).
  printer: svg('<path d="M6 9V3h12v6"></path><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"></path><rect x="6" y="14" width="12" height="7"></rect>'),
  // Kortenes hjørne i Fraklip: tilbage i teksten (pil, Lucide »undo-2«) og flere valg (tre prikker).
  undo: svg('<path d="M9 14 4 9l5-5"></path><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"></path>'),
  more: svg('<circle cx="5" cy="12" r="1.3"></circle><circle cx="12" cy="12" r="1.3"></circle><circle cx="19" cy="12" r="1.3"></circle>'),
  gear: svg('<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"></path><circle cx="12" cy="12" r="3"></circle>'),
};

export function iconButton(icon: string, label: string, run: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "icon-btn";
  b.title = label;
  b.setAttribute("aria-label", label);
  b.innerHTML = icon;
  b.addEventListener("click", run);
  return b;
}
