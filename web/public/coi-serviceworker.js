if (typeof window === "undefined") {
  self.addEventListener("install", () => self.skipWaiting());
  self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
  self.addEventListener("fetch", (event) => {
    const request = event.request;
    if (request.cache === "only-if-cached" && request.mode !== "same-origin") return;
    event.respondWith(isolate(request));
  });
} else if (!crossOriginIsolated && navigator.serviceWorker) {
  const script = document.currentScript;
  if (script instanceof HTMLScriptElement && sessionStorage.getItem("coi-reload") !== "1") {
    sessionStorage.setItem("coi-reload", "1");
    navigator.serviceWorker.register(script.src).then((registration) => {
      if (registration.active && !navigator.serviceWorker.controller) location.reload();
    });
    let reloading = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (reloading) return;
      reloading = true;
      location.reload();
    });
  }
}

async function isolate(request) {
  const response = await fetch(request);
  if (response.status === 0) return response;
  const headers = new Headers(response.headers);
  headers.set("Cross-Origin-Embedder-Policy", "require-corp");
  headers.set("Cross-Origin-Opener-Policy", "same-origin");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
