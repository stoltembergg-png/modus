import { app, type Session } from "electron";

const localizedSessions = new WeakSet<Session>();

/**
 * Resolve the OS / Electron locale the in-app browser should speak.
 * Prefer the user's preferred system languages, then app.getLocale().
 */
export function resolveBrowserLocale(): string {
  try {
    const preferred = app.getPreferredSystemLanguages?.() ?? [];
    const raw = preferred[0] ?? app.getLocale() ?? "en-US";
    return normalizeLocaleTag(raw);
  } catch {
    return "en-US";
  }
}

/** BCP 47-ish tag: underscores → hyphens, drop empty segments. */
export function normalizeLocaleTag(raw: string): string {
  const tag = raw.trim().replace(/_/g, "-");
  return tag || "en-US";
}

/**
 * Build an Accept-Language value like `pt-BR,pt;q=0.9,en;q=0.8`.
 * Sites (Google especially) key off this more than the Chromium UI language.
 */
export function buildAcceptLanguageHeader(locale = resolveBrowserLocale()): string {
  const primary = normalizeLocaleTag(locale);
  const parts = [primary];
  const language = primary.split("-")[0];
  if (language && language.toLowerCase() !== primary.toLowerCase()) {
    parts.push(`${language};q=0.9`);
  }
  if (language?.toLowerCase() !== "en") {
    parts.push("en;q=0.8");
  }
  return parts.join(",");
}

/** Google search URL that respects the user's locale (`hl=` + query). */
export function googleSearchUrl(query: string, locale = resolveBrowserLocale()): string {
  const hl = encodeURIComponent(normalizeLocaleTag(locale));
  const q = encodeURIComponent(query);
  return `https://www.google.com/search?hl=${hl}&q=${q}`;
}

/**
 * Point a browser partition at the user's language: Accept-Language on every
 * request, Chromium spell-checker list when available. Idempotent per session.
 */
export function applySessionLocale(session: Session, locale = resolveBrowserLocale()): void {
  if (localizedSessions.has(session)) {
    return;
  }
  localizedSessions.add(session);

  const acceptLanguage = buildAcceptLanguageHeader(locale);
  session.webRequest.onBeforeSendHeaders((details, callback) => {
    callback({
      requestHeaders: {
        ...details.requestHeaders,
        "Accept-Language": acceptLanguage,
      },
    });
  });

  const language = normalizeLocaleTag(locale).split("-")[0] ?? "en";
  const candidates = Array.from(
    new Set([normalizeLocaleTag(locale), language, "en-US", "en"].filter(Boolean)),
  );
  try {
    const available = new Set(session.availableSpellCheckerLanguages ?? []);
    const matched = candidates.filter((tag) => available.has(tag));
    if (matched.length > 0) {
      session.setSpellCheckerLanguages(matched);
    }
  } catch {
    // Spell-checker dictionaries are optional; Accept-Language still applies.
  }
}
