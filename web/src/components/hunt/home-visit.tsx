"use client";
// hunt: records that Home was looked at (data/home-last-visit.json) after 10 seconds on the
// page or when leaving it, never on first render, so "New since you last looked" stays put
// while it is being read.
import { useEffect } from "react";

export function HomeVisit() {
  useEffect(() => {
    // Automated checks (Playwright, headless Chrome) must never mark Home as looked at.
    if (navigator.webdriver) return;
    let sent = false;
    const send = () => {
      if (sent) return;
      sent = true;
      try {
        if (!navigator.sendBeacon?.("/api/profile/home-visit", new Blob(["{}"], { type: "application/json" }))) {
          void fetch("/api/profile/home-visit", { method: "POST", headers: { "content-type": "application/json" }, body: "{}", keepalive: true });
        }
      } catch { /* best effort */ }
    };
    const timer = setTimeout(send, 10_000);
    const onHide = () => { if (document.visibilityState === "hidden") send(); };
    window.addEventListener("pagehide", send);
    document.addEventListener("visibilitychange", onHide);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("pagehide", send);
      document.removeEventListener("visibilitychange", onHide);
      send(); // leaving Home inside the app (client navigation) counts as a visit too
    };
  }, []);
  return null;
}
