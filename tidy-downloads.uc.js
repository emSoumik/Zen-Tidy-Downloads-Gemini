// ==UserScript==
// @include   main
// @loadOrder    99999999999999
// @ignorecache
// ==/UserScript==

// tidy-downloads.uc.js
// AI-powered download preview and renaming with Mistral vision API support
(function () {
  "use strict";

  // Use Components for Firefox compatibility
  const { classes: Cc, interfaces: Ci } = Components;

  // Wait for browser window to be ready
  if (location.href !== "chrome://browser/content/browser.xhtml") return;

  // === POPUP WINDOW EXCLUSION CHECKS ===
  // Method 1: Check window type attribute
  if (document.documentElement.getAttribute('windowtype') !== 'navigator:browser') {
    console.log('Zen Tidy Downloads: Skipping - not a main browser window (windowtype check)');
    return;
  }

  // Method 2: Check if this is a popup by examining window features
  try {
    // Check if window has minimal UI (characteristic of popups)
    if (window.toolbar && !window.toolbar.visible) {
      console.log('Zen Tidy Downloads: Skipping - appears to be a popup (toolbar check)');
      return;
    }
    
    // Check window opener (popups usually have an opener)
    if (window.opener) {
      console.log('Zen Tidy Downloads: Skipping - window has opener (popup check)');
      return;
    }
  } catch (e) {
    // If we can't check these properties, continue but log it
    console.log('Zen Tidy Downloads: Could not check window properties:', e);
  }

  // Method 3: Check for essential browser UI elements that should exist in main window
  // Wait a bit for DOM to be ready, then check for main browser elements
  setTimeout(() => {
    const mainBrowserElements = [
      '#navigator-toolbox',  // Main toolbar container
      '#browser',            // Browser element
      '#sidebar-box'         // Sidebar container
    ];
    
    const missingElements = mainBrowserElements.filter(selector => !document.querySelector(selector));
    
    if (missingElements.length > 0) {
      console.log('Zen Tidy Downloads: Skipping - missing main browser elements:', missingElements);
      return;
    }
    
    // Method 4: Check window size (popups are usually smaller)
    if (window.outerWidth < 400 || window.outerHeight < 300) {
      console.log('Zen Tidy Downloads: Skipping - window too small (likely popup)');
      return;
    }
    
    // Method 5: Check for dialog-specific attributes
    if (document.documentElement.hasAttribute('dlgtype')) {
      console.log('Zen Tidy Downloads: Skipping - dialog window detected');
      return;
    }
    
    // If all checks pass, continue with initialization
    console.log('Zen Tidy Downloads: All popup exclusion checks passed, proceeding with initialization');
    
    // === MAIN SCRIPT INITIALIZATION CONTINUES HERE ===
    // Wait for utils (handles load-order races; utils must be in theme.json scripts)
    (function tryInit(attempt) {
      if (window.zenTidyDownloadsUtils) {
        initializeMainScript();
        return;
      }
      if (attempt < 40) { // ~2 seconds max (40 * 50ms)
        setTimeout(() => tryInit(attempt + 1), 50);
        return;
      }
      console.error("[Tidy Downloads] zenTidyDownloadsUtils not loaded after 2s. Ensure tidy-downloads-utils.uc.js exists in the mod folder and is listed in theme.json scripts.");
    })(0);
  }, 100); // Small delay to ensure DOM elements are loaded

  // === MAIN SCRIPT FUNCTIONS ===
  function initializeMainScript() {
    const Utils = window.zenTidyDownloadsUtils;
    if (!Utils) return;
    const {
      getPref,
      SecurityUtils,
      RateLimiter,
      debugLog,
      redactSensitiveData,
      MISTRAL_API_KEY_PREF,
      DISABLE_AUTOHIDE_PREF,
      IMAGE_LOAD_ERROR_ICON,
      TEMP_LOADER_ICON,
      RENAMED_SUCCESS_ICON,
      IMAGE_EXTENSIONS,
      PATH_SEPARATOR,
      sanitizeFilename,
      waitForElement,
      formatBytes
    } = Utils;

    // Toast notifications from modules/toasts.uc.js
    const Toasts = window.zenTidyDownloadsToasts;
    const showSimpleToast = Toasts?.showSimpleToast || (() => {});
    const showRenameToast = Toasts?.showRenameToast || (() => null);

    // Animation module (downloads button detection, animation targeting, indicator patches)
    const animationApi = window.zenTidyDownloadsAnimation?.init({ waitForElement, debugLog }) || {
      findDownloadsButton: async () => null,
      patchDownloadsIndicatorMethods: () => {}
    };
    const { findDownloadsButton, patchDownloadsIndicatorMethods } = animationApi;

    // CRITICAL: Patch downloads indicator methods immediately to prevent errors
    patchDownloadsIndicatorMethods();
    
    // --- Configuration via Firefox Preferences ---
    // Available preferences (set in about:config):
    // extensions.downloads.mistral_api_key - Your Mistral API key (required for AI renaming)
    // extensions.downloads.enable_debug - Enable debug logging (default: false)
    // extensions.downloads.debug_ai_only - Only log AI-related messages (default: true)
    // extensions.downloads.enable_ai_renaming - Enable AI-powered file renaming (default: true)
    // extensions.downloads.disable_autohide - Disable automatic hiding of completed downloads (default: false)
    // extensions.downloads.autohide_delay_ms - Delay before auto-hiding completed downloads (default: 20000)
    // extensions.downloads.interaction_grace_period_ms - Grace period after user interaction (default: 5000)
    // extensions.downloads.max_filename_length - Maximum length for AI-generated filenames (default: 70)
    // extensions.downloads.max_file_size_for_ai - Maximum file size for AI processing in bytes (default: 52428800 = 50MB)
    // extensions.downloads.mistral_api_url - Mistral API endpoint (default: "https://api.mistral.ai/v1/chat/completions")
    // extensions.downloads.mistral_model - Mistral model to use (default: "pixtral-large-latest")
    // extensions.downloads.stable_focus_mode - Prevent focus switching during multiple downloads (default: true)
    // extensions.downloads.show_old_downloads_hours - How many hours back to show old completed downloads on startup (default: 2)
    // zen.tidy-downloads.use-library-button - Use zen-library-button instead of downloads-button for hover detection (default: false)

    // Global state variables
    let downloadCardsContainer;
    const activeDownloadCards = new Map();
    let renamedFiles = new Set();
    let aiRenamingPossible = false;
    let cardUpdateThrottle = new Map(); // Prevent rapid updates (for completion events)
    // Global UI update throttle to avoid layout storms
    let lastUIUpdateTime = 0;
    let MIN_UI_UPDATE_INTERVAL_MS = 150;
    // Text-file preview toggle (disabled by default). Images always get previews.
    let filePreviewEnabled = false;
    try {
      if (typeof getPref === "function") {
        MIN_UI_UPDATE_INTERVAL_MS = getPref("extensions.downloads.ui_update_min_interval_ms", 150);
        // Opt-in for text-file previews; images always show regardless.
        filePreviewEnabled = getPref("extensions.downloads.enable_file_preview", false);
      }
    } catch (e) {
      // Fallback to defaults if prefs are unavailable
    }
    const sidebarWidthRef = { value: "" };
    let podsRowContainerElement = null; // Renamed back from podsStackContainerElement
    let masterTooltipDOMElement = null;
    let initSidebarWidthSyncFn = () => { };
    let focusedDownloadKey = null;
    let orderedPodKeys = []; // Newest will be at the end
    let lastRotationDirection = null; // Track rotation direction: 'forward', 'backward', or null
    const dismissedDownloads = new Set(); // Track downloads that have been manually dismissed or auto-hidden
    const stickyPods = new Set(); // Keys of pods kept visible in the pods row after auto-dismiss
    const permanentlyDeletedPaths = new Set(); // Normalized paths cleared by permanent delete
    const permanentlyDeletedMeta = new Map();  // pathNorm -> { startTime }
    const MAX_PERMANENTLY_DELETED_PATHS = 50;

    // File operations module (open, erase from history, content-type)
    const fileOpsApi = window.zenTidyDownloadsFileOps?.init({ SecurityUtils, debugLog }) || {
      openDownloadedFile: () => {},
      eraseDownloadFromHistory: async () => {},
      getContentTypeFromFilename: () => "application/octet-stream"
    };
    const { openDownloadedFile, eraseDownloadFromHistory, getContentTypeFromFilename } = fileOpsApi;

    // Preview module (icons, file preview, color extraction)
    const previewApi = window.zenTidyDownloadsPreview?.init({
      IMAGE_EXTENSIONS,
      debugLog,
      getPref,
      getFocusedKey: () => focusedDownloadKey
    }) || {
      setGenericIcon: (el, ct) => {
        if (!el) return;
        let icon = "📄";
        if (typeof ct === "string") {
          if (ct.includes("image/")) icon = "🖼️";
          else if (ct.includes("video/")) icon = "🎬";
          else if (ct.includes("audio/")) icon = "🎵";
        }
        el.innerHTML = `<span style="font-size: 24px;">${icon}</span>`;
        el.style.display = "flex";
        el.style.alignItems = "center";
        el.style.justifyContent = "center";
      },
      setCompletedFilePreview: async (el, d) => {
        if (el && d) previewApi.setGenericIcon(el, d?.contentType);
      },
      updatePodGlowColor: () => {}
    };

    // AI Rename module - initialized after renameDownloadFileAndUpdateRecord is defined
    let addToAIRenameQueue = () => false;
    let removeFromAIRenameQueue = () => false;
    let cancelAIProcessForDownload = async () => false;
    let isInQueue = () => false;
    let getQueuePosition = () => -1;
    let updateQueueStatusInUI = () => {};

    // Event listeners for external scripts
    const actualDownloadRemovedEventListeners = new Set();

    // --- Dismissed Pods Management System ---
    const dismissedPodsData = new Map(); // Store dismissed pod data for pile feature
    const dismissEventListeners = new Set(); // Callbacks for pod dismiss events
    
    // Global API for dismissed pods pile feature
    window.zenTidyDownloads = {
      // Event system
      onPodDismissed: (callback) => {
        if (typeof callback === 'function') {
          dismissEventListeners.add(callback);
          debugLog('[API] Registered pod dismiss listener');
        }
      },
      
      offPodDismissed: (callback) => {
        dismissEventListeners.delete(callback);
        debugLog('[API] Unregistered pod dismiss listener');
      },
      
      // Dismissed pods access
      dismissedPods: {
        getAll: () => new Map(dismissedPodsData), // Return copy to prevent external modification
        get: (key) => dismissedPodsData.get(key),
        count: () => dismissedPodsData.size,
        clear: () => {
          dismissedPodsData.clear();
          debugLog('[API] Cleared all dismissed pods data');
        }
      },
      
      // Active downloads access (for pile script to check if hover should be disabled)
      get activeDownloadCards() {
        return activeDownloadCards;
      },

      // Sticky pods (auto-dismissed but still visible in the pods row)
      get stickyPods() {
        return stickyPods;
      },

      // Event for when a download is actually removed from Firefox's list
      onActualDownloadRemoved: (callback) => {
        if (typeof callback === 'function') {
          actualDownloadRemovedEventListeners.add(callback);
          debugLog('[API] Registered actual download removed listener');
        }
      },

      offActualDownloadRemoved: (callback) => {
        actualDownloadRemovedEventListeners.delete(callback);
        debugLog('[API] Unregistered actual download removed listener');
      },
      
      // Pod restoration
      restorePod: async (podKey) => {
        debugLog(`[API] Restore pod requested: ${podKey}`);
        const dismissedData = dismissedPodsData.get(podKey);
        if (!dismissedData) {
          debugLog(`[API] Cannot restore pod - no dismissed data found: ${podKey}`);
          return false;
        }
        
        try {
          // Remove from dismissed sets
          dismissedDownloads.delete(podKey);
          dismissedPodsData.delete(podKey);
          
          // If the download still exists in Firefox, recreate the pod
          const list = await window.Downloads.getList(window.Downloads.ALL);
          const downloads = await list.getAll();
          const download = downloads.find(dl => getDownloadKey(dl) === podKey);
          
          if (download) {
            debugLog(`[API] Found download for restoration: ${podKey}`);
            // Recreate the pod by calling our existing function
            throttledCreateOrUpdateCard(download, true);
            
            // Fire restore event
            fireCustomEvent('pod-restored-from-pile', { podKey, download });
            return true;
          } else {
            debugLog(`[API] Download no longer exists in Firefox for restoration: ${podKey}`);
            return false;
          }
        } catch (error) {
          debugLog(`[API] Error restoring pod ${podKey}:`, error);
          return false;
        }
      },
      
      // Permanent deletion
      permanentDelete: (podKey) => {
        debugLog(`[API] Permanent delete requested: ${podKey}`);
        const podData = dismissedPodsData.get(podKey); // Get before delete
        const wasPresent = dismissedPodsData.delete(podKey);
        
        // Remove from dismissedDownloads so future downloads of the same file can show.
        // Clear the exact key and any path-based keys that refer to the same file
        // (handles path format differences: backslash vs forward slash, case sensitivity).
        const normalizePath = (p) => (typeof p === "string" ? p.replace(/\\/g, "/").toLowerCase() : "");
        dismissedDownloads.delete(podKey);
        const pathsToAllow = new Set();
        if (podData?.targetPath) {
          pathsToAllow.add(normalizePath(podData.targetPath));
        }
        // Also treat podKey as path if it looks like a file path (covers path-based keys)
        if (podKey && !podKey.startsWith("temp_") && (podKey.includes("/") || podKey.includes("\\"))) {
          pathsToAllow.add(normalizePath(podKey));
        }
        for (const norm of pathsToAllow) {
          if (!norm) continue;
          // Record deletion time for this path so we can distinguish old history entries from future re-downloads
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
          fireCustomEvent('pod-permanently-deleted', { podKey });
        }
        
        return wasPresent;
      },
      
      /**
       * Add external file to Zen Stuff with comprehensive validation
       * @param {Object} podData - Pod data object with file information
       * @returns {boolean} True if file was added successfully
       * @throws {Error} If validation fails or file doesn't exist
       */
      addExternalFile: async (podData) => {
        debugLog(`[API] Add external file requested: ${podData?.filename}`);
        
        try {
          // Validate the pod data structure
          if (!podData || typeof podData !== 'object') {
            throw new Error('Invalid pod data: must be an object');
          }
          
          const requiredFields = ['key', 'filename', 'targetPath'];
          const missingFields = requiredFields.filter(field => !podData[field]);
          if (missingFields.length > 0) {
            throw new Error(`Invalid pod data: missing required fields: ${missingFields.join(', ')}`);
          }
          
          // SECURITY: Validate field types
          if (typeof podData.key !== 'string' || podData.key.length === 0) {
            throw new Error('Invalid pod data: key must be a non-empty string');
          }
          if (typeof podData.filename !== 'string' || podData.filename.length === 0) {
            throw new Error('Invalid pod data: filename must be a non-empty string');
          }
          if (typeof podData.targetPath !== 'string' || podData.targetPath.length === 0) {
            throw new Error('Invalid pod data: targetPath must be a non-empty string');
          }
          
          // SECURITY: Comprehensive path validation (strict mode for external files)
          const pathValidation = SecurityUtils.validateFilePath(podData.targetPath, { strict: true });
          if (!pathValidation.valid) {
            throw new Error(`Invalid file path: ${pathValidation.error} (code: ${pathValidation.code})`);
          }
          
          // SECURITY: Restrict to common download directories (optional but recommended)
          // Allow user to configure allowed directories if needed
          const allowedDirs = [
            'Downloads', 'Desktop', 'Documents', 'Pictures', 'Videos', 'Music'
          ];
          const pathLower = podData.targetPath.toLowerCase();
          const isInAllowedDir = allowedDirs.some(dir => pathLower.includes(dir.toLowerCase()));
          if (!isInAllowedDir) {
            debugLog(`[API] Warning: File path is outside common directories: ${podData.targetPath}`);
            // Don't block, but log for security monitoring
          }
          
          // Verify the file exists
          const file = Components.classes["@mozilla.org/file/local;1"].createInstance(Components.interfaces.nsIFile);
          file.initWithPath(podData.targetPath);
          
          if (!file.exists()) {
            throw new Error('File does not exist at the specified path');
          }
          
          // SECURITY: Validate file is actually a file (not a directory)
          if (file.isDirectory()) {
            throw new Error('Path points to a directory, not a file');
          }
          
          // Update file size if not provided
          if (!podData.fileSize || podData.fileSize <= 0) {
            podData.fileSize = file.fileSize;
          }
          
          // SECURITY: Validate file size is reasonable (prevent DoS)
          const MAX_FILE_SIZE = 10 * 1024 * 1024 * 1024; // 10GB
          if (podData.fileSize > MAX_FILE_SIZE) {
            throw new Error(`File size exceeds maximum allowed: ${podData.fileSize} bytes`);
          }
          
          // Store the pod data
          dismissedPodsData.set(podData.key, podData);
          
          // Fire dismiss event to notify the pile system
          dismissEventListeners.forEach(callback => {
            try {
              callback(podData);
            } catch (error) {
              debugLog(`[API] Error in dismiss event listener:`, error);
            }
          });
          
          // Fire custom event
          fireCustomEvent('external-file-added-to-stuff', { podData });
          
          debugLog(`[API] Successfully added external file: ${podData.filename}`);
          return true;
          
        } catch (error) {
          const errorInfo = {
            error: error.message || error.toString(),
            name: error.name || 'Error',
            filename: podData?.filename,
            path: podData?.targetPath
          };
          debugLog(`[API] Error adding external file:`, errorInfo);
          throw error;
        }
      }
    };
    
    // Helper function to fire custom events
    function fireCustomEvent(eventName, detail) {
      try {
        const event = new CustomEvent(eventName, { 
          detail, 
          bubbles: true, 
          cancelable: true 
        });
        document.dispatchEvent(event);
        debugLog(`[Events] Fired custom event: ${eventName}`, detail);
      } catch (error) {
        debugLog(`[Events] Error firing custom event ${eventName}:`, error);
      }
    }
    
    // Helper function to capture pod data for dismissal
    function capturePodDataForDismissal(downloadKey) {
      const cardData = activeDownloadCards.get(downloadKey);
      if (!cardData || !cardData.download) {
        debugLog(`[Dismiss] No card data found for capturing: ${downloadKey}`);
        return null;
      }
      
      const download = cardData.download;
      const podElement = cardData.podElement;
      
      // Capture essential data for pile reconstruction
      const dismissedData = {
        key: downloadKey,
        filename: download.aiName || cardData.originalFilename || getSafeFilename(download),
        originalFilename: cardData.originalFilename,
        fileSize: download.currentBytes || download.totalBytes || 0,
        contentType: download.contentType,
        targetPath: download.target?.path,
        sourceUrl: download.source?.url,
        startTime: download.startTime,
        endTime: download.endTime,
        dismissTime: Date.now(),
        wasRenamed: !!download.aiName,
        // Capture preview data
        previewData: null,
        dominantColor: podElement?.dataset?.dominantColor || null
      };
      
      // Try to capture preview image data
      if (podElement) {
        const previewContainer = podElement.querySelector('.card-preview-container');
        if (previewContainer) {
          const img = previewContainer.querySelector('img');
          if (img && img.src) {
            dismissedData.previewData = {
              type: 'image',
              src: img.src
            };
          } else {
            // SECURITY FIX: Don't store raw HTML, just mark as icon type
            // The icon will be regenerated safely from contentType when restored
            dismissedData.previewData = {
              type: 'icon'
              // No html field - will use contentType to regenerate icon safely
            };
          }
        }
      }
      
      debugLog(`[Dismiss] Captured pod data for pile:`, dismissedData);
      return dismissedData;
    }

    // Improved key generation for downloads
    function getDownloadKey(download) {
      // Use target path as primary key since id is often undefined
      if (download?.target?.path) {
        return download.target.path;
      }
      if (download?.id) {
        return download.id;
      }
      // For failed downloads, generate a more stable key based on URL and start time
      const url = download?.source?.url || download?.url || "unknown";
      const startTime = download?.startTime || Date.now();
      const key = `temp_${url}_${startTime}`;
      
      debugLog(`[KeyGen] Generated temporary key for download without path/id`, { 
        key, 
        hasPath: !!download?.target?.path, 
        hasId: !!download?.id, 
        url, 
        error: !!download?.error,
        startTime 
      });
      
      return key;
    }

    // Get safe filename from download object
    function getSafeFilename(download) {
      // Try multiple sources for filename
      if (download.filename) return download.filename;
      if (download.target?.path) {
        return download.target.path.split(/[\\/]/).pop();
      }
      if (download.source?.url) {
        const url = download.source.url;
        const match = url.match(/\/([^\/\?]+)$/);
        if (match) return match[1];
      }
      return "Untitled";
    }

    async function init() {
      console.log("=== DOWNLOAD PREVIEW SCRIPT STARTING ===");
      debugLog("Starting initialization");
      if (!window.Downloads?.getList) {
        console.error("Download Preview Mistral AI: Downloads API not available");
        aiRenamingPossible = false;
        return;
      }
      try {
        window.Downloads.getList(window.Downloads.ALL)
          .then(async (list) => {
            if (list) {
              debugLog("Downloads API verified");
              aiRenamingPossible = true; // Local AI is assumed to be available
              debugLog("AI renaming enabled - using Local AI");
              await initDownloadManager();
              initSidebarWidthSyncFn();
              debugLog("Initialization complete");
            }
          })
          .catch((e) => {
            console.error("Downloads API verification failed:", e);
            aiRenamingPossible = false;
          });
      } catch (e) {
        console.error("Download Preview Mistral AI: Init failed", e);
        aiRenamingPossible = false;
      }
    }

    // Wait for window load
    if (document.readyState === "complete") {
      init();
    } else {
      window.addEventListener("load", init, { once: true });
    }

    // Download manager UI and listeners
    async function initDownloadManager() {
      // Add a delay to ensure DOM is ready before creating UI elements
      await new Promise(resolve => setTimeout(resolve, 300));
      debugLog("Creating download manager UI elements...");
      
      try {
        // Find the downloads/library button for hover detection
        const downloadsButton = await findDownloadsButton();
        console.log("[Tidy Downloads] Found button:", downloadsButton);
        if (!downloadsButton) {
          console.warn("[Tidy Downloads] Downloads button not found - hover detection may not work properly");
        }
        
        // Create container if it doesn't exist
        downloadCardsContainer = document.getElementById("userchrome-download-cards-container");
        if (!downloadCardsContainer) {
          downloadCardsContainer = document.createElement("div");
          downloadCardsContainer.id = "userchrome-download-cards-container";
          // Basic styles are now in CSS file, only dynamic overrides here if needed
          
          // IMPORTANT: Start completely hidden to prevent flashing
          downloadCardsContainer.style.display = "none";
          downloadCardsContainer.style.opacity = "0";
          downloadCardsContainer.style.visibility = "hidden";
          
          // Insert after media controls toolbar (same approach as zen-stuff pile)
          const mediaControlsToolbar = document.getElementById('zen-media-controls-toolbar');
          const zenMainAppWrapper = document.getElementById('zen-main-app-wrapper');
          
          let parentContainer = null;
          if (mediaControlsToolbar && mediaControlsToolbar.parentNode) {
            // Primary: insert after media controls toolbar (as sibling) - same as zen-stuff
            parentContainer = mediaControlsToolbar.parentNode;
            parentContainer.insertBefore(downloadCardsContainer, mediaControlsToolbar.nextSibling);
            debugLog("Inserted download cards container after zen-media-controls-toolbar");
          } else if (zenMainAppWrapper) {
            // Fallback: insert into zen-main-app-wrapper
            parentContainer = zenMainAppWrapper;
            zenMainAppWrapper.appendChild(downloadCardsContainer);
            debugLog("Inserted download cards container into zen-main-app-wrapper (fallback)");
          } else {
            // Final fallback: append to document.body
            parentContainer = document.body;
            document.body.appendChild(downloadCardsContainer);
            debugLog("Inserted download cards container into document.body (final fallback)");
          }
          
          // Ensure parent container has position: relative for absolute positioning
          if (parentContainer && parentContainer !== document.body) {
            const parentStyle = window.getComputedStyle(parentContainer);
            if (parentStyle.position === 'static') {
              parentContainer.style.position = 'relative';
              debugLog("Set parent container position to relative for absolute positioning");
            }
          }
          
          // Basic styles are now in CSS file.
          downloadCardsContainer.style.cssText = `
            box-sizing: border-box;
          `;
          
          // Set up compact mode observer
          setupCompactModeObserver();

          // Create the single master tooltip element (relative position for toolbar integration)
          masterTooltipDOMElement = document.createElement("div");
          masterTooltipDOMElement.className = "details-tooltip master-tooltip";
          // Ensure tooltip uses relative positioning (not fixed) for proper toolbar integration
          masterTooltipDOMElement.style.position = 'relative';
          // Most styles are now in CSS file, only dynamic styles remain inline

          masterTooltipDOMElement.innerHTML = `
            <div class="ai-sparkle-layer">
              <div class="sparkle-icon"></div>
              <div class="sparkle-icon"></div>
              <div class="sparkle-icon"></div>
              <div class="sparkle-icon"></div>
              <div class="sparkle-icon"></div>
            </div>
            <div class="card-status">Tooltip Status</div>
            <div class="card-title">Tooltip Title</div>
            <div class="card-original-filename">Original Filename</div>
            <div class="card-progress">Tooltip Progress</div>
            <div class="card-filesize">File Size</div>
            <div class="tooltip-buttons-container">
              <span class="card-undo-button" title="Undo Rename" tabindex="0" role="button">
                ↩
              </span>
              <span class="card-close-button" title="Close" tabindex="0" role="button">✕</span>
            </div>
            <div class="tooltip-tail"></div>
          `;
          downloadCardsContainer.appendChild(masterTooltipDOMElement);

          // Create the container for HORIZONTAL pods row
          podsRowContainerElement = document.createElement("div"); 
          podsRowContainerElement.id = "userchrome-pods-row-container"; 
          // Basic styles are now in CSS file, only dynamic height will be set by layout manager
          downloadCardsContainer.appendChild(podsRowContainerElement);

        // Init sync module (sidebar width sync for tooltip)
        if (window.zenTidyDownloadsSync?.init) {
          const syncFns = window.zenTidyDownloadsSync.init({
            getMasterTooltip: () => masterTooltipDOMElement,
            getPodsContainer: () => podsRowContainerElement,
            getActiveCards: () => activeDownloadCards,
            getFocusedKey: () => focusedDownloadKey,
            updateUI: (k, b) => updateUIForFocusedDownload(k, b),
            sidebarWidthRef,
            debugLog
          });
          initSidebarWidthSyncFn = syncFns.initSidebarWidthSync;
        }

          // Add mouse wheel scroll listener to the pods container for changing focus
          podsRowContainerElement.addEventListener('wheel', handlePodScrollFocus, { passive: false });

          // When the pile expands (zen-stuff fires pile-shown), remove sticky pods from the pods row
          document.addEventListener('pile-shown', clearAllStickyPods);
          
          // Add close handler for the master tooltip's close button AFTER creating podsRowContainerElement
          const masterCloseBtn = masterTooltipDOMElement.querySelector(".card-close-button");
          if (masterCloseBtn) {
            const masterCloseHandler = (e) => {
              e.preventDefault();
              e.stopPropagation();
              debugLog(`[MasterClose] Master close button clicked. FocusedDownloadKey: ${focusedDownloadKey}`);
              
              if (focusedDownloadKey) {
                const keyToRemove = focusedDownloadKey; // Capture the key
                const cardData = activeDownloadCards.get(keyToRemove);

                // Start tooltip hide animation immediately
                if (masterTooltipDOMElement) {
                  masterTooltipDOMElement.style.opacity = "0";
                  masterTooltipDOMElement.style.transform = "scaleY(0.8) translateY(10px)";
                  masterTooltipDOMElement.style.pointerEvents = "none"; // Disable interactions when hidden
                  debugLog(`[MasterClose] Tooltip hide animation initiated for ${keyToRemove}`);
                }

                // Delay pod removal to allow tooltip to animate out
                setTimeout(async () => {
                  debugLog(`[MasterClose] Delayed action: proceeding to handle/remove card for ${keyToRemove}`);
                  if (cardData && cardData.download) {
                    try {
                      const download = cardData.download;
                      // Pods only show succeeded/error - canceled downloads are never shown.

                      // For completed downloads: just remove from UI, keep in browser history
                      if (download.succeeded) {
                        debugLog(`[MasterClose] Removing completed download from UI only (keeping in browser history): ${keyToRemove}`);
                        
                        // Cancel any active AI process before removal
                        await cancelAIProcessForDownload(keyToRemove);
                        
                        removeCard(keyToRemove, true);
                        return;
                      }
                      
                      // For errored downloads or already permanently deleted: delete from history
                      if (download.error || cardData.permanentlyDeleted) {
                        debugLog(`[MasterClose] Deleting errored download from history: ${keyToRemove}`);
                        cardData.isManuallyCleaning = true;
                        await eraseDownloadFromHistory(download);
                        debugLog(`[MasterClose] Successfully erased download from history: ${keyToRemove}`);
                        removeCard(keyToRemove, true);
                        return;
                      }
                      
                    } catch (error) {
                      debugLog(`[MasterClose] Error handling download ${keyToRemove}:`, error);
                      // On error, still remove from UI
                      removeCard(keyToRemove, true);
                    }
                  } else {
                    debugLog(`[MasterClose] No cardData found for ${keyToRemove} during delayed action. Cannot remove.`);
                  }
                }, 300); // Corresponds to tooltip animation duration
              }
            };
            masterCloseBtn.addEventListener("click", masterCloseHandler);
            masterCloseBtn.addEventListener("keydown", (e) => {
              if ((e.key === "Enter" || e.key === " ") && focusedDownloadKey) {
                e.preventDefault();
                masterCloseHandler(e);
              }
            });
          }

          // Add undo/resume handler for the master tooltip's undo button
          const masterUndoBtn = masterTooltipDOMElement.querySelector(".card-undo-button");
          if (masterUndoBtn) {
              const masterUndoHandler = async (e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  debugLog(`[MasterUndo] Master undo/resume button clicked. FocusedDownloadKey: ${focusedDownloadKey}`);
                  
                  if (focusedDownloadKey) {
                      await undoRename(focusedDownloadKey);
                      // UI update is handled within undoRename via updateUIForFocusedDownload
                  }
              };
              masterUndoBtn.addEventListener("click", masterUndoHandler);
              masterUndoBtn.addEventListener("keydown", async (e) => {
                  if ((e.key === "Enter" || e.key === " ") && focusedDownloadKey) {
                      e.preventDefault();
                      await masterUndoHandler(e); // Make sure to await if handler is async
                  }
              });
          }

        }

        // Attach listeners - only show pod/tooltip after completion (no progress display)
        let downloadListener = {
          onDownloadAdded: (dl) => {
            if (dl.succeeded || dl.error) throttledCreateOrUpdateCard(dl);
          },
          onDownloadChanged: (dl) => {
            if (dl.succeeded || dl.error) throttledCreateOrUpdateCard(dl);
          },
          onDownloadRemoved: async (dl) => {
            const key = getDownloadKey(dl);
            await cancelAIProcessForDownload(key); // Cancel any AI process first
            
            // If the close handler is manually cleaning this download (erasing errored downloads
            // from history), skip removeCard and actual-download-removed here. The close handler
            // will call removeCard(force=true) after erasing, which correctly sends it to the pile.
            const cardData = activeDownloadCards.get(key);
            if (cardData?.isManuallyCleaning) {
              debugLog(`[OnDownloadRemoved] Skipping removeCard/actual-download-removed for manually cleaned download: ${key}`);
              return;
            }
            
            await removeCard(key, false);
            
            // Notify listeners that a download was actually removed from Firefox's list
            actualDownloadRemovedEventListeners.forEach(callback => {
              try {
                callback(key);
              } catch (error) {
                debugLog('[API Event] Error in actualDownloadRemoved callback:', error);
              }
            });
            fireCustomEvent('actual-download-removed', { podKey: key });
            debugLog(`[API Event] Fired actual-download-removed for key: ${key}`);
          },
        };

        window.Downloads.getList(window.Downloads.ALL)
          .then((list) => {
            list.addView(downloadListener);
            list.getAll().then((all) => {
              // Filter out old completed downloads to prevent them from reappearing
              const recentDownloads = all.filter(dl => {
                // Only show completed downloads (succeeded or error) - no in-progress, no canceled
                if (!dl.succeeded && !dl.error) return false;

                const key = getDownloadKey(dl);
                
                // Skip dismissed downloads only if they're completed AND not currently in our active cards
                if (dismissedDownloads.has(key) && !activeDownloadCards.has(key)) {
                  debugLog(`[CreatePod] Skipping dismissed completed download: ${key}`);
                  return false;
                }
                
                // Only show recent completed downloads within the time window
                const downloadTime = new Date(dl.startTime || 0);
                const hoursSinceDownload = (Date.now() - downloadTime.getTime()) / (1000 * 60 * 60);
                const showOldDownloadsHours = getPref("extensions.downloads.show_old_downloads_hours", 2);
                if (hoursSinceDownload > showOldDownloadsHours) {
                  debugLog(`[Init] Skipping old completed download: ${key} (${hoursSinceDownload.toFixed(1)}h old)`);
                  dismissedDownloads.add(key); // Mark as dismissed to prevent future reappearance
                  return false;
                }
                
                return true;
              });
              
              debugLog(`[Init] Processing ${recentDownloads.length} recent downloads out of ${all.length} total`);
              recentDownloads.forEach((dl) => {
                throttledCreateOrUpdateCard(dl, true);
              });
            });
          })
          .catch((e) => console.error("DL Preview Mistral AI: List error:", e));
      } catch (e) {
        console.error("DL Preview Mistral AI: Init error", e);
      }
    }

    // Throttled update - only receives completed downloads (succeeded/error; canceled excluded)
    function throttledCreateOrUpdateCard(download, isNewCardOnInit = false) {
      const key = getDownloadKey(download);
      const now = Date.now();
      const lastUpdate = cardUpdateThrottle.get(key) || 0;
      const throttleDelay = 200; // Debounce rapid completion events for same download

      if (now - lastUpdate < throttleDelay && !isNewCardOnInit) {
        debugLog(`[Throttle] Skipping throttled update for download: ${key} (delay: ${throttleDelay}ms)`);
        return;
      }
      
      cardUpdateThrottle.set(key, now);
      debugLog(`[Throttle] Calling createOrUpdatePodElement for key: ${key}, isNewOnInit: ${isNewCardOnInit}, error: ${!!download.error}, succeeded: ${!!download.succeeded}, canceled: ${!!download.canceled}`);
      const podElement = createOrUpdatePodElement(download, isNewCardOnInit);
      if (podElement) {
        debugLog(`[Throttle] Pod element created/updated for ${key}.`);
        const shouldRequestUIUpdate = isNewCardOnInit || key === focusedDownloadKey;
        if (shouldRequestUIUpdate) {
          updateUIForFocusedDownload(focusedDownloadKey || key, isNewCardOnInit || true);
        }
      } else {
        debugLog(`[Throttle] No pod element returned for ${key}. Download state:`, { 
          succeeded: download.succeeded, 
          error: !!download.error, 
          canceled: download.canceled,
          hasKey: !!key 
        });
      }
    }

    // Function to create or update a download POD element
    function createOrUpdatePodElement(download, isNewCardOnInit = false) {
      
      const key = getDownloadKey(download);
      if (!key) {
        debugLog("Skipping download object without usable key", download);
        return null;
      }

      // Skip dismissed downloads only if they're not currently in our active cards.
      // Exceptions:
      //   1. Path was explicitly "removed from pile" via permanentlyDeletedPaths AND this is a fresh re-download
      //      whose startTime is newer than the deletion time we recorded.
      //   2. This download has a newer startTime than the dismissed one — it's a fresh re-download.
      const normPath = (p) => (typeof p === "string" ? p.replace(/\\/g, "/").toLowerCase() : "");
      const pathNorm = download.target?.path ? normPath(download.target.path) : "";
      if (pathNorm && permanentlyDeletedPaths.has(pathNorm)) {
        const meta = permanentlyDeletedMeta.get(pathNorm);
        const deletedTimeMs = meta?.startTime || 0;
        const currentTimeMs = download.startTime ? new Date(download.startTime).getTime() : 0;

        // If we don't have a reliable startTime or it's not newer than the deletion time,
        // treat this as the same old history entry (e.g. "File missing or deleted") and skip it.
        if (!download.startTime || !meta || currentTimeMs <= deletedTimeMs) {
          debugLog("[CreatePod] Skipping permanently-deleted history entry", {
            key,
            pathNorm,
            deletedTimeMs,
            currentTimeMs,
            hasError: !!download.error
          });
          return null;
        }

        // Fresh re-download after permanent delete: clear flags and allow through.
        permanentlyDeletedPaths.delete(pathNorm);
        permanentlyDeletedMeta.delete(pathNorm);
        dismissedDownloads.delete(key);
        debugLog("[CreatePod] Allowing re-download for permanently deleted path", {
          key,
          pathNorm,
          deletedTimeMs,
          currentTimeMs
        });
      } else if (dismissedDownloads.has(key) && !activeDownloadCards.has(key)) {
        // Check whether this is a genuinely new download of the same file path
        const dismissedData = dismissedPodsData.get(key);
        const dismissedTime = dismissedData?.startTime ? new Date(dismissedData.startTime).getTime() : 0;
        const currentTime = download.startTime ? new Date(download.startTime).getTime() : 0;
        // Allow through if: no dismissed record, or current download started after the dismissed one
        const isNewerDownload = !dismissedData || !dismissedData.startTime || !download.startTime ||
          currentTime > dismissedTime;
        if (isNewerDownload) {
          dismissedDownloads.delete(key);
          debugLog(`[CreatePod] Allowing newer re-download to bypass dismissed check (dismissed: ${dismissedTime}, current: ${currentTime}): ${key}`);
        } else {
          debugLog(`[CreatePod] Skipping dismissed download that's not currently active: ${key}`);
          return null;
        }
      }

    debugLog("[PodFUNC] createOrUpdatePodElement called", { 
      key, 
      state: download.state, 
      currentBytes: download.currentBytes,
      succeeded: download.succeeded,
      error: !!download.error,
      errorMessage: download.error?.message,
      canceled: download.canceled,
      hasTargetPath: !!download?.target?.path,
      hasId: !!download?.id,
      isNewCardOnInit
    });

    let cardData = activeDownloadCards.get(key);
    const safeFilename = getSafeFilename(download);
    // const displayName = download.aiName || safeFilename; // Display name will be handled by master tooltip

    let podElement;
    let isNewPod = false;

    if (!cardData) {
      isNewPod = true;
      podElement = document.createElement("div");
      podElement.className = "download-pod"; 
      podElement.id = `download-pod-${key.replace(/[^a-zA-Z0-9_]/g, '-')}`;
      podElement.dataset.downloadKey = key;

      // Basic styles are now in CSS file, only dynamic positioning/animation styles remain inline

      podElement.innerHTML = `
        <div class="card-preview-container">
          <!-- Preview content (image, text snippet, or icon) will go here -->
          </div>
        `;

      const previewContainer = podElement.querySelector(".card-preview-container");
      if (previewContainer) {
          previewApi.setGenericIcon(previewContainer, download.contentType || "application/octet-stream");
        previewContainer.title = "Click to open file";
        
        previewContainer.addEventListener("click", (e) => {
          e.stopPropagation(); 
          const currentCardData = activeDownloadCards.get(podElement.dataset.downloadKey);
          if (currentCardData && currentCardData.download) {
            openDownloadedFile(currentCardData.download);
            } else {
            debugLog("openDownloadedFile: Card data not found for pod, attempting with initial download object", { key: podElement.dataset.downloadKey });
            openDownloadedFile(download); 
            }
          });
        }

        // Add drag-and-drop support for dragging to web pages
        podElement.setAttribute('draggable', 'true');
        podElement.addEventListener('dragstart', async (e) => {
          // Only allow drag if we have a file path and file exists
          if (!download.target?.path) {
            e.preventDefault();
            return;
          }

          try {
            // SECURITY: Validate path before file operations
            const pathValidation = SecurityUtils.validateFilePath(download.target.path, { strict: false });
            if (!pathValidation.valid) {
              debugLog('[DragDrop] Path validation failed:', pathValidation.error);
              e.preventDefault();
              return;
            }

            const file = Components.classes["@mozilla.org/file/local;1"].createInstance(Components.interfaces.nsIFile);
            file.initWithPath(download.target.path);
            
            if (!file.exists()) {
              e.preventDefault();
              return;
            }

            // Set the native file flavor for Firefox - use try/catch to handle potential DOMException
            try {
              if (e.dataTransfer && typeof e.dataTransfer.mozSetDataAt === 'function') {
                e.dataTransfer.mozSetDataAt('application/x-moz-file', file, 0);
              }
            } catch (mozError) {
              debugLog('[DragDrop] mozSetDataAt failed, continuing with other formats:', mozError);
              // Continue with other data formats even if mozSetDataAt fails
            }

            // Set URI flavors for web pages
            const fileUrl = file.path.startsWith('\\') ? 
              'file:' + file.path.replace(/\\/g, '/') : 
              'file:///' + file.path.replace(/\\/g, '/');
            
            if (fileUrl) {
              e.dataTransfer.setData('text/uri-list', fileUrl);
              e.dataTransfer.setData('text/plain', fileUrl);
            }

            // Optionally, set a download URL for HTML5 drop targets
            if (download.source?.url) {
              const contentType = download.contentType || getContentTypeFromFilename(safeFilename);
              e.dataTransfer.setData('DownloadURL', `${contentType}:${safeFilename}:${download.source.url}`);
            }

            // Use the pod element as drag image
            e.dataTransfer.setDragImage(podElement, 28, 28);
            debugLog('[DragDrop] Started drag for:', safeFilename);
          } catch (err) {
            debugLog('[DragDrop] Error during dragstart:', err);
            e.preventDefault();
          }
        });

        cardData = {
        podElement, // Renamed from cardElement
          download,
          complete: false,
          key: key,
          originalFilename: safeFilename, // This is the filename as of pod creation/update
          trueOriginalPathBeforeAIRename: null, // Will store the full path before AI rename
          trueOriginalSimpleNameBeforeAIRename: null, // Will store just the simple filename before AI rename
        lastInteractionTime: Date.now(),
        isVisible: false, // Will be set by layout manager
        isWaitingForZenAnimation: false, // Default, will be set true if new and Zen sync is active
        domAppended: false, // New flag: has this pod been added to podsRowContainerElement?
        intendedTargetTransform: null, // For stable animation triggering
        intendedTargetOpacity: null,   // For stable animation triggering
        isBeingRemoved: false          // To prevent layout conflicts during removal
        };
        activeDownloadCards.set(key, cardData);

      // Add to ordered list (newest at the end)
      if (!orderedPodKeys.includes(key)) {
        orderedPodKeys.push(key);
        
        // Show the container when we add the first pod (respects compact mode)
        if (orderedPodKeys.length === 1) {
          updateDownloadCardsVisibility();
          if (downloadCardsContainer && downloadCardsContainer.style.display !== 'none') {
            hideMediaControlsToolbar(); // Hide media controls when showing download pods
          }
        }
        
        // Focus behavior based on stable_focus_mode preference
        const stableFocusMode = getPref("extensions.downloads.stable_focus_mode", true);
        const currentFocusedData = focusedDownloadKey ? activeDownloadCards.get(focusedDownloadKey) : null;
        const currentFocusedDownload = currentFocusedData?.download;
        
        if (!focusedDownloadKey) {
          // Always focus if no current focus
          focusedDownloadKey = key;
          debugLog(`[PodFUNC] New pod created, setting as focused (no current focus): ${key}. Total pods: ${orderedPodKeys.length}`);
        } else if (!stableFocusMode) {
          // In non-stable mode, always switch to newest
          focusedDownloadKey = key;
          debugLog(`[PodFUNC] New pod created, setting as focused (non-stable mode): ${key}. Total pods: ${orderedPodKeys.length}`);
        } else if (download.succeeded) {
          // Completed downloads always take focus
          focusedDownloadKey = key;
          debugLog(`[PodFUNC] New pod created, setting as focused (completed download): ${key}. Total pods: ${orderedPodKeys.length}`);
        } else if (currentFocusedDownload && (currentFocusedDownload.succeeded || currentFocusedDownload.error)) {
          // If current focus is on a finished download, switch to the new active one
          focusedDownloadKey = key;
          debugLog(`[PodFUNC] New pod created, setting as focused (current focus was finished): ${key}. Previous: ${focusedDownloadKey}`);
        } else {
          // In stable mode, keep current focus for in-progress downloads when current is also in-progress
          debugLog(`[PodFUNC] New pod created but keeping current focus on: ${focusedDownloadKey}. New pod: ${key} (stable focus mode - both in progress)`);
        }
      } else {
        debugLog(`[PodFUNC] Pod ${key} already exists in orderedPodKeys. Current focus: ${focusedDownloadKey}`);
      }

      // Pods only appear on completion; Zen arc animation runs before download starts, so no sync needed.
      // Append to the horizontal row container immediately.
      if (podsRowContainerElement && !podElement.parentNode) {
        podsRowContainerElement.appendChild(podElement);
        cardData.domAppended = true;
        debugLog(`[PodFUNC] New pod ${key} appended to DOM (completed download).`);
      }

    } else {
      // Update existing pod data
      podElement = cardData.podElement;
      cardData.download = download; 
      cardData.lastInteractionTime = Date.now(); // Update interaction time on any change event
      if (safeFilename !== cardData.originalFilename && !download.aiName) {
         cardData.originalFilename = safeFilename; // Update if original name changes (e.g. server sent a different name later)
      }
      
      // Update completion status for existing pods
      if (download.succeeded && !cardData.complete) {
        cardData.complete = true;
        cardData.userCanceled = false; // Clear user-canceled flag on successful completion
        podElement.classList.add("completed"); // For potential styling
        debugLog(`[PodFUNC] Existing pod marked as complete: ${key}`);
        
        // Add to AI rename queue for existing completed pods
        const aiRenamingEnabled = getPref("extensions.downloads.enable_ai_renaming", true);
        debugLog(`[PodFUNC] Checking AI rename eligibility for ${key}:`, {
          aiRenamingEnabled,
          aiRenamingPossible,
          hasPath: !!download.target?.path,
          path: download.target?.path,
          alreadyRenamed: renamedFiles.has(download.target?.path)
        });
        
        if (aiRenamingEnabled && aiRenamingPossible && download.target?.path && 
            !renamedFiles.has(download.target.path)) {
          // Small delay to ensure download is fully settled before queuing
          // Use cardData.download to ensure we have the latest download object
          setTimeout(() => {
            const currentCardData = activeDownloadCards.get(key);
            if (currentCardData && currentCardData.download) {
              debugLog(`[PodFUNC] Adding ${key} to AI rename queue after delay`);
              addToAIRenameQueue(key, currentCardData.download, currentCardData.originalFilename);
            } else {
              debugLog(`[PodFUNC] Cannot add ${key} to queue - cardData missing after delay`);
            }
          }, 1000);
        } else {
          debugLog(`[PodFUNC] Not adding ${key} to AI rename queue - conditions not met`);
        }
        
        // Schedule autohide after configured delay for completed downloads
        scheduleCardRemoval(key);
      }
    }

    // Update pod preview content based on download state (icon, image, text snippet)
    const previewElement = podElement.querySelector(".card-preview-container");
    if (previewElement) {
        if (download.succeeded) {
            // Always try to set preview for completed downloads (in case it failed before)
            debugLog(`[Preview] Setting completed file preview for: ${key}`);
          previewApi.setCompletedFilePreview(previewElement, download)
            .catch(e => debugLog("Error setting completed file preview (async) for pod", { error: e, download }));
        } else if (download.error) {
            // Potentially set a different icon for error/cancel state on the pod itself
          previewApi.setGenericIcon(previewElement, "application/octet-stream"); // Default or error specific icon
        } else {
            // In-progress, could have a spinner or animated icon on the pod
            // For now, generic icon remains until completion, set at creation.
        }
    }
    
    // Mark as complete internally
    if (download.succeeded && !cardData.complete) {
      cardData.complete = true;
      cardData.userCanceled = false; // Clear user-canceled flag on successful completion
      podElement.classList.add("completed"); // For potential styling
      debugLog(`[PodFUNC] Download marked as complete: ${key}`);
      
      // Add to AI rename queue for ALL completed downloads (not just focused)
      // This ensures proper FIFO processing regardless of focus state
      const aiRenamingEnabled = getPref("extensions.downloads.enable_ai_renaming", true);
      debugLog(`[PodFUNC] Checking AI rename eligibility for ${key} (new pod):`, {
        aiRenamingEnabled,
        aiRenamingPossible,
        hasPath: !!download.target?.path,
        path: download.target?.path,
        alreadyRenamed: renamedFiles.has(download.target?.path)
      });
      
      if (aiRenamingEnabled && aiRenamingPossible && download.target?.path && 
          !renamedFiles.has(download.target.path)) {
        // Small delay to ensure download is fully settled before queuing
        // Use cardData.download to ensure we have the latest download object
        setTimeout(() => {
          const currentCardData = activeDownloadCards.get(key);
          if (currentCardData && currentCardData.download) {
            debugLog(`[PodFUNC] Adding ${key} to AI rename queue after delay (new pod)`);
            addToAIRenameQueue(key, currentCardData.download, currentCardData.originalFilename);
          } else {
            debugLog(`[PodFUNC] Cannot add ${key} to queue - cardData missing after delay (new pod)`);
          }
        }, 1000);
      } else {
        debugLog(`[PodFUNC] Not adding ${key} to AI rename queue - conditions not met (new pod)`);
      }
      
      // Schedule autohide after configured delay for completed downloads
      scheduleCardRemoval(key);
    }
    if (download.error) {
      podElement.classList.add("error");
      // Schedule autohide for error downloads
      scheduleCardRemoval(key);
    }

    return podElement;
  }

  // This will be a new, complex function. For now, a placeholder.
  function updateUIForFocusedDownload(keyToFocus, isNewOrSignificantUpdate = false) {
    const now = Date.now();
    const isFinalStateUpdateCandidate = (() => {
      const cd = keyToFocus ? activeDownloadCards.get(keyToFocus) : null;
      const dl = cd && cd.download;
      return !!dl && (dl.succeeded || dl.error);
    })();

    const shouldForceLayout = isNewOrSignificantUpdate || isFinalStateUpdateCandidate;
    const enoughTimeElapsedForLayout = (now - lastUIUpdateTime) >= MIN_UI_UPDATE_INTERVAL_MS;

    if (!shouldForceLayout && !enoughTimeElapsedForLayout) {
      debugLog(`[UIUPDATE_SKIP] Skipping UI update/layout for ${keyToFocus} to avoid layout storm.`);
      return;
    }

    lastUIUpdateTime = now;

    debugLog(`[UIUPDATE_TOP] updateUIForFocusedDownload called. keyToFocus: ${keyToFocus}, isNewOrSignificantUpdate: ${isNewOrSignificantUpdate}, current focusedDownloadKey: ${focusedDownloadKey}`);
    
    const oldFocusedKey = focusedDownloadKey;
    focusedDownloadKey = keyToFocus; 
    debugLog(`[UIUPDATE_FOCUS_SET] focusedDownloadKey is NOW: ${focusedDownloadKey}`);

    const cardDataToFocus = focusedDownloadKey ? activeDownloadCards.get(focusedDownloadKey) : null;

    if (!masterTooltipDOMElement) {
        debugLog("[UIUPDATE_ERROR] Master tooltip DOM element not found. Cannot update UI.");
        return; // Critical error, cannot proceed
    }

    if (!cardDataToFocus || !cardDataToFocus.podElement) {
      debugLog(`[UIUPDATE_NO_CARD_DATA] No card data or podElement for key ${focusedDownloadKey}. Hiding master tooltip. CardData:`, cardDataToFocus);
      masterTooltipDOMElement.style.opacity = "0";
      masterTooltipDOMElement.style.transform = "scaleY(0.8) translateY(10px)";
      masterTooltipDOMElement.style.pointerEvents = "none";
      // Show media controls if no pods are visible
      if (orderedPodKeys.length === 0) {
        showMediaControlsToolbar();
      }
    } else {
      // cardDataToFocus and podElement are valid, proceed with UI updates for tooltip and AI.
      masterTooltipDOMElement.style.display = "flex"; 

      if (oldFocusedKey !== focusedDownloadKey || isNewOrSignificantUpdate) {
          debugLog(`[UIUPDATE_TOOLTIP_RESET] Focus changed or significant update. Resetting tooltip for animation for ${focusedDownloadKey}. Old focus: ${oldFocusedKey}`);
          masterTooltipDOMElement.style.opacity = "0"; 
          masterTooltipDOMElement.style.transform = "scaleY(0.8) translateY(10px)";
          masterTooltipDOMElement.style.pointerEvents = "none";
      }

      const download = cardDataToFocus.download; 
      const podElement = cardDataToFocus.podElement; 

      if (!download) {
        debugLog(`[UIUPDATE_ERROR] cardDataToFocus for key ${focusedDownloadKey} is valid, but its .download property is undefined. Cannot update tooltip content or AI.`);
        // Keep tooltip hidden or show a generic error if it was supposed to be visible
        if (masterTooltipDOMElement.style.opacity !== '0') {
             masterTooltipDOMElement.style.opacity = "0";
             masterTooltipDOMElement.style.transform = "scaleY(0.8) translateY(10px)";
             masterTooltipDOMElement.style.pointerEvents = "none";
        }
      } else {
        // Both cardDataToFocus, podElement, AND download object are valid. Proceed with detailed updates.

        // 0. Ensure completion status is up to date
        if (download.succeeded && !cardDataToFocus.complete) {
          cardDataToFocus.complete = true;
          cardDataToFocus.userCanceled = false;
          podElement.classList.add("completed");
          debugLog(`[UIUPDATE] Download marked as complete during UI update: ${focusedDownloadKey}`);
          
          // Add to AI rename queue when completion is detected in UI update
          const aiRenamingEnabled = getPref("extensions.downloads.enable_ai_renaming", true);
          debugLog(`[UIUPDATE] Checking AI rename eligibility for ${focusedDownloadKey}:`, {
            aiRenamingEnabled,
            aiRenamingPossible,
            hasPath: !!download.target?.path,
            path: download.target?.path,
            alreadyRenamed: renamedFiles.has(download.target?.path)
          });
          
          if (aiRenamingEnabled && aiRenamingPossible && download.target?.path && 
              !renamedFiles.has(download.target.path)) {
            // Small delay to ensure download is fully settled before queuing
            setTimeout(() => {
              const currentCardData = activeDownloadCards.get(focusedDownloadKey);
              if (currentCardData && currentCardData.download) {
                debugLog(`[UIUPDATE] Adding ${focusedDownloadKey} to AI rename queue after delay`);
                addToAIRenameQueue(focusedDownloadKey, currentCardData.download, currentCardData.originalFilename);
              } else {
                debugLog(`[UIUPDATE] Cannot add ${focusedDownloadKey} to queue - cardData missing after delay`);
              }
            }, 1000);
          } else {
            debugLog(`[UIUPDATE] Not adding ${focusedDownloadKey} to AI rename queue - conditions not met`);
          }
          
          scheduleCardRemoval(focusedDownloadKey);
          
          // Set image preview for completed downloads
          const previewElement = podElement.querySelector(".card-preview-container");
          if (previewElement) {
            debugLog(`[UIUPDATE] Setting completed file preview for: ${focusedDownloadKey}`);
              previewApi.setCompletedFilePreview(previewElement, download)
                .catch(e => debugLog("Error setting completed file preview during UI update", { error: e, download }));
          }
        }

        // 1. Update masterTooltipDOMElement content
        const titleEl = masterTooltipDOMElement.querySelector(".card-title");
        const statusEl = masterTooltipDOMElement.querySelector(".card-status");
        const progressEl = masterTooltipDOMElement.querySelector(".card-progress");
        const originalFilenameEl = masterTooltipDOMElement.querySelector(".card-original-filename");
        const undoBtnEl = masterTooltipDOMElement.querySelector(".card-undo-button"); // Get the undo button
        const sparkleLayer = masterTooltipDOMElement.querySelector(".ai-sparkle-layer"); // Get the sparkle layer

        // Derive display name from actual file path if possible to catch OS renames (e.g. file(1).jpg)
        let displayName = download.aiName || cardDataToFocus.originalFilename || "File";
        // Always attempt to get the actual filename from disk, even if AI renamed it.
        // If AI renamed it to "foo.jpg" but OS made it "foo(1).jpg", we want "foo(1).jpg".
        if (download.target?.path) {
            try {
                const pathSeparator = download.target.path.includes('\\') ? '\\' : '/';
                const actualFilename = download.target.path.split(pathSeparator).pop();
                // We prefer the actual filename if it exists and differs from what we thought
                if (actualFilename && actualFilename !== displayName) {
                     // If it was AI renamed, we might want to check if the actual filename contains the AI name
                     // But generally, the file on disk is the ultimate truth.
                    displayName = actualFilename;
                }
            } catch (e) {
                // Fallback
            }
        }
        
        if (titleEl) {
          titleEl.textContent = displayName;
          titleEl.title = displayName;
        }

        if (statusEl && originalFilenameEl && progressEl && undoBtnEl) { // Include undoBtnEl in the check
            if (download.aiName && download.succeeded) {
                // AI Renamed State
                let finalSize = download.currentBytes;
                if (!(typeof finalSize === 'number' && finalSize > 0)) finalSize = download.totalBytes;
                const fileSizeText = formatBytes(finalSize || 0);
                
                // Always show file size in bottom right corner for renamed files
                const fileSizeEl = masterTooltipDOMElement.querySelector(".card-filesize");
                statusEl.textContent = "Download renamed to:";
                if (fileSizeEl) {
                    fileSizeEl.textContent = fileSizeText;
                    fileSizeEl.style.display = "block";
                }
                statusEl.style.color = "#a0a0a0"; 

                originalFilenameEl.textContent = cardDataToFocus.originalFilename; 
                originalFilenameEl.title = cardDataToFocus.originalFilename;
                originalFilenameEl.style.display = "block";

                progressEl.style.display = "none"; 
                undoBtnEl.style.display = "inline-flex"; // Show undo button
                
                // Show sparkles
                if (sparkleLayer) {
                  sparkleLayer.classList.add("visible");
                }
            } else {
                // Default states (completed, error) - tooltip only shows after completion
                originalFilenameEl.style.display = "none"; 
                progressEl.style.display = "block";    
                undoBtnEl.style.display = "none"; // Hide undo button
                
                // Hide sparkles
                if (sparkleLayer) {
                  sparkleLayer.classList.remove("visible");
                }
                
                // Hide the bottom-right file size element in non-renamed states
                const fileSizeEl = masterTooltipDOMElement.querySelector(".card-filesize");
                if (fileSizeEl) fileSizeEl.style.display = "none";
                
                // Reset undo button to original undo icon and title
                undoBtnEl.title = "Undo Rename";
                const svgIcon = undoBtnEl.querySelector("svg");
                if (svgIcon) {
                    const pathIcon = svgIcon.querySelector("path");
                    if (pathIcon) {
                        pathIcon.setAttribute("d", "M30.3,12.6c10.4,0,18.9,8.4,18.9,18.9s-8.5,18.9-18.9,18.9h-8.2c-0.8,0-1.3-0.6-1.3-1.4v-3.2c0-0.8,0.6-1.5,1.4-1.5h8.1c7.1,0,12.8-5.7,12.8-12.8s-5.7-12.8-12.8-12.8H16.4c0,0-0.8,0-1.1,0.1c-0.8,0.4-0.6,1,0.1,1.7l4.9,4.9c0.6,0.6,0.5,1.5-0.1,2.1L18,29.7c-0.6,0.6-1.3,0.6-1.9,0.1l-13-13c-0.5-0.5-0.5-1.3,0-1.8L16,2.1c0.6-0.6,1.6-0.6,2.1,0l2.1,2.1c0.6,0.6,0.6,1.6,0,2.1l-4.9,4.9c-0.6,0.6-0.6,1.3,0.4,1.3c0.3,0,0.7,0,0.7,0L30.3,12.6z");
                    }
                }

                if (download.error) {
                    statusEl.textContent = `Error: ${download.error.message || "Download failed"}`;
                    statusEl.style.color = "#ff6b6b";
                } else {
                    statusEl.textContent = "Download completed";
                    statusEl.style.color = "#1dd1a1";
                }
            }
        }

        if (progressEl) { // This block handles the content of progressEl when it's visible (completed states only)
            if (progressEl.style.display !== 'none') {
                if (download.succeeded) {
                    let finalSize = download.currentBytes;
                    if (!(typeof finalSize === 'number' && finalSize > 0)) finalSize = download.totalBytes;
                    progressEl.textContent = `${formatBytes(finalSize || 0)}`;
                } else {
                    let size = download.currentBytes || download.totalBytes;
                    progressEl.textContent = typeof size === 'number' && size > 0 ? formatBytes(size) : "";
                }
            }
        }
        
        // Use 100% width - container already has padding
        masterTooltipDOMElement.style.width = '100%';

        // 5. Handle AI Renaming UI status - queue addition is handled in createOrUpdatePodElement
        //    Here we just update the UI to reflect queue status
          const inQueueOrProcessing = isInQueue(keyToFocus);
        
          debugLog(`[AI Rename Status] ${keyToFocus}: inQueueOrProcessing=${inQueueOrProcessing}, succeeded=${download.succeeded}, hasAiName=${!!download.aiName}`);
        
        // Update UI to show queue status
          if (inQueueOrProcessing) {
          updateQueueStatusInUI(keyToFocus);
        }
      } // End of a valid 'download' object check
    } // End of valid 'cardDataToFocus' and 'podElement' check

    // 4. Call managePodVisibilityAndAnimations (always call to ensure layout is correct)
    // Use a small delay to ensure DOM updates are processed
    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            managePodVisibilityAndAnimations();
        });
    });

    // 6. Update which pod appears "focused" visually (this iterates all cards, safe to be here)
    activeDownloadCards.forEach(cd => {
        if (cd.podElement) {
            if (cd.key === focusedDownloadKey) {
                cd.podElement.classList.add('focused-pod');
                
                // Use dominant color if available, otherwise default blue
                const dominantColor = cd.podElement.dataset.dominantColor;
                if (dominantColor) {
              previewApi.updatePodGlowColor(cd.podElement, dominantColor);
                }
            } else {
                cd.podElement.classList.remove('focused-pod');
            }
        }
    });
          }

  // Placeholder for the layout manager function
  function managePodVisibilityAndAnimations() {
    if (!masterTooltipDOMElement || !podsRowContainerElement) return;
    debugLog("[LayoutManager] managePodVisibilityAndAnimations Natural Stacking Style called.");
    debugLog(`[LayoutManager] Current state: orderedPodKeys=${orderedPodKeys.length}, focusedDownloadKey=${focusedDownloadKey}, activeDownloadCards=${activeDownloadCards.size}`);

    const tooltipWidth = masterTooltipDOMElement.offsetWidth;
    const podNominalWidth = 56; 
      const podOverlapAmount = 50;
    const baseZIndex = 10;
    const maxVisiblePodsInPile = Math.floor((tooltipWidth - podNominalWidth) / (podNominalWidth - podOverlapAmount)) + 1; 

    if (orderedPodKeys.length === 0) {
        // Hide the entire container when no pods exist
        if (downloadCardsContainer) {
            downloadCardsContainer.style.display = "none";
            downloadCardsContainer.style.opacity = "0";
            downloadCardsContainer.style.visibility = "hidden";
        }
        
        if (masterTooltipDOMElement.style.opacity !== "0") {
            debugLog("[LayoutManager] No pods, ensuring master tooltip is hidden.");
            masterTooltipDOMElement.style.opacity = "0";
            masterTooltipDOMElement.style.transform = "scaleY(0.8) translateY(10px)";
            masterTooltipDOMElement.style.pointerEvents = "none";
            setTimeout(() => { 
                if (masterTooltipDOMElement.style.opacity === "0") masterTooltipDOMElement.style.display = "none";
            }, 300);
        }
        showMediaControlsToolbar(); // Show media controls when no pods exist
        debugLog(`[LayoutManager] Exiting: No OrderedPodKeys.`);
        podsRowContainerElement.style.gap = '0px'; // Reset gap just in case
        return;
    }

    // Show the container when we have pods (respects compact mode via updateDownloadCardsVisibility)
    updateDownloadCardsVisibility();
    if (downloadCardsContainer && downloadCardsContainer.style.display !== 'none') {
        hideMediaControlsToolbar(); // Hide media controls when showing download pods
    }

    if (tooltipWidth === 0 && orderedPodKeys.length > 0) {
        debugLog("[LayoutManager] Master tooltip width is 0. Cannot manage pod layout yet.");
        // Set a minimum height for the container to prevent layout collapse
        if (podsRowContainerElement.style.height === '0px') {
            podsRowContainerElement.style.height = '56px';
        }
        return; 
    }
    
    // Ensure focusedDownloadKey is valid and in orderedPodKeys, default to newest if not.
    if (!focusedDownloadKey || !orderedPodKeys.includes(focusedDownloadKey)) {
        if (orderedPodKeys.length > 0) {
          const newFocusKey = orderedPodKeys[orderedPodKeys.length - 1]; // Default to newest
            if (focusedDownloadKey !== newFocusKey) {
                focusedDownloadKey = newFocusKey;
                debugLog(`[LayoutManager] Focused key was invalid or missing, defaulted to newest: ${focusedDownloadKey}`);
            }
        }
    }

    // Ensure all pods in orderedPodKeys are in the DOM and have initial styles for animation/layout.
    orderedPodKeys.forEach(key => {
        const cardData = activeDownloadCards.get(key);
        if (cardData && cardData.podElement && !cardData.isWaitingForZenAnimation) {
            if (!cardData.domAppended && podsRowContainerElement) {
                podsRowContainerElement.appendChild(cardData.podElement);
                cardData.domAppended = true;
                debugLog(`[LayoutManager] Ensured pod ${key} is in DOM for Jukebox layout.`);
            }
            // Ensure consistent styling for all pods (in case they were created before layout manager)
            if (cardData.podElement.style.position !== 'absolute') {
                cardData.podElement.style.position = 'absolute';
                cardData.podElement.style.width = `${podNominalWidth}px`;
                cardData.podElement.style.marginRight = '0px';
                cardData.podElement.style.boxSizing = 'border-box';
                if (!cardData.podElement.style.transition) {
                    cardData.podElement.style.transition = 
                        'opacity 0.4s ease-out, transform 0.5s cubic-bezier(0.68, -0.55, 0.27, 1.55), ' + 
                        'z-index 0.3s ease-out';
                }
                debugLog(`[LayoutManager] Updated pod ${key} styling for absolute positioning.`);
            }
        }
    });

    let visiblePodsLayoutData = []; // Stores {key, x, zIndex, isFocused}
    const focusedIndexInOrdered = orderedPodKeys.indexOf(focusedDownloadKey);

    if (focusedIndexInOrdered === -1 && orderedPodKeys.length > 0) {
        // This should not happen if the check above worked, but as a failsafe:
        debugLog(`[LayoutManager_ERROR] Focused key ${focusedDownloadKey} not in ordered keys after all! Defaulting again.`);
        focusedDownloadKey = orderedPodKeys[orderedPodKeys.length - 1];
        // updateUIForFocusedDownload(focusedDownloadKey, false); // This could cause a loop, be careful
        // return; // Might be better to just proceed with the default for this frame
    }
    
    if (!focusedDownloadKey) { // If still no focused key (e.g. orderedPodKeys became empty)
      debugLog("[LayoutManager] No focused key available, cannot proceed with jukebox layout.");
      // Potentially hide all pods if this state is reached unexpectedly.
      orderedPodKeys.forEach(key => {
        const cd = activeDownloadCards.get(key);
        if (cd && cd.podElement && cd.isVisible) {
          cd.podElement.style.opacity = '0';
          cd.podElement.style.transform = 'scale(0.8) translateX(-30px)';
          cd.isVisible = false;
        }
      });
      return;
    }

    // 1. Position the focused pod
    let currentX = 0;
    visiblePodsLayoutData.push({
        key: focusedDownloadKey,
        x: currentX,
        zIndex: baseZIndex + orderedPodKeys.length + 1, // Highest Z
        isFocused: true
    });
    currentX += podNominalWidth - podOverlapAmount; // Next pod starts offset by (width - overlap)

    // 2. Position the pile pods to the right in reverse chronological order (natural stacking)
    // Create pile from newest to oldest, excluding the focused pod
    const pileKeys = orderedPodKeys.slice().reverse().filter(key => key !== focusedDownloadKey);
    let pileCount = 0;
    
    for (let i = 0; i < pileKeys.length && pileCount < maxVisiblePodsInPile - 1; i++) {
        const podKeyInPile = pileKeys[i];

        if (currentX + podNominalWidth <= tooltipWidth + podOverlapAmount) { // Allow last one to partially show
            visiblePodsLayoutData.push({
                key: podKeyInPile,
                x: currentX,
                zIndex: baseZIndex + pileKeys.length - i, // Decreasing Z (newest in pile has highest Z)
                isFocused: false
            });
            currentX += (podNominalWidth - podOverlapAmount);
            pileCount++;
      } else {
            break; // No more space
        }
    }

    debugLog(`[LayoutManager_NaturalStack] Calculated layout for ${visiblePodsLayoutData.length} pods. Focused: ${focusedDownloadKey}`, visiblePodsLayoutData);

    // 3. Apply styles and animations
    orderedPodKeys.forEach(key => {
        const cardData = activeDownloadCards.get(key);
        if (!cardData || !cardData.podElement || !cardData.domAppended || cardData.isWaitingForZenAnimation || cardData.isBeingRemoved) {
            debugLog(`[LayoutManager_Jukebox_Skip] Skipping pod ${key}. Conditions: cardData=${!!cardData}, podElement=${!!cardData?.podElement}, domAppended=${cardData?.domAppended}, waitingZen=${cardData?.isWaitingForZenAnimation}, beingRemoved=${cardData?.isBeingRemoved}`);
            return; // Skip pods that are not ready, waiting for Zen, or being removed
        }

        // Additional safety check: ensure pod is actually in the DOM
        if (!cardData.podElement.parentNode) {
            debugLog(`[LayoutManager_Jukebox_Skip] Pod ${key} not in DOM, skipping layout.`);
            return;
        }

        const podElement = cardData.podElement;
        const layoutData = visiblePodsLayoutData.find(p => p.key === key);

        if (layoutData) {
            // This pod should be visible
            podElement.style.display = 'flex';
            podElement.style.zIndex = `${layoutData.zIndex}`;
            const targetTransform = `translateX(${layoutData.x}px) scale(1) translateY(0)`;
            const targetOpacity = layoutData.isFocused ? '1' : '0.75';

            // Only animate if intended state changes or if it's becoming visible
            if (!cardData.isVisible || cardData.intendedTargetTransform !== targetTransform || cardData.intendedTargetOpacity !== targetOpacity) {
                debugLog(`[LayoutManager_Jukebox_Anim_Setup] Pod ${key}: Setting up IN/MOVE animation to X=${layoutData.x}, Opacity=${targetOpacity}. Prev IntendedTransform: ${cardData.intendedTargetTransform}, Prev Opacity: ${cardData.intendedTargetOpacity}, IsVisible: ${cardData.isVisible}`);
                
                // Apply directional entrance animation for newly focused pods during rotation
                if (layoutData.isFocused && !cardData.isVisible && lastRotationDirection) {
                    let entranceTransform;
                    if (lastRotationDirection === 'forward') {
                        // Forward rotation: new focused pod slides in from the right
                        entranceTransform = `translateX(${layoutData.x + 80}px) scale(0.8) translateY(0)`;
                    } else if (lastRotationDirection === 'backward') {
                        // Backward rotation: new focused pod slides in from the right (same as forward - reverse animation)
                        entranceTransform = `translateX(${layoutData.x + 80}px) scale(0.8) translateY(0)`;
      } else {
                        entranceTransform = targetTransform;
                    }
                    
                    // Set initial position for entrance animation
                    podElement.style.transform = entranceTransform;
                    podElement.style.opacity = '0';
                    
                    debugLog(`[LayoutManager_DirectionalAnim] Pod ${key}: Starting ${lastRotationDirection} entrance from ${entranceTransform}`);
                    
                    // Animate to final position
                    requestAnimationFrame(() => {
                        requestAnimationFrame(() => {
                            podElement.style.opacity = targetOpacity;
                            podElement.style.transform = targetTransform;
                            debugLog(`[LayoutManager_DirectionalAnim] Pod ${key}: Animating to final position ${targetTransform}`);
                        });
                    });
                } else {
                    // Normal animation for non-focused pods or non-rotation scenarios
                    requestAnimationFrame(() => {
                        podElement.style.opacity = targetOpacity;
                        podElement.style.transform = targetTransform;
                        debugLog(`[LayoutManager_Jukebox_Anim_Execute] Pod ${key}: Executing IN/MOVE to X=${layoutData.x}, Opacity=${targetOpacity}`);
                    });
                }
            }
            cardData.intendedTargetTransform = targetTransform;
            cardData.intendedTargetOpacity = targetOpacity;
            cardData.isVisible = true;

            // Tooltip animation for focused pod
            if (layoutData.isFocused && masterTooltipDOMElement && masterTooltipDOMElement.style.opacity === '0') {
                 // Pod is focused and tooltip is currently hidden, animate tooltip IN.
                 // This relies on updateUIForFocusedDownload having set the initial opacity/transform if focus changed.
                 debugLog(`[LayoutManager_Jukebox_Tooltip] Focused pod ${key} is visible/animating, and tooltip is hidden. Animating tooltip IN.`);
                 setTimeout(() => { 
                    masterTooltipDOMElement.style.opacity = "1";
                    masterTooltipDOMElement.style.transform = "scaleY(1) translateY(0)";
                    masterTooltipDOMElement.style.pointerEvents = "auto"; // Enable interactions when visible
                    hideMediaControlsToolbar(); // Hide media controls when tooltip is shown
                }, 100); 
            }
        } else {
            // This pod should be hidden or moved to pile
            if (cardData.isVisible || podElement.style.opacity !== '0') {
                debugLog(`[LayoutManager_Jukebox_Anim_OUT] Pod ${key}`);
                
                // Apply directional exit animation for previously focused pod during rotation
                let targetTransformOut;
                if (cardData.key === focusedDownloadKey && lastRotationDirection) {
                    // This shouldn't happen as focused pod should be visible, but safety check
                    targetTransformOut = 'scale(0.8) translateX(-30px)';
                } else if (lastRotationDirection === 'forward') {
                    // Forward rotation: previously focused pod slides left to join pile
                    targetTransformOut = 'scale(0.8) translateX(-60px)';
                } else if (lastRotationDirection === 'backward') {
                    // Backward rotation: previously focused pod slides left to join pile (same as forward - reverse animation)
                    targetTransformOut = 'scale(0.8) translateX(-60px)';
                } else {
                    // Default exit animation
                    targetTransformOut = 'scale(0.8) translateX(-30px)';
                }
                
                if (cardData.intendedTargetTransform !== targetTransformOut || cardData.intendedTargetOpacity !== '0') {
                    podElement.style.opacity = '0';
                    podElement.style.transform = targetTransformOut;
                    debugLog(`[LayoutManager_DirectionalExit] Pod ${key}: Exiting with ${lastRotationDirection || 'default'} animation: ${targetTransformOut}`);
                }
                cardData.intendedTargetTransform = targetTransformOut;
                cardData.intendedTargetOpacity = '0';
            }
            cardData.isVisible = false;
        }
    });
    
    // Set container height dynamically based on whether any pods are visible
    // This is important as pods are position:absolute now.
    if (visiblePodsLayoutData.length > 0) {
        podsRowContainerElement.style.height = `${podNominalWidth}px`; // Set to pod height
      } else {
        podsRowContainerElement.style.height = '0px';
    }

      debugLog(`[LayoutManager_NaturalStack] Finished. Visible pods: ${visiblePodsLayoutData.map(p => p.key).join(", ")}`);
    
    // Reset rotation direction after animations are set up
    if (lastRotationDirection) {
        setTimeout(() => {
            lastRotationDirection = null;
            debugLog(`[LayoutManager] Reset rotation direction after animation`);
        }, 100); // Small delay to ensure animations start before reset
    }
  }

  // --- Mouse Wheel Scroll Handler for Stack Rotation ---
  function handlePodScrollFocus(event) {
    if (!orderedPodKeys || orderedPodKeys.length <= 1) return; // Need at least 2 pods to rotate

    event.preventDefault(); // Prevent page scroll
    event.stopPropagation();

    if (!focusedDownloadKey || !orderedPodKeys.includes(focusedDownloadKey)) {
      debugLog("[StackRotation] No valid focused key, cannot rotate stack");
      return;
    }

    // Get current stack arrangement: focused pod + pile in reverse chronological order
    const currentFocused = focusedDownloadKey;
    const pileKeys = orderedPodKeys.slice().reverse().filter(key => key !== currentFocused);
    
    let newFocusedKey;

    if (event.deltaY > 0) {
      // Scroll DOWN: Current focused goes to END of pile, FIRST in pile becomes focused
      // Current: Pod D (focused) + [Pod C, Pod B, Pod A] (pile)
      // Result:  Pod C (focused) + [Pod B, Pod A, Pod D] (pile)
      
      if (pileKeys.length > 0) {
        newFocusedKey = pileKeys[0]; // First in pile becomes focused
        debugLog(`[StackRotation] Scroll DOWN: ${currentFocused} → end of pile, ${newFocusedKey} → focused`);
      }
      
    } else if (event.deltaY < 0) {
      // Scroll UP: Current focused goes to FRONT of pile, LAST in pile becomes focused  
      // Current: Pod D (focused) + [Pod C, Pod B, Pod A] (pile)
      // Result:  Pod A (focused) + [Pod D, Pod C, Pod B] (pile)
      
      if (pileKeys.length > 0) {
        newFocusedKey = pileKeys[pileKeys.length - 1]; // Last in pile becomes focused
        debugLog(`[StackRotation] Scroll UP: ${currentFocused} → front of pile, ${newFocusedKey} → focused`);
      }
    }

    // Apply the rotation by updating the orderedPodKeys array and focus
    if (newFocusedKey && newFocusedKey !== currentFocused) {
      // Remove the new focused key from its current position in orderedPodKeys
      const newFocusedIndex = orderedPodKeys.indexOf(newFocusedKey);
      if (newFocusedIndex > -1) {
        orderedPodKeys.splice(newFocusedIndex, 1);
      }
      
      // Remove the current focused key from its position
      const currentFocusedIndex = orderedPodKeys.indexOf(currentFocused);
      if (currentFocusedIndex > -1) {
        orderedPodKeys.splice(currentFocusedIndex, 1);
      }

      if (event.deltaY > 0) {
        // Scroll DOWN: new focused goes to end (newest position), current focused goes to beginning (oldest position)
        orderedPodKeys.unshift(currentFocused); // Add current focused to beginning (oldest)
        orderedPodKeys.push(newFocusedKey);     // Add new focused to end (newest)
      } else {
        // Scroll UP: new focused goes to end (newest position), current focused goes to second-to-last
        orderedPodKeys.push(newFocusedKey);     // Add new focused to end (newest)
        orderedPodKeys.splice(-1, 0, currentFocused); // Insert current focused before the last element
      }

      // Track rotation direction for animation purposes
      if (event.deltaY > 0) {
        lastRotationDirection = 'forward';
      } else {
        lastRotationDirection = 'backward';
      }

      // Update focus and refresh UI
      focusedDownloadKey = newFocusedKey;
      debugLog(`[StackRotation] Stack rotated ${lastRotationDirection}. New order:`, orderedPodKeys);
      debugLog(`[StackRotation] New focused: ${focusedDownloadKey}`);
      
      // Update UI with the new focus
      updateUIForFocusedDownload(newFocusedKey, false);
    }
  }



  // Improved card removal function
  async function removeCard(downloadKey, force = false) {
    try {
      const cardData = activeDownloadCards.get(downloadKey);
      if (!cardData) {
        debugLog(`removeCard: No card data found for key: ${downloadKey}`);
        return false;
      }

      const podElement = cardData.podElement;
      if (!podElement) {
        debugLog(`removeCard: No pod element found for key: ${downloadKey}`);
        return false;
      }

      if (!force && cardData.lastInteractionTime && 
          Date.now() - cardData.lastInteractionTime < getPref("extensions.downloads.interaction_grace_period_ms", 5000)) {
        debugLog(`removeCard: Skipping removal due to recent interaction: ${downloadKey}`, null, 'autohide');
        return false;
      }

      // === CAPTURE POD DATA FOR DISMISSAL PILE ===
      const dismissedData = capturePodDataForDismissal(downloadKey);
      if (dismissedData) {
        // Store the dismissed pod data
        dismissedPodsData.set(downloadKey, dismissedData);
        
        // Fire dismiss event for pile system
        dismissEventListeners.forEach(callback => {
          try {
            callback(dismissedData);
          } catch (error) {
            debugLog(`[Dismiss] Error in dismiss event callback:`, error);
          }
        });
        
        // Fire custom DOM event
        fireCustomEvent('pod-dismissed', { 
          podKey: downloadKey, 
          podData: dismissedData,
          wasManual: force 
        });
        
        debugLog(`[Dismiss] Pod dismissed and captured for pile: ${downloadKey}`);
      }

      cardData.isBeingRemoved = true; // Mark for exclusion from layout management
      debugLog(`[RemoveCard] Marked card ${downloadKey} as isBeingRemoved.`);

      // Cancel any active AI process before removal
      await cancelAIProcessForDownload(downloadKey);

      // Clear any pending autohide timeout
      if (cardData.autohideTimeoutId) {
        clearTimeout(cardData.autohideTimeoutId);
        cardData.autohideTimeoutId = null;
        debugLog(`[RemoveCard] Cleared pending autohide timeout for ${downloadKey}`);
      }



      // --- New Exit Animation for Pod: Slide Left & Fade --- 
      podElement.style.transition = "opacity 0.3s ease-out, transform 0.3s ease-in-out";
      podElement.style.opacity = "0";
      podElement.style.transform = "translateX(-60px) scale(0.8)"; // Slide left and slightly shrink
      // podElement.style.width = "0px"; // Optional: remove if translateX is enough
      debugLog(`[RemoveCard] Initiated slide-out animation for pod ${downloadKey}`);

      setTimeout(() => {
        // Get download info before deleting cardData
        const cardData = activeDownloadCards.get(downloadKey);
        const download = cardData?.download;
        
        if (podElement.parentNode) {
          podElement.parentNode.removeChild(podElement);
        }
        activeDownloadCards.delete(downloadKey);
        cardUpdateThrottle.delete(downloadKey);
        
        const removedPodIndex = orderedPodKeys.indexOf(downloadKey);
        if (removedPodIndex > -1) {
          orderedPodKeys.splice(removedPodIndex, 1);
        }

        // Only mark as dismissed if this was a manual removal or auto-hide of old downloads
        // Don't dismiss downloads that just completed (they might need to reappear for AI processing)
        if (force || !download || !download.succeeded || 
            (download.succeeded && Date.now() - (download.endTime || download.startTime || 0) > 60000)) {
          // Mark as dismissed only if:
          // - Manual removal (force=true)
          // - No download object
          // - Not a successful download
          // - Successful download that's more than 1 minute old
          dismissedDownloads.add(downloadKey);
          debugLog(`Pod removed for download: ${downloadKey}, marked as dismissed. Remaining ordered keys:`, orderedPodKeys);
        } else {
          debugLog(`Pod removed for download: ${downloadKey}, NOT marked as dismissed (recent completion). Remaining ordered keys:`, orderedPodKeys);
        }

        if (focusedDownloadKey === downloadKey) {
          focusedDownloadKey = null; // Clear focus first
          if (orderedPodKeys.length > 0) {
            // Try to focus an adjacent pod to the one removed.
            // orderedPodKeys is [oldest, ..., newest]
            // If removedPodIndex was valid, try to focus what's now at removedPodIndex (which was to its right)
            // or removedPodIndex - 1 (to its left).
            let newFocusKey = null;
            if (removedPodIndex < orderedPodKeys.length) { // Try focusing the pod that took its place (originally to the right)
                newFocusKey = orderedPodKeys[removedPodIndex];
            } else if (removedPodIndex > 0 && orderedPodKeys.length > 0) { // Try focusing the pod to the left
                newFocusKey = orderedPodKeys[removedPodIndex - 1];
            } else if (orderedPodKeys.length > 0) { // Fallback to newest if extremes were removed
                 newFocusKey = orderedPodKeys[orderedPodKeys.length - 1];
            }
            focusedDownloadKey = newFocusKey;
            debugLog(`[RemoveCard] Old focus ${downloadKey} removed. New focus attempt: ${focusedDownloadKey}`);
          }
        }
        

        
        // Update UI based on new focus (or lack thereof)
        // This will also hide the master tooltip if no pods are left or re-evaluate layout
        updateUIForFocusedDownload(focusedDownloadKey, false); 
        
        // Additional check: if no cards remain, ensure container is hidden
        if (orderedPodKeys.length === 0 && downloadCardsContainer) {
          downloadCardsContainer.style.display = "none";
          downloadCardsContainer.style.opacity = "0";
          downloadCardsContainer.style.visibility = "hidden";
          showMediaControlsToolbar(); // Show media controls when all pods are dismissed
        }

      }, 300); // Corresponds to pod animation duration

      return true;
    } catch (e) {
      console.error("Error removing card:", e);
      return false;
    }
  }

  function scheduleCardRemoval(downloadKey) {
    try {
      const disableAutohide = getPref(DISABLE_AUTOHIDE_PREF, false);
      if (disableAutohide) return;

      const cardData = activeDownloadCards.get(downloadKey);
      if (!cardData) {
        debugLog(`scheduleCardRemoval: No card data found for key: ${downloadKey}`);
        return;
      }

      // Clear any existing timeout
      if (cardData.autohideTimeoutId) {
        clearTimeout(cardData.autohideTimeoutId);
        debugLog(`scheduleCardRemoval: Cleared existing timeout for key: ${downloadKey}`);
      }

      // Schedule new timeout and store the ID
      cardData.autohideTimeoutId = setTimeout(() => {
        debugLog(`scheduleCardRemoval: Timeout fired for key: ${downloadKey}`);
        performAutohideSequence(downloadKey);
      }, getPref("extensions.downloads.autohide_delay_ms", 20000));
      
      debugLog(`scheduleCardRemoval: Scheduled removal for key: ${downloadKey} in ${getPref("extensions.downloads.autohide_delay_ms", 20000)}ms`, null, 'autohide');
    } catch (e) {
      console.error("Error scheduling card removal:", e);
    }
  }

  // Perform auto-dismiss: hide the tooltip, keep the pod visible (sticky), and silently add to pile.
  async function performAutohideSequence(downloadKey) {
    try {
      const cardData = activeDownloadCards.get(downloadKey);
      if (!cardData) {
        debugLog(`performAutohideSequence: No card data found for key: ${downloadKey}`);
        return;
      }
      debugLog(`[AutohideSequence] Starting sticky autohide for ${downloadKey}`);
      await makePodSticky(downloadKey);
    } catch (e) {
      console.error("Error in autohide sequence:", e);
      await removeCard(downloadKey, false);
    }
  }

  // Make a pod sticky: hide its tooltip, add it to the pile silently, keep it visible in the pods row.
  // The pod will be removed from the pods row only when the pile expands on hover.
  async function makePodSticky(downloadKey) {
    const cardData = activeDownloadCards.get(downloadKey);
    if (!cardData || cardData.isSticky || cardData.isBeingRemoved) return;

    debugLog(`[Sticky] Making pod sticky: ${downloadKey}`);

    // 1. Clear autohide timeout
    if (cardData.autohideTimeoutId) {
      clearTimeout(cardData.autohideTimeoutId);
      cardData.autohideTimeoutId = null;
    }

    // 2. Silently add to dismissed pile data + notify zen-stuff now, before tooltip hides
    const dismissedData = capturePodDataForDismissal(downloadKey);
    if (dismissedData) {
      dismissedPodsData.set(downloadKey, dismissedData);
      dismissEventListeners.forEach(cb => { try { cb(dismissedData); } catch (e) {} });
      fireCustomEvent('pod-dismissed', { podKey: downloadKey, podData: dismissedData, wasManual: false });
      debugLog(`[Sticky] Silently added to pile: ${downloadKey}`);
    }

    // 3. Mark as sticky and dismissed so it won't reappear from download list updates
    stickyPods.add(downloadKey);
    cardData.isSticky = true;
    dismissedDownloads.add(downloadKey);
    if (cardData.podElement) {
      cardData.podElement.classList.add('zen-tidy-sticky-pod');
      cardData.podElement.style.pointerEvents = 'none';
      cardData.podElement.style.cursor = 'default';
    }
    // Make the entire pods row pass-through so the bridge/pile receive hover (avoids pile hiding
    // when the cursor moves to where the sticky pod was, or when the sticky pod is removed).
    if (podsRowContainerElement) {
      podsRowContainerElement.style.pointerEvents = 'none';
    }

    // 4. Remove from jukebox rotation (sticky pods have no tooltip)
    const idx = orderedPodKeys.indexOf(downloadKey);
    if (idx > -1) orderedPodKeys.splice(idx, 1);

    // 5. Hide tooltip if this was the focused pod; focus next non-sticky pod if any
    if (focusedDownloadKey === downloadKey && masterTooltipDOMElement) {
      masterTooltipDOMElement.style.opacity = "0";
      masterTooltipDOMElement.style.transform = "scaleY(0.8) translateY(10px)";
      masterTooltipDOMElement.style.pointerEvents = "none";
      focusedDownloadKey = null;
      if (orderedPodKeys.length > 0) {
        focusedDownloadKey = orderedPodKeys[orderedPodKeys.length - 1];
      }
    }

    // 6. Cancel any active AI process (it's done)
    await cancelAIProcessForDownload(downloadKey);

    debugLog(`[Sticky] Pod is now sticky and visible at top-right of download button: ${downloadKey}`);
  }

  // Remove a single sticky pod from the pods row (called when pile expands).
  // Caller hides the pods row container first, so we remove immediately.
  function clearStickyPod(downloadKey) {
    const cardData = activeDownloadCards.get(downloadKey);
    if (!cardData || !cardData.isSticky) return;

    const podElement = cardData.podElement;
    stickyPods.delete(downloadKey);

    if (podElement && podElement.parentNode) {
      podElement.parentNode.removeChild(podElement);
    }
    activeDownloadCards.delete(downloadKey);
    cardUpdateThrottle.delete(downloadKey);
  }

  // Remove all sticky pods from the pods row (called when the pile expands).
  function clearAllStickyPods() {
    const keys = Array.from(stickyPods);
    if (keys.length === 0) return;
    debugLog(`[Sticky] Clearing ${keys.length} sticky pod(s) from pods row (pile expanded)`);
    // Hide the pods row first so it stops blocking the bridge/pile immediately
    if (podsRowContainerElement) {
      podsRowContainerElement.style.visibility = 'hidden';
      podsRowContainerElement.style.display = 'none';
      podsRowContainerElement.style.pointerEvents = '';
    }
    if (downloadCardsContainer) {
      downloadCardsContainer.style.display = 'none';
      downloadCardsContainer.style.opacity = '0';
      downloadCardsContainer.style.visibility = 'hidden';
    }
    keys.forEach(clearStickyPod);
  }

  // SecurityUtils, getPref, sanitizeFilename, waitForElement: see tidy-downloads-utils.uc.js
    // findDownloadsButton, patchDownloadsIndicatorMethods: see tidy-downloads-animation.uc.js

    // Preview: setGenericIcon, setCompletedFilePreview, updatePodGlowColor - from tidy-downloads-preview.uc.js

  // Improved file renaming function
  async function renameDownloadFileAndUpdateRecord(download, newName, key) {
    try {
      const oldPath = download.target.path;
      if (!oldPath) throw new Error("No file path available");

      // SECURITY: Validate the existing path (non-strict mode)
      const oldPathValidation = SecurityUtils.validateFilePath(oldPath, { strict: false });
      if (!oldPathValidation.valid) {
        debugLog(`Path validation warning for old path (continuing anyway): ${oldPathValidation.error}`, { 
          path: oldPath,
          code: oldPathValidation.code 
        });
      }

      const directory = oldPath.substring(0, oldPath.lastIndexOf(PATH_SEPARATOR));
      const oldFileName = oldPath.split(PATH_SEPARATOR).pop();
      const fileExt = oldFileName.includes(".") 
        ? oldFileName.substring(oldFileName.lastIndexOf(".")) 
        : "";

      // SECURITY: Use comprehensive filename sanitization
      let cleanNewName = sanitizeFilename(newName);
      // Ensure extension is preserved and re-sanitize if needed
      if (fileExt && !cleanNewName.endsWith(fileExt)) {
        cleanNewName = sanitizeFilename(cleanNewName + fileExt);
      }

      // Handle duplicate names
      let finalName = cleanNewName;
      let counter = 1;
      while (counter < 100) {
        const testPath = directory + PATH_SEPARATOR + finalName;
        let exists = false;
        try {
          // SECURITY: Validate path (non-strict for duplicate check)
          const testValidation = SecurityUtils.validateFilePath(testPath, { strict: false });
          if (!testValidation.valid) {
            // If validation fails, treat as non-existent to avoid infinite loop
            debugLog(`Path validation warning in duplicate check (treating as non-existent): ${testValidation.error}`);
            break;
          }
          const testFile = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
          testFile.initWithPath(testPath);
          exists = testFile.exists();
        } catch (e) {
          // File doesn't exist or can't access - proceed
          if (e.message && e.message.includes('Invalid file path')) {
            break; // Break loop on path errors
          }
        }
        if (!exists) break;
        
        const baseName = cleanNewName.includes(".") 
          ? cleanNewName.substring(0, cleanNewName.lastIndexOf(".")) 
          : cleanNewName;
        finalName = `${baseName}-${counter}${fileExt}`;
        counter++;
      }

      const newPath = directory + PATH_SEPARATOR + finalName;
      
      // SECURITY: Validate new path (non-strict mode)
      const newPathValidation = SecurityUtils.validateFilePath(newPath, { strict: false });
      if (!newPathValidation.valid) {
        debugLog(`Path validation warning for new path (continuing anyway): ${newPathValidation.error}`, { 
          path: newPath,
          code: newPathValidation.code 
        });
      }
      debugLog("Rename paths", { oldPath, newPath });

      const oldFile = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
      oldFile.initWithPath(oldPath);

      if (!oldFile.exists()) throw new Error("Source file does not exist");

      // Perform the rename
      oldFile.moveTo(null, finalName);

      // Update download record
      download.target.path = newPath;
      
      // Update card data key mapping
      const cardData = activeDownloadCards.get(key); // key is the OLD key here
      if (cardData) {
        activeDownloadCards.delete(key);
        activeDownloadCards.set(newPath, cardData);
        cardData.key = newPath; // Update the key stored in cardData itself
        if (cardData.podElement) { // Update dataset on the pod element itself
            cardData.podElement.dataset.downloadKey = newPath;
            debugLog(`[Rename] Updated podElement.dataset.downloadKey to ${newPath}`);
        }
        // Update the key in orderedPodKeys as well
        const oldKeyIndex = orderedPodKeys.indexOf(key);
        if (oldKeyIndex > -1) {
            orderedPodKeys.splice(oldKeyIndex, 1, newPath);
            debugLog(`[Rename] Updated key in orderedPodKeys from ${key} to ${newPath}`);
        } else {
            debugLog(`[Rename] Warning: Old key ${key} not found in orderedPodKeys during rename.`);
        }
        
        // Reschedule autohide with the new key if there was an existing timeout
        if (cardData.autohideTimeoutId) {
          clearTimeout(cardData.autohideTimeoutId);
          cardData.autohideTimeoutId = null;
          debugLog(`[Rename] Cleared old autohide timeout for ${key}, rescheduling for ${newPath}`);
          scheduleCardRemoval(newPath);
        }
        
        debugLog(`Updated card key mapping from ${key} to ${newPath}`);
      }

      debugLog("File renamed successfully");
      return true;
    } catch (e) {
      // Log detailed error information for debugging
      const errorInfo = {
        name: e.name || 'Error',
        message: e.message || e.toString() || 'Unknown error',
        oldPath: download?.target?.path,
        newName: newName,
        key: key
      };
      
      console.error(`Rename failed: ${errorInfo.name}: ${errorInfo.message}`, errorInfo);
      debugLog(`Rename failed: ${errorInfo.name}: ${errorInfo.message}`, {
        oldPath: errorInfo.oldPath,
        newName: errorInfo.newName
      });
      return false;
    }
  }

  // Helper functions to hide/show media controls toolbar
  function hideMediaControlsToolbar() {
    const mediaControlsToolbar = document.getElementById('zen-media-controls-toolbar');
    if (mediaControlsToolbar) {
      mediaControlsToolbar.style.opacity = '0';
      mediaControlsToolbar.style.pointerEvents = 'none';
      debugLog('[MediaControls] Hid media controls toolbar');
    }
  }

  function showMediaControlsToolbar() {
    const mediaControlsToolbar = document.getElementById('zen-media-controls-toolbar');
    if (mediaControlsToolbar) {
      // Check if context menu is visible
      const contextMenu = document.getElementById('zen-pile-pod-context-menu');
      const isContextMenuVisible = contextMenu && typeof contextMenu.state === 'string' && contextMenu.state === 'open';
      
      // Only show if no download pods are visible and context menu is not visible
      if (orderedPodKeys.length === 0 && !isContextMenuVisible) {
        mediaControlsToolbar.style.opacity = '1';
        mediaControlsToolbar.style.pointerEvents = 'auto';
        debugLog('[MediaControls] Showed media controls toolbar');
      }
    }
  }

    // Initialize AI Rename module (uses renameDownloadFileAndUpdateRecord as callback)
    (function initAIRenameModule() {
      const api = window.zenTidyDownloadsAIRename?.init({
        renameDownloadFileAndUpdateRecord,
        scheduleCardRemoval,
        performAutohideSequence,
        getCardData: (k) => activeDownloadCards.get(k),
        getFocusedKey: () => focusedDownloadKey,
        setFocusedKey: (v) => { focusedDownloadKey = v; },
        getMasterTooltip: () => masterTooltipDOMElement,
        hasRenamedPath: (p) => renamedFiles.has(p),
        addRenamedPath: (p) => renamedFiles.add(p),
        deleteRenamedPath: (p) => renamedFiles.delete(p),
        updateUIForFocusedDownload,
        debugLog,
        getPref,
        SecurityUtils,
        RateLimiter,
        redactSensitiveData,
        sanitizeFilename,
        formatBytes,
        getContentTypeFromFilename,
        MISTRAL_API_KEY_PREF,
        IMAGE_EXTENSIONS,
        PATH_SEPARATOR,
        previewApi,
        showRenameToast,
        showSimpleToast,
        getDownloadKey,
        Cc,
        Ci
      });
      if (api) {
        addToAIRenameQueue = api.addToAIRenameQueue;
        removeFromAIRenameQueue = api.removeFromAIRenameQueue;
        cancelAIProcessForDownload = api.cancelAIProcessForDownload;
        isInQueue = api.isInQueue;
        getQueuePosition = api.getQueuePosition;
        updateQueueStatusInUI = api.updateQueueStatusInUI;
      }
    })();

  // Setup compact mode observer to handle visibility changes
  function setupCompactModeObserver() {
    const mainWindow = document.getElementById('main-window');
    const zenMainAppWrapper = document.getElementById('zen-main-app-wrapper');
    
    if (!mainWindow && !zenMainAppWrapper) {
      debugLog("[CompactModeObserver] Target elements not found, cannot set up observer");
      return;
    }
    
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === 'attributes') {
          const attributeName = mutation.attributeName;
          if (attributeName === 'zen-compact-mode' || attributeName === 'zen-sidebar-expanded') {
            debugLog(`[CompactModeObserver] ${attributeName} changed, updating download cards visibility`);
            updateDownloadCardsVisibility();
          }
        }
      }
    });
    
    // Observe main-window for zen-compact-mode (if it exists)
    if (mainWindow) {
      observer.observe(mainWindow, {
        attributes: true,
        attributeFilter: ['zen-compact-mode']
      });
      debugLog("[CompactModeObserver] Observing main-window for zen-compact-mode");
    }
    
    // Also observe documentElement for zen-compact-mode and zen-sidebar-expanded
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['zen-compact-mode', 'zen-sidebar-expanded']
    });
    debugLog("[CompactModeObserver] Observing documentElement for zen-compact-mode and zen-sidebar-expanded");
    
    debugLog("[CompactModeObserver] Set up observer for compact mode changes");
    
    // Initial check with a small delay to ensure DOM is ready
    setTimeout(() => {
      updateDownloadCardsVisibility();
    }, 100);
  }
  
  // Update download cards container visibility based on compact mode
  function updateDownloadCardsVisibility() {
    if (!downloadCardsContainer) return;
    
    // Check compact mode on documentElement (same as zen-stuff)
    const isCompactMode = document.documentElement.getAttribute('zen-compact-mode') === 'true';
    const isSidebarExpanded = document.documentElement.getAttribute('zen-sidebar-expanded') === 'true';
    
    debugLog(`[CompactModeObserver] Checking visibility: isCompactMode=${isCompactMode}, isSidebarExpanded=${isSidebarExpanded}, hasPods=${orderedPodKeys.length > 0}`);
    
    if (isCompactMode && !isSidebarExpanded) {
      // In compact mode with collapsed sidebar, ALWAYS hide the download cards (like media controls)
      debugLog("[CompactModeObserver] Compact mode with collapsed sidebar - FORCING hide of download cards");
      downloadCardsContainer.style.display = 'none';
      downloadCardsContainer.style.opacity = '0';
      downloadCardsContainer.style.visibility = 'hidden';
      downloadCardsContainer.style.pointerEvents = 'none';
      // Also hide tooltip and pods explicitly
      if (masterTooltipDOMElement) {
        masterTooltipDOMElement.style.display = 'none';
        masterTooltipDOMElement.style.opacity = '0';
        masterTooltipDOMElement.style.visibility = 'hidden';
        masterTooltipDOMElement.style.pointerEvents = 'none';
      }
      if (podsRowContainerElement) {
        podsRowContainerElement.style.display = 'none';
        podsRowContainerElement.style.opacity = '0';
        podsRowContainerElement.style.visibility = 'hidden';
        podsRowContainerElement.style.pointerEvents = 'none';
      }
    } else if (orderedPodKeys.length > 0) {
      // Show if we have pods and not in collapsed compact mode
      debugLog("[CompactModeObserver] Showing download cards (not in collapsed compact mode)");
      downloadCardsContainer.style.display = 'flex';
      downloadCardsContainer.style.opacity = '1';
      downloadCardsContainer.style.visibility = 'visible';
      downloadCardsContainer.style.pointerEvents = 'auto';
      // Restore pods row (may have been hidden by clearAllStickyPods when pile expanded)
      if (podsRowContainerElement) {
        podsRowContainerElement.style.display = 'flex';
        podsRowContainerElement.style.visibility = 'visible';
        podsRowContainerElement.style.opacity = '1';
        podsRowContainerElement.style.pointerEvents = 'auto';
      }
    } else {
      // No pods, hide container
      debugLog("[CompactModeObserver] No pods, hiding download cards");
      downloadCardsContainer.style.display = 'none';
      downloadCardsContainer.style.opacity = '0';
      downloadCardsContainer.style.visibility = 'hidden';
      downloadCardsContainer.style.pointerEvents = 'none';
    }
  }

  console.log("=== DOWNLOAD PREVIEW SCRIPT LOADED SUCCESSFULLY ===");

