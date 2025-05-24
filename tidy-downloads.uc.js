// userChrome.js / download_preview_mistral_pixtral_rename.uc.js
// AI-powered download preview and renaming with Mistral vision API support
(function () {
  "use strict";

  // Use Components for Firefox compatibility
  const { classes: Cc, interfaces: Ci } = Components;

  // Wait for browser window to be ready
  if (location.href !== "chrome://browser/content/browser.xhtml") return;

  // --- Configuration ---
  const MISTRAL_API_URL = "https://api.mistral.ai/v1/chat/completions"; // Mistral API endpoint
  const MISTRAL_MODEL = "pixtral-large-latest"; // Vision-capable Mistral model for image analysis
  let ENABLE_AI_RENAMING = true; // Toggle AI renaming feature
  const MISTRAL_API_KEY_PREF = "extensions.downloads.mistral_api_key"; // Pref name for API key storage
  const DISABLE_AUTOHIDE_PREF = "extensions.downloads.disable_autohide"; // Pref to disable auto-hiding
  const AI_RENAMING_MAX_FILENAME_LENGTH = 70; // Maximum length for AI-generated filenames
  const CARD_AUTOHIDE_DELAY_MS = 20000; // How long cards stay visible after completion
  const MAX_CARDS_DOM_LIMIT = 10; // Maximum number of download cards shown at once
  const CARD_INTERACTION_GRACE_PERIOD_MS = 5000; // Grace period before auto-hide after user interaction
  const PREVIEW_SIZE = "42px"; // Size of preview icons
  const IMAGE_LOAD_ERROR_ICON = "🚫"; // Icon shown when image preview fails
  const TEMP_LOADER_ICON = "⏳"; // Temporary loader icon while waiting
  const RENAMED_SUCCESS_ICON = "✓"; // Icon shown after successful rename
  const DEBUG_LOGGING = true; // Enable detailed logging
  const IMAGE_EXTENSIONS = new Set([
    ".jpg",
    ".jpeg",
    ".png",
    ".gif",
    ".webp",
    ".bmp",
    ".svg",
    ".avif",
  ]);
  // --- End Configuration ---

  // Global state variables
  let downloadCardsContainer;
  const activeDownloadCards = new Map();
  let renamedFiles = new Set(); // Track files we've attempted to rename
  let aiRenamingPossible = false; // Will be set to true if API key exists and connection works

  // Add debug logging function
  function debugLog(message, data = null) {
    if (!DEBUG_LOGGING) return;
    const timestamp = new Date().toISOString();
    if (data) {
      console.log(`[${timestamp}] Download Preview: ${message}`, data);
    } else {
      console.log(`[${timestamp}] Download Preview: ${message}`);
    }
  }

  // Robust initialization
  function init() {
    debugLog("Starting initialization");
    if (!window.Downloads?.getList) {
      console.error("Download Preview Mistral AI: Downloads API not available");
      aiRenamingPossible = false;
      ENABLE_AI_RENAMING = false;
      return;
    }
    try {
      window.Downloads.getList(window.Downloads.ALL)
        .then(async (list) => {
          if (list) {
            debugLog("Downloads API verified");
            await verifyMistralConnection();
            if (aiRenamingPossible) {
              debugLog("AI renaming enabled - all systems verified");
            } else {
              debugLog("AI renaming disabled - Mistral connection failed");
            }
            initDownloadManager();
            debugLog("Initialization complete");
          }
        })
        .catch((e) => {
          console.error("Downloads API verification failed:", e);
          aiRenamingPossible = false;
          ENABLE_AI_RENAMING = false;
        });
    } catch (e) {
      console.error("Download Preview Mistral AI: Init failed", e);
      aiRenamingPossible = false;
      ENABLE_AI_RENAMING = false;
    }
  }

  // Wait for window load
  if (document.readyState === "complete") {
    init();
  } else {
    window.addEventListener("load", init, { once: true });
  }

  // Download manager UI and listeners
  function initDownloadManager() {
    try {
      // Create container if it doesn't exist
      downloadCardsContainer = document.getElementById(
        "userchrome-download-cards-container"
      );
      if (!downloadCardsContainer) {
        downloadCardsContainer = document.createElement("div");
        downloadCardsContainer.id = "userchrome-download-cards-container";
        // Strong floating style for bottom left
        downloadCardsContainer.setAttribute(
          "style",
          `
          position: fixed !important;
          left: 20px !important;
          bottom: 20px !important;
          z-index: 2147483647 !important;
          max-width: 400px;
          min-width: 280px;
          display: flex;
          flex-direction: column;
          gap: 10px;
          pointer-events: auto;
        `
        );
        document.body.appendChild(downloadCardsContainer);
      }
      // Attach listeners
      let downloadListener = {
        onDownloadAdded: createOrUpdateCard,
        onDownloadChanged: createOrUpdateCard,
        onDownloadRemoved: (dl) => removeCard(getDownloadKey(dl), false),
      };
      window.Downloads.getList(window.Downloads.ALL)
        .then((list) => {
          list.addView(downloadListener);
          list.getAll().then((all) =>
            all.forEach((dl) => {
              createOrUpdateCard(dl, true);
            })
          );
        })
        .catch((e) => console.error("DL Preview Mistral AI: List error:", e));
    } catch (e) {
      console.error("DL Preview Mistral AI: Init error", e);
    }
  }

  // Helper to get a unique key for a download (id or fallback to target.path)
  function getDownloadKey(download) {
    return download?.id ?? download?.target?.path ?? null;
  }

  // Function to create or update a download card
  function createOrUpdateCard(download, isNewCardOnInit = false) {
    const key = getDownloadKey(download);
    if (!key) {
      debugLog("Skipping download object without usable key", download);
      return null;
    }
    // --- Prevent duplicate cards for the same download, even after renaming ---
    let cardData = activeDownloadCards.get(key);
    // If not found, try to find by id or old path
    if (!cardData && download.id) {
      cardData = activeDownloadCards.get(download.id);
    }
    if (!cardData && download.target && download.target.path) {
      cardData = activeDownloadCards.get(download.target.path);
    }
    // If cardData exists but the key has changed (e.g., after rename), move it to the new key
    if (cardData && !activeDownloadCards.has(key)) {
      // Remove from old key(s)
      for (const [k, v] of activeDownloadCards.entries()) {
        if (v === cardData) activeDownloadCards.delete(k);
      }
      // Add to new key
      activeDownloadCards.set(key, cardData);
      // Update DOM attributes
      if (cardData.cardElement) {
        cardData.cardElement.id = `userchrome-download-card-${String(key).replace(/[^\u0000-\u007F\w-]/g, "_")}`;
        cardData.cardElement.dataset.downloadId = String(key).replace(/[^\u0000-\u007F\w-]/g, "_");
      }
    }
    // --- End duplicate prevention ---
    debugLog("[FUNC] createOrUpdateCard called", download);
    debugLog(
      `[STATE] key=${key}, id=${download.id}, succeeded=${download.succeeded}, stopped=${download.stopped}, canceled=${download.canceled}, error=${download.error}, filename=${download.filename}`
    );
    // Generate safe IDs and names for DOM elements
    const safeId = String(key).replace(/[^\u0000-\u007F\w-]/g, "_");
    // Robust filename fallback
    const safeFilename =
      download.filename ||
      (download.target && download.target.path
        ? download.target.path.split(/[\\/]/).pop()
        : null) ||
      "Untitled";
    const safePreviewUrl = download.url || "";
    // Use AI-generated name if present, else fallback to filename
    const displayName =
      download && typeof download.aiName === "string" && download.aiName.trim()
        ? download.aiName.trim()
        : safeFilename;
    // Get or create card element
    let cardElement;
    if (cardData && cardData.cardElement) {
      // Update existing card
      cardElement = cardData.cardElement;
    } else {
      // Create new card
      cardElement = document.createElement("div");
      cardElement.className = "modern-download-card";
      cardElement.id = `userchrome-download-card-${safeId}`;
      cardElement.dataset.downloadId = safeId;
      try {
        // Card HTML (replace <button> with <span> for Firefox userChrome safety)
        cardElement.innerHTML = `
          <div style="background:rgba(0,0,0,0.90);border-radius:14px;box-shadow:0 2px 8px rgba(0,0,0,0.25);display:flex;align-items:center;padding:14px 20px 14px 14px;min-width:340px;max-width:410px;margin-bottom:10px;">
            <div class="card-preview-container" style="flex:0 0 44px;width:44px;height:44px;display:flex;align-items:center;justify-content:center;background:rgba(255,255,255,0.07);border-radius:8px;overflow:hidden;margin-right:14px;"></div>
            <div style="flex:1;min-width:0;">
              <div class="card-desc" style="font-size:13px;color:#b5b5b5;margin-top:2px;">Download renamed to:</div>
              <div class="card-title" style="font-size:15px;font-weight:600;line-height:1.3;color:white;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${displayName}</div>
              <div class="card-id" style="font-size:12px;color:#8e8e8e;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${safeId.substring(
                0,
                8
              )}</div>
            </div>
            <span class="card-button card-close-button" title="Close" tabindex="0" role="button" style="margin-left:10px;background:none;border:none;color:#bbb;font-size:18px;cursor:pointer;">✕</span>
          </div>
        `;
        debugLog(
          "Card HTML assigned with modern style (button replaced with span)"
        );
        // Add close handler for span (fix for Firefox node removal)
        const closeBtn = cardElement.querySelector(".card-close-button");
        if (closeBtn) {
          closeBtn.addEventListener("click", () => removeCard(key, true));
          closeBtn.addEventListener("keydown", (e) => {
            if (e.key === "Enter" || e.key === " ") removeCard(key, true);
          });
        }
        // Add preview/icon
        const previewElement = cardElement.querySelector(
          ".card-preview-container"
        );
        if (previewElement) {
          if (download.succeeded) {
            setCompletedFilePreview(previewElement, download);
          } else {
            // Robust contentType fallback
            setGenericIcon(
              previewElement,
              typeof download.contentType === "string"
                ? download.contentType
                : "application/octet-stream"
            );
          }
        }
        if (typeof processDownloadForAIRenaming === "function") {
          try {
            const statusEl = cardElement.querySelector(".card-desc");
            if (statusEl) {
              processDownloadForAIRenaming(download, safeFilename, key); // Pass key for consistent lookup
            } else {
              debugLog("processDownloadForAIRenaming: statusEl is null");
            }
          } catch (e) {
            debugLog("Error in processDownloadForAIRenaming:", e);
          }
        }
      } catch (domErr) {
        debugLog("Error creating download card DOM:", domErr, {
          safeId,
          safeFilename,
          safePreviewUrl,
          download,
        });
        return;
      }
      // Store reference
      activeDownloadCards.set(key, {
        cardElement,
        download,
        complete: false,
        progressUpdateTimeout: null,
      });
      // Add to container
      if (downloadCardsContainer) {
        debugLog("[UI] Appending card to container", { cardElement, download });
        downloadCardsContainer.appendChild(cardElement);
      } else {
        debugLog("[UI] Container not found when trying to append card", {
          cardElement,
          download,
        });
      }
      // --- Trigger AI renaming as soon as download is fully completed ---
      if (
        ENABLE_AI_RENAMING &&
        aiRenamingPossible &&
        download.succeeded &&
        download.target &&
        download.target.path &&
        !cardElement.classList.contains("renaming") &&
        !renamedFiles.has(download.target.path)
      ) {
        cardElement.classList.add("renaming");
        processDownloadForAIRenaming(
          download,
          download.target.path
            ? download.target.path.split(/[\\/]/).pop()
            : "Unknown",
          key
        ).catch((e) => console.error("Error in AI renaming:", e));
      }
      // --- End renaming trigger ---
      return cardElement;
    }
    // Update card content
    const statusElement = cardElement.querySelector(".card-desc");

    // Update status based on download state
    if (statusElement) {
      if (download.error) {
        statusElement.textContent = `Error: ${
          download.error.message || "Download failed"
        }`;
        statusElement.style.color = "#ff6b6b";
      } else if (download.canceled) {
        statusElement.textContent = "Download canceled";
        statusElement.style.color = "#ff9f43";
      } else if (download.paused) {
        statusElement.textContent = "Paused";
        statusElement.style.color = "#feca57";
      } else if (download.succeeded) {
        statusElement.textContent = "Download completed";
        statusElement.style.color = "#1dd1a1";

        // Process AI renaming if enabled and not already done
        if (
          ENABLE_AI_RENAMING &&
          aiRenamingPossible &&
          download.target.path &&
          !cardElement.classList.contains("renaming") &&
          !renamedFiles.has(download.target.path)
        ) {
          cardElement.classList.add("renaming");

          // Delayed AI renaming (give time for file system to complete writes)
          setTimeout(() => {
            processDownloadForAIRenaming(
              download,
              download.target.path
                ? download.target.path.substring(
                    download.target.path.lastIndexOf("\\") + 1
                  )
                : "Unknown",
              key
            ).catch((e) => console.error("Error in AI renaming:", e));
          }, 1000);
        }
      } else if (download.hasProgress) {
        const percent =
          download.totalBytes > 0
            ? Math.round((download.bytesReceived / download.totalBytes) * 100)
            : 0;
        statusElement.textContent = `Downloading... ${percent}%`;
        statusElement.style.color = "#54a0ff";
      } else {
        statusElement.textContent = "Starting download...";
        statusElement.style.color = "#b5b5b5";
      }
    }

    // Update filename
    const filenameElement = cardElement.querySelector(".card-title");
    if (filenameElement) {
      const displayName =
        download.aiName && typeof download.aiName === "string"
          ? download.aiName.trim()
          : download.filename || "Untitled";
      filenameElement.textContent = displayName;
      filenameElement.title = displayName;
    }

    // Update size info
    const sizeElement = cardElement.querySelector(".card-id");
    if (sizeElement) {
      if (download.totalBytes > 0) {
        const downloaded = formatBytes(download.bytesReceived || 0);
        const total = formatBytes(download.totalBytes);
        sizeElement.textContent = `${downloaded} / ${total}`;
      } else {
        sizeElement.textContent = "Calculating size...";
      }
    }

    // Mark as complete if download is done
    if (download.succeeded && !cardData.complete) {
      cardData.complete = true;
      cardElement.classList.add("completed");

      // Set preview for completed file if not already set
      const previewElement = cardElement.querySelector(
        ".card-preview-container"
      );
      if (previewElement) {
        setCompletedFilePreview(previewElement, download);
      }
    }

    return cardElement;
  }

  // Schedule card removal after delay
  // Remove a download card from the UI
  function removeCard(downloadId, force = false) {
    try {
      // Always use getDownloadKey for lookup
      const card = document.querySelector(`[data-download-id="${downloadId}"]`);
      if (!card) return false;
      // Don't remove if user has interacted with it recently unless forced
      const cardData = activeDownloadCards.get(downloadId);
      if (
        !force &&
        cardData &&
        cardData.lastInteractionTime &&
        Date.now() - cardData.lastInteractionTime <
          CARD_INTERACTION_GRACE_PERIOD_MS
      ) {
        return false;
      }
      // Animation for smooth removal
      card.style.transition = "opacity 0.3s, transform 0.3s";
      card.style.opacity = "0";
      card.style.transform = "translateY(-20px)";
      setTimeout(() => {
        if (card.parentNode) {
          card.parentNode.removeChild(card);
          activeDownloadCards.delete(downloadId);
          debugLog(`Card removed for download ID: ${downloadId}`);
        }
      }, 300);
      return true;
    } catch (e) {
      console.error("Error removing card:", e);
      return false;
    }
  }

  function scheduleCardRemoval(downloadId) {
    try {
      const disableAutohide = getPref(DISABLE_AUTOHIDE_PREF, false);
      if (disableAutohide) return;

      setTimeout(() => {
        removeCard(downloadId, false);
      }, CARD_AUTOHIDE_DELAY_MS);
    } catch (e) {
      console.error("Error scheduling card removal:", e);
    }
  }

  // Update card status temporarily
  function updateCardStatusTemporary(
    downloadId,
    statusText,
    isError = false,
    duration = 3000
  ) {
    try {
      const cardData = activeDownloadCards.get(downloadId);
      if (!cardData) return;

      const statusEl = cardData.cardElement.querySelector(
        ".userchrome-download-card-status"
      );
      if (!statusEl) return;

      const originalText = statusEl.textContent;
      const originalClass = statusEl.className;

      // Set temporary status
      statusEl.textContent = statusText;
      if (isError) {
        statusEl.classList.add("error");
      }

      // Reset after duration
      setTimeout(() => {
        if (activeDownloadCards.has(downloadId)) {
          statusEl.textContent = originalText;
          statusEl.className = originalClass;
        }
      }, duration);
    } catch (e) {
      console.error("Error updating card status temporarily:", e);
    }
  }

  // Helper function to get preferences
  function getPref(prefName, defaultValue) {
    try {
      const prefService = Components.classes[
        "@mozilla.org/preferences-service;1"
      ].getService(Components.interfaces.nsIPrefService);
      const branch = prefService.getBranch("");

      if (typeof defaultValue === "boolean") {
        return branch.getBoolPref(prefName, defaultValue);
      } else if (typeof defaultValue === "string") {
        return branch.getStringPref(prefName, defaultValue);
      } else if (typeof defaultValue === "number") {
        return branch.getIntPref(prefName, defaultValue);
      }

      return defaultValue;
    } catch (e) {
      console.error("Error getting preference:", e);
      return defaultValue;
    }
  }

  // Set generic icon for file type
  function setGenericIcon(previewElement, contentType) {
    if (!previewElement) {
      debugLog("setGenericIcon: previewElement is null");
      return;
    }
    try {
      let icon = "📄";
      if (typeof contentType === "string") {
        if (contentType.includes("image/")) icon = "🖼️";
        else if (contentType.includes("video/")) icon = "🎬";
        else if (contentType.includes("audio/")) icon = "🎵";
        else if (contentType.includes("text/")) icon = "📝";
        else if (contentType.includes("application/pdf")) icon = "📕";
        else if (
          contentType.includes("application/zip") ||
          contentType.includes("application/x-rar")
        )
          icon = "🗜️";
      
