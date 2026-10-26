"use strict";

const CACHE_NAME = "dama-pinoy-v2.4.0";
const APP_SHELL = [
  "./",
  "./index.html",
  "./style.css",
  "./script.js",
  "./online-rules.js",
  "./online-config.js",
  "./online.js",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-512.png",
];

self.addEventListener("install", function (event) {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then(function (cache) {
        return cache.addAll(APP_SHELL);
      })
      .then(function () {
        return self.skipWaiting();
      })
  );
});

self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches
      .keys()
      .then(function (keys) {
        return Promise.all(
          keys
            .filter(function (key) {
              return key.indexOf("dama-pinoy-") === 0 && key !== CACHE_NAME;
            })
            .map(function (key) {
              return caches.delete(key);
            })
        );
      })
      .then(function () {
        return self.clients.claim();
      })
  );
});

self.addEventListener("fetch", function (event) {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // Auth callbacks may contain a one-time PKCE code. Never cache credentials
  // or query-bearing responses, even when hosted on the app's own origin.
  if (url.search || request.headers.has("authorization")) return;

  event.respondWith(
    caches.match(request).then(function (cached) {
      if (cached) return cached;

      return fetch(request)
        .then(function (response) {
          if (response && response.ok) {
            const copy = response.clone();
            caches
              .open(CACHE_NAME)
              .then(function (cache) {
                return cache.put(request, copy);
              })
              .catch(function () {});
          }
          return response;
        })
        .catch(function () {
          if (request.mode === "navigate") {
            return caches.match("./index.html");
          }
          return Response.error();
        });
    })
  );
});
