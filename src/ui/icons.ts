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
  /** AI-hjælpen ved en markering (9/10): en redaktørs pen, ikke gnister. */
  pen: svg('<path d="M4 20h4L19 9l-4-4L4 16z"></path><path d="M13 7l4 4"></path>'),
  pin: svg('<path d="M9 4h6l-1 6 3 3H7l3-3z"></path><path d="M12 13v7"></path>'),
  close: svg('<path d="M6 6l12 12M18 6L6 18"></path>'),
  // Taleboble fra Lucide (»message-circle«, ISC): feedback til Gode Medier.
  feedback: svg('<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"></path>'),
  // Wifi og wifi slukket fra Lucide (»wifi«, »wifi-off«, ISC): knappen i Ro på (6/10).
  wifi: svg('<path d="M12 20h.01"></path><path d="M2 8.82a15 15 0 0 1 20 0"></path><path d="M5 12.86a10 10 0 0 1 14 0"></path><path d="M8.5 16.43a5 5 0 0 1 7 0"></path>'),
  wifiOff: svg('<path d="M12 20h.01"></path><path d="M8.5 16.43a5 5 0 0 1 7 0"></path><path d="M5 12.86a10 10 0 0 1 5.17-2.69"></path><path d="M19 12.86a10 10 0 0 0-2-1.52"></path><path d="M2 8.82a15 15 0 0 1 4.18-2.64"></path><path d="M22 8.82a15 15 0 0 0-11.29-3.76"></path><path d="M2 2l20 20"></path>'),
  // Tandhjul fra Lucide (»settings«, ISC). Det gamle lignede en sol (2/10).
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
