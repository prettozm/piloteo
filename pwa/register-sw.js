// pwa/register-sw.js
//
// Helper d'enregistrement du Service Worker Pilotéo Next — à inclure par la
// future coquille PWA (docs/next/03_MIGRATION_V1_VERS_LOCAL_FIRST.md Phase 2,
// docs/next/05_SECURITE_CRYPTO_IDENTITE.md §12). N'EST PAS un module ES (pour
// pouvoir être inclus par un simple `<script src="./register-sw.js">` depuis
// une page statique sans bundler) ; ne dépend d'aucun npm.
//
// Ce fichier n'a AUCUN effet tant qu'il n'est pas explicitement appelé par la
// page hôte : il n'auto-exécute rien à l'import. La coquille PWA (pas encore
// créée dans ce lot — voir pwa/README.md) doit faire :
//
//   <script src="./register-sw.js"></script>
//   <script>
//     PiloteoSW.registerServiceWorker({
//       swUrl: "./service-worker.js",
//       onUpdateAvailable(reload) {
//         // Afficher un bandeau/notif UI ; ne PAS recharger automatiquement.
//         // `reload()` déclenche le skipWaiting + rechargement quand
//         // l'utilisateur clique explicitement (ex. "Recharger maintenant").
//       },
//     });
//   </script>
//
// Pré-requis : contexte sécurisé (HTTPS, ou http://localhost en dev).
// `navigator.serviceWorker` est absent sur `file://` et sur HTTP non-local —
// `registerServiceWorker` résout alors `{registered:false, reason:"unsupported"}`
// sans lever d'exception (voir docs/next/01 §18 : « file:// n'est pas une
// cible supportée »).

(function (global) {
  "use strict";

  /**
   * Enregistre le Service Worker et détecte une mise à jour disponible.
   *
   * @param {Object} options
   * @param {string} options.swUrl - URL du script service-worker.js.
   * @param {string} [options.scope] - scope d'enregistrement (défaut: dossier de swUrl).
   * @param {(reload: () => void) => void} [options.onUpdateAvailable] -
   *   appelé UNE FOIS qu'un nouveau SW est en état `installed`/`waiting` alors
   *   qu'un SW précédent contrôle déjà la page (donc une vraie mise à jour,
   *   pas la toute première installation). Reçoit une fonction `reload()` à
   *   invoquer uniquement sur action utilisateur explicite : elle envoie
   *   `{type:"SKIP_WAITING"}` au SW en attente puis recharge la page une fois
   *   qu'il a pris le contrôle. Aucun auto-reload n'est déclenché par ce module.
   * @param {(error: Error) => void} [options.onError]
   * @returns {Promise<{registered: boolean, reason?: string, registration?: ServiceWorkerRegistration}>}
   */
  async function registerServiceWorker(options) {
    const opts = options || {};
    if (typeof opts.swUrl !== "string" || opts.swUrl.length === 0) {
      throw new TypeError("registerServiceWorker: options.swUrl (string) requis");
    }

    if (!(global.isSecureContext) || !("serviceWorker" in navigator)) {
      // Contexte non sécurisé (ex. file://, http:// non-localhost) ou
      // navigateur sans support SW : dégradation silencieuse, pas d'exception,
      // l'appli continue de fonctionner sans offline/installabilité.
      return { registered: false, reason: "unsupported" };
    }

    try {
      const registration = await navigator.serviceWorker.register(opts.swUrl, {
        scope: opts.scope,
      });

      // Un SW "waiting" existe déjà à l'enregistrement (ex. rechargement après
      // un premier install resté en attente) : c'est aussi une mise à jour
      // disponible à signaler, pas une auto-activation.
      if (registration.waiting && navigator.serviceWorker.controller) {
        notifyUpdate(registration, opts);
      }

      registration.addEventListener("updatefound", () => {
        const installing = registration.installing;
        if (!installing) return;
        installing.addEventListener("statechange", () => {
          if (installing.state === "installed") {
            if (navigator.serviceWorker.controller) {
              // Un contrôleur existait déjà => vraie mise à jour (pas la
              // première installation) : le nouveau SW est prêt, en attente.
              notifyUpdate(registration, opts);
            }
            // Sinon (pas de controller) : toute première installation,
            // rien à signaler comme "mise à jour".
          }
        });
      });

      return { registered: true, registration };
    } catch (err) {
      if (typeof opts.onError === "function") opts.onError(err);
      return { registered: false, reason: "error" };
    }
  }

  function notifyUpdate(registration, opts) {
    if (typeof opts.onUpdateAvailable !== "function") return;
    let reloaded = false;
    const reload = () => {
      if (reloaded) return; // idempotent : un double-clic ne recharge pas deux fois
      reloaded = true;
      const waiting = registration.waiting;
      if (!waiting) {
        global.location.reload();
        return;
      }
      const onControllerChange = () => {
        navigator.serviceWorker.removeEventListener("controllerchange", onControllerChange);
        global.location.reload();
      };
      navigator.serviceWorker.addEventListener("controllerchange", onControllerChange);
      waiting.postMessage({ type: "SKIP_WAITING" });
    };
    opts.onUpdateAvailable(reload);
  }

  global.PiloteoSW = { registerServiceWorker };
})(typeof window !== "undefined" ? window : globalThis);
