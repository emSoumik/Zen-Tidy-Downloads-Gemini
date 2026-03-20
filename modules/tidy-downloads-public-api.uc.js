// ==UserScript==
// @include   main
// @loadOrder 99999999999999
// @ignorecache
// ==/UserScript==

// tidy-downloads-public-api.uc.js
// window.zenTidyDownloads surface for zen-stuff and other integrations (registries + pile helpers)
(function () {
  "use strict";

  if (location.href !== "chrome://browser/content/browser.xhtml") return;

  window.zenTidyDownloadsPublicApi = {
    /**
     * Build the global integration object. Registries live on `store`; this module only exposes methods.
     *
     * @param {Object} deps
     * @param {Object} deps.store - createStore() result (dismiss listeners, dismissedPodsData, maps, caps, …)
     * @param {function} deps.debugLog
     * @param {Object} deps.SecurityUtils
     * @param {Object} deps.DownloadsAdapter
     * @param {function} deps.getDownloadKey
     * @param {function} deps.getThrottledCreateOrUpdateCard
     * @param {function} deps.fireCustomEvent
     * @param {typeof Components.classes} deps.Cc
     * @param {typeof Components.interfaces} deps.Ci
     * @returns {Object} window.zenTidyDownloads
     */
    createPublicApi(deps) {
      const {
        store,
        debugLog,
        SecurityUtils,
        DownloadsAdapter,
        getDownloadKey,
        getThrottledCreateOrUpdateCard,
        fireCustomEvent,
        Cc,
        Ci
      } = deps;

      const {
        dismissEventListeners,
        actualDownloadRemovedEventListeners,
        dismissedPodsData,
        dismissedDownloads,
        permanentlyDeletedPaths,
        permanentlyDeletedMeta,
        MAX_PERMANENTLY_DELETED_PATHS,
        activeDownloadCards,
        stickyPods
      } = store;

      return {
        onPodDismissed(callback) {
          if (typeof callback === "function") {
            dismissEventListeners.add(callback);
            debugLog("[API] Registered pod dismiss listener");
          }
        },

        offPodDismissed(callback) {
          dismissEventListeners.delete(callback);
          debugLog("[API] Unregistered pod dismiss listener");
        },

        dismissedPods: {
          getAll: () => new Map(dismissedPodsData),
          get: (key) => dismissedPodsData.get(key),
          count: () => dismissedPodsData.size,
          clear: () => {
            dismissedPodsData.clear();
            debugLog("[API] Cleared all dismissed pods data");
          }
        },

        get activeDownloadCards() {
          return activeDownloadCards;
        },

        get stickyPods() {
          return stickyPods;
        },

        onActualDownloadRemoved(callback) {
          if (typeof callback === "function") {
            actualDownloadRemovedEventListeners.add(callback);
            debugLog("[API] Registered actual download removed listener");
          }
        },

        offActualDownloadRemoved(callback) {
          actualDownloadRemovedEventListeners.delete(callback);
          debugLog("[API] Unregistered actual download removed listener");
        },

        async restorePod(podKey) {
          debugLog(`[API] Restore pod requested: ${podKey}`);
          const dismissedData = dismissedPodsData.get(podKey);
          if (!dismissedData) {
            debugLog(`[API] Cannot restore pod - no dismissed data found: ${podKey}`);
            return false;
          }

          try {
            dismissedDownloads.delete(podKey);
            dismissedPodsData.delete(podKey);

            const list = await DownloadsAdapter.getAllDownloadsList();
            if (!list) {
              debugLog(`[API] Downloads list unavailable for restoration: ${podKey}`);
              return false;
            }
            const downloads = await list.getAll();
            const download = downloads.find((dl) => getDownloadKey(dl) === podKey);

            if (download) {
              debugLog(`[API] Found download for restoration: ${podKey}`);
              getThrottledCreateOrUpdateCard()(download, true);
              fireCustomEvent("pod-restored-from-pile", { podKey, download });
              return true;
            }
            debugLog(`[API] Download no longer exists in Firefox for restoration: ${podKey}`);
            return false;
          } catch (error) {
            debugLog(`[API] Error restoring pod ${podKey}:`, error);
            return false;
          }
        },

        permanentDelete(podKey) {
          debugLog(`[API] Permanent delete requested: ${podKey}`);
          const podData = dismissedPodsData.get(podKey);
          const wasPresent = dismissedPodsData.delete(podKey);

          const normalizePath = (p) => (typeof p === "string" ? p.replace(/\\/g, "/").toLowerCase() : "");
          dismissedDownloads.delete(podKey);
          const pathsToAllow = new Set();
          if (podData?.targetPath) {
            pathsToAllow.add(normalizePath(podData.targetPath));
          }
          if (podKey && !podKey.startsWith("temp_") && (podKey.includes("/") || podKey.includes("\\"))) {
            pathsToAllow.add(normalizePath(podKey));
          }
          for (const norm of pathsToAllow) {
            if (!norm) continue;
            try {
              const deletedTime = podData?.startTime ? new Date(podData.startTime).getTime() : Date.now();
              permanentlyDeletedMeta.set(norm, { startTime: deletedTime });
            } catch (e) {
              debugLog("[PermanentDelete] Failed to record deletion time meta", { error: e, norm });
            }
            for (const dk of [...dismissedDownloads]) {
              if (normalizePath(dk) === norm) dismissedDownloads.delete(dk);
            }
            permanentlyDeletedPaths.add(norm);
            if (permanentlyDeletedPaths.size > MAX_PERMANENTLY_DELETED_PATHS) {
              const first = permanentlyDeletedPaths.values().next().value;
              if (first) permanentlyDeletedPaths.delete(first);
            }
            if (permanentlyDeletedMeta.size > MAX_PERMANENTLY_DELETED_PATHS) {
              const firstMeta = permanentlyDeletedMeta.keys().next().value;
              if (firstMeta) permanentlyDeletedMeta.delete(firstMeta);
            }
          }

          if (wasPresent) {
            fireCustomEvent("pod-permanently-deleted", { podKey });
          }

          return wasPresent;
        },

        /**
         * @param {Object} podData
         * @returns {Promise<boolean>}
         */
        async addExternalFile(podData) {
          debugLog(`[API] Add external file requested: ${podData?.filename}`);

          try {
            if (!podData || typeof podData !== "object") {
              throw new Error("Invalid pod data: must be an object");
            }

            const requiredFields = ["key", "filename", "targetPath"];
            const missingFields = requiredFields.filter((field) => !podData[field]);
            if (missingFields.length > 0) {
              throw new Error(`Invalid pod data: missing required fields: ${missingFields.join(", ")}`);
            }

            if (typeof podData.key !== "string" || podData.key.length === 0) {
              throw new Error("Invalid pod data: key must be a non-empty string");
            }
            if (typeof podData.filename !== "string" || podData.filename.length === 0) {
              throw new Error("Invalid pod data: filename must be a non-empty string");
            }
            if (typeof podData.targetPath !== "string" || podData.targetPath.length === 0) {
              throw new Error("Invalid pod data: targetPath must be a non-empty string");
            }

            const pathValidation = SecurityUtils.validateFilePath(podData.targetPath, { strict: true });
            if (!pathValidation.valid) {
              throw new Error(`Invalid file path: ${pathValidation.error} (code: ${pathValidation.code})`);
            }

            const allowedDirs = ["Downloads", "Desktop", "Documents", "Pictures", "Videos", "Music"];
            const pathLower = podData.targetPath.toLowerCase();
            const isInAllowedDir = allowedDirs.some((dir) => pathLower.includes(dir.toLowerCase()));
            if (!isInAllowedDir) {
              debugLog(`[API] Warning: File path is outside common directories: ${podData.targetPath}`);
            }

            const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
            file.initWithPath(podData.targetPath);

            if (!file.exists()) {
              throw new Error("File does not exist at the specified path");
            }
            if (file.isDirectory()) {
              throw new Error("Path points to a directory, not a file");
            }

            if (!podData.fileSize || podData.fileSize <= 0) {
              podData.fileSize = file.fileSize;
            }

            const MAX_FILE_SIZE = 10 * 1024 * 1024 * 1024;
            if (podData.fileSize > MAX_FILE_SIZE) {
              throw new Error(`File size exceeds maximum allowed: ${podData.fileSize} bytes`);
            }

            dismissedPodsData.set(podData.key, podData);

            dismissEventListeners.forEach((callback) => {
              try {
                callback(podData);
              } catch (error) {
                debugLog(`[API] Error in dismiss event listener:`, error);
              }
            });

            fireCustomEvent("external-file-added-to-stuff", { podData });

            debugLog(`[API] Successfully added external file: ${podData.filename}`);
            return true;
          } catch (error) {
            const errorInfo = {
              error: error.message || error.toString(),
              name: error.name || "Error",
              filename: podData?.filename,
              path: podData?.targetPath
            };
            debugLog(`[API] Error adding external file:`, errorInfo);
            throw error;
          }
        }
      };
    }
  };
})();