// --- Function to Undo AI Rename ---
async function undoRename(keyOfAIRenamedFile) {
  debugLog("[UndoRename] Attempting to undo rename for key:", keyOfAIRenamedFile);
  const cardData = activeDownloadCards.get(keyOfAIRenamedFile);

  if (!cardData || !cardData.download) {
      debugLog("[UndoRename] No cardData or download object found for key:", keyOfAIRenamedFile);
      return false;
  }

  const currentAIRenamedPath = cardData.download.target.path; // Current path (after AI rename)
  const originalSimpleName = cardData.trueOriginalSimpleNameBeforeAIRename;
  const originalFullPath = cardData.trueOriginalPathBeforeAIRename; // The full path before AI rename

  if (!currentAIRenamedPath || !originalSimpleName || !originalFullPath) {
      debugLog("[UndoRename] Missing path/name information for undo:", 
          { currentAIRenamedPath, originalSimpleName, originalFullPath });
      // Maybe update status to indicate error?
      return false;
  }
  
  // Ensure originalSimpleName is what we expect if originalFullPath is the key to the past state
  // For safety, we reconstruct the target directory from the *current* path if the original was just a simple name.
  const targetDirectory = currentAIRenamedPath.substring(0, currentAIRenamedPath.lastIndexOf(PATH_SEPARATOR));
  const targetOriginalPath = targetDirectory + PATH_SEPARATOR + originalSimpleName;

  debugLog("[UndoRename] Details:", {
      currentPath: currentAIRenamedPath,
      originalSimple: originalSimpleName,
      originalFullPathStored: originalFullPath, // The key to what it *was*
      targetOriginalPathForRename: targetOriginalPath // The path we want to rename *to*
  });

  /**
   * Undo AI rename operation - restore original filename
   * Uses a modified version of rename logic
   */
  try {
      // SECURITY: Validate path before file operations (non-strict for undo operations)
      const undoPathValidation = SecurityUtils.validateFilePath(currentAIRenamedPath, { strict: false });
      if (!undoPathValidation.valid) {
        debugLog("[UndoRename] Path validation warning", {
          path: currentAIRenamedPath,
          error: undoPathValidation.error,
          code: undoPathValidation.code
        });
        // Continue anyway - user-initiated undo operation
      }
      
      const fileToUndo = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
      fileToUndo.initWithPath(currentAIRenamedPath);

      if (!fileToUndo.exists()) {
          debugLog("[UndoRename] File to undo does not exist at current path:", currentAIRenamedPath);
          // Perhaps it was moved or deleted by the user? Clean up UI.
          if (masterTooltipDOMElement) {
              const undoBtn = masterTooltipDOMElement.querySelector(".card-undo-button");
              if (undoBtn) undoBtn.style.display = "none";
          }
          // Consider removing the card or updating status more drastically.
          return false;
      }

      // Perform the rename back to originalSimpleName in the current directory
      fileToUndo.moveTo(null, originalSimpleName); 
      debugLog(`[UndoRename] File moved from ${currentAIRenamedPath} to ${targetOriginalPath} (using simple name ${originalSimpleName})`);

      // Update download object and cardData
      cardData.download.target.path = targetOriginalPath;
      cardData.download.aiName = null; // Clear the AI name
      // cardData.originalFilename should revert to originalSimpleName (or be updated by next UI refresh)
      cardData.originalFilename = originalSimpleName; 

      // Update the key in activeDownloadCards map
      if (keyOfAIRenamedFile !== targetOriginalPath) {
          activeDownloadCards.delete(keyOfAIRenamedFile);
          activeDownloadCards.set(targetOriginalPath, cardData);
          cardData.key = targetOriginalPath;
          if (cardData.podElement) cardData.podElement.dataset.downloadKey = targetOriginalPath;
          
          // Update orderedPodKeys
          const oldKeyIndex = orderedPodKeys.indexOf(keyOfAIRenamedFile);
          if (oldKeyIndex > -1) {
              orderedPodKeys.splice(oldKeyIndex, 1, targetOriginalPath);
          }

          // If this was the focused key, update focusedDownloadKey
          if (focusedDownloadKey === keyOfAIRenamedFile) {
              focusedDownloadKey = targetOriginalPath;
          }
          debugLog(`[UndoRename] Updated activeDownloadCards map key from ${keyOfAIRenamedFile} to ${targetOriginalPath}`);
      }
      
      renamedFiles.delete(originalFullPath); // Allow AI re-rename if user downloads it again or wants to retry
      renamedFiles.delete(currentAIRenamedPath); // Remove the AI-renamed path from the set too

      // Update UI immediately for the focused item
      if (focusedDownloadKey === targetOriginalPath && masterTooltipDOMElement) {
          const titleEl = masterTooltipDOMElement.querySelector(".card-title");
          const statusEl = masterTooltipDOMElement.querySelector(".card-status");
          const originalFilenameEl = masterTooltipDOMElement.querySelector(".card-original-filename");
          const progressEl = masterTooltipDOMElement.querySelector(".card-progress");
          const undoBtn = masterTooltipDOMElement.querySelector(".card-undo-button");

          if (titleEl) titleEl.textContent = originalSimpleName;
          if (statusEl) {
              statusEl.textContent = "Download completed"; // Or original status if stored
              statusEl.style.color = "#1dd1a1";
          }
          if (originalFilenameEl) originalFilenameEl.style.display = "none";
          if (progressEl) progressEl.style.display = "block"; // Show progress/size again
          if (undoBtn) undoBtn.style.display = "none";
      }

      // Trigger a full UI update
      updateUIForFocusedDownload(focusedDownloadKey || targetOriginalPath, true); 

      // 4. Ensure autohide is scheduled/rescheduled
      // We need to clear the old timeout associated with the OLD key (keyOfAIRenamedFile) 
      // and start a new one for the NEW key (targetOriginalPath).
      
      // Try to find the cardData that was moved to the new key
      const revertedCardData = activeDownloadCards.get(targetOriginalPath);
      
      if (revertedCardData) {
         // Reset timeout ID just in case it carried over but wasn't cleared
         if (revertedCardData.autohideTimeoutId) {
             clearTimeout(revertedCardData.autohideTimeoutId);
             revertedCardData.autohideTimeoutId = null;
         }
      }

      // Schedule removal with a short delay (e.g. 2000ms) to allow user to see the change
      const originalDelay = getPref("extensions.downloads.autohide_delay_ms", 20000);
      const shortDelay = 2000;
      
      // Temporarily override the delay pref (or just manually call setTimeout/performAutohide)
      // Since scheduleCardRemoval reads the pref, we'll implement a custom one-off removal here
      // or just trust scheduleCardRemoval if we want standard behavior.
      // But user asked for "dismiss automatically" which usually implies "soon".
      
      debugLog(`[UndoRename] Scheduling immediate dismissal in ${shortDelay}ms`);
      revertedCardData.autohideTimeoutId = setTimeout(() => {
          performAutohideSequence(targetOriginalPath);
      }, shortDelay);

      debugLog("[UndoRename] Rename undone successfully.");
      return true;

  } catch (e) {
      debugLog("[UndoRename] Error during undo rename process:", e);
      // Update status to show error?
      if (masterTooltipDOMElement && focusedDownloadKey === keyOfAIRenamedFile) {
           const statusEl = masterTooltipDOMElement.querySelector(".card-status");
           if (statusEl) {
              statusEl.textContent = "Undo rename failed";
              statusEl.style.color = "#ff6b6b";
           }
      }
      return false;
  }
}

  } // Close initializeMainScript function

})();
