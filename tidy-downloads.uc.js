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

    // Single-flight: duplicate script evaluation would register listeners twice. Only arm after
    // we know this is the real browser chrome (popup checks above).
    if (window.__zenTidyDownloadsBundleExecuted) {
      console.warn("[Tidy Downloads] Bundle already executed in this window; skipping duplicate load.");
      return;
    }
    window.__zenTidyDownloadsBundleExecuted = true;
    
    // === MAIN SCRIPT INITIALIZATION CONTINUES HERE ===
    // Wait for utils (handles load-order races; utils must be in theme.json scripts)
    (function tryInit(attempt) {
      const utilsReady = window.zenTidyDownloadsUtils;
      const storeReady = window.zenTidyDownloadsStore?.createStore;
      const dlAdapterReady = window.zenTidyDownloadsDownloadsAdapter;
      const podsReady = window.zenTidyDownloadsPods?.init;
      const tooltipLayoutReady = window.zenTidyDownloadsTooltipLayout?.init;
      const publicApiReady = window.zenTidyDownloadsPublicApi?.createPublicApi;
      if (utilsReady && storeReady && dlAdapterReady && podsReady && tooltipLayoutReady && publicApiReady) {
        initializeMainScript();
        return;
      }
      if (attempt < 40) { // ~2 seconds max (40 * 50ms)
        setTimeout(() => tryInit(attempt + 1), 50);
        return;
      }
      console.error(
        "[Tidy Downloads] Missing modules after 2s. Need utils, store, downloads-adapter, pods, tooltip-layout, and public-api (.uc.js in theme.json / mods.json)."
      );
    })(0);
  }, 100); // Small delay to ensure DOM elements are loaded

  // === MAIN SCRIPT FUNCTIONS ===
  function initializeMainScript() {
    const Utils = window.zenTidyDownloadsUtils;
    if (!Utils) return;

    if (window.__zenTidyDownloadsMainInitialized) {
      console.warn("[Tidy Downloads] initializeMainScript already ran in this window; skip duplicate.");
      return;
    }
    window.__zenTidyDownloadsMainInitialized = true;
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
    // extensions.downloads.autohide_delay_ms - Delay before auto-hiding completed downloads (default: 10000)
    // extensions.downloads.interaction_grace_period_ms - Grace period after user interaction (default: 5000)
    // extensions.downloads.max_filename_length - Maximum length for AI-generated filenames (default: 70)
    // extensions.downloads.max_file_size_for_ai - Maximum file size for AI processing in bytes (default: 52428800 = 50MB)
    // extensions.downloads.mistral_api_url - Mistral API endpoint (default: "https://api.mistral.ai/v1/chat/completions")
    // extensions.downloads.mistral_model - Mistral model to use (default: "pixtral-large-latest")
    // extensions.downloads.stable_focus_mode - Prevent focus switching during multiple downloads (default: true)
    // extensions.downloads.show_old_downloads_hours - How many hours back to show old completed downloads on startup (default: 2)
    // zen.tidy-downloads.use-library-button - Use zen-library-button instead of downloads-button for hover detection (default: false)

    const DownloadsAdapter = window.zenTidyDownloadsDownloadsAdapter;
    const store = window.zenTidyDownloadsStore.createStore({ getPref });
    const {
      activeDownloadCards,
      renamedFiles,
      cardUpdateThrottle,
      sidebarWidthRef,
      focusedKeyRef,
      orderedPodKeys,
      dismissedDownloads,
      stickyPods,
      permanentlyDeletedPaths,
      permanentlyDeletedMeta,
      MAX_PERMANENTLY_DELETED_PATHS,
      actualDownloadRemovedEventListeners,
      dismissedPodsData,
      dismissEventListeners
    } = store;

    // DOM + session (not on store)
    let downloadCardsContainer;
    let aiRenamingPossible = false;
    let podsRowContainerElement = null;
    let masterTooltipDOMElement = null;
    let initSidebarWidthSyncFn = () => { };

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
      focusedKeyRef
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

    // AI Rename module (wired after createRenameHandlers, before init())
    let addToAIRenameQueue = () => false;
    let removeFromAIRenameQueue = () => false;
    let cancelAIProcessForDownload = async () => false;
    let isInQueue = () => false;
    let getQueuePosition = () => -1;
    let updateQueueStatusInUI = () => {};
    let throttledCreateOrUpdateCard = function () {};

    const tooltipLayoutRef = {
      updateUIForFocusedDownload() {},
      managePodVisibilityAndAnimations() {},
      handlePodScrollFocus() {}
    };

    function updateUIForFocusedDownload(keyToFocus, isNewOrSignificantUpdate = false) {
      tooltipLayoutRef.updateUIForFocusedDownload(keyToFocus, isNewOrSignificantUpdate);
    }
    function managePodVisibilityAndAnimations() {
      tooltipLayoutRef.managePodVisibilityAndAnimations();
    }
    function handlePodScrollFocus(event) {
      tooltipLayoutRef.handlePodScrollFocus(event);
    }

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

    window.zenTidyDownloads = window.zenTidyDownloadsPublicApi.createPublicApi({
      store,
      debugLog,
      SecurityUtils,
      DownloadsAdapter,
      getDownloadKey,
      getThrottledCreateOrUpdateCard: () => throttledCreateOrUpdateCard,
      fireCustomEvent,
      Cc,
      Ci
    });

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
        /** @type {string|number|undefined} Firefox download id when present — used to reconcile pile actions with Downloads API */
        downloadId: download.id != null ? download.id : undefined,
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

    const tidyDeps = {
      SecurityUtils,
      debugLog,
      sanitizeFilename,
      PATH_SEPARATOR,
      Cc,
      Ci,
      scheduleCardRemoval,
      performAutohideSequence,
      updateUIForFocusedDownload,
      getMasterTooltip: () => masterTooltipDOMElement,
      /** @type {(oldKey: string, newKey: string) => void} */
      migrateAIRenameKeys() {}
    };

    const { renameDownloadFileAndUpdateRecord, undoRename } = window.zenTidyDownloadsFileOps.createRenameHandlers({
      store,
      deps: tidyDeps
    });

    const aiDeps = {
      ...tidyDeps,
      renameDownloadFileAndUpdateRecord,
      getPref,
      RateLimiter,
      redactSensitiveData,
      formatBytes,
      getContentTypeFromFilename,
      MISTRAL_API_KEY_PREF,
      IMAGE_EXTENSIONS,
      previewApi,
      showRenameToast,
      showSimpleToast,
      getDownloadKey
    };

    (function initAIRenameModule() {
      const api = window.zenTidyDownloadsAIRename?.init({
        store,
        deps: aiDeps
      });
      if (api) {
        addToAIRenameQueue = api.addToAIRenameQueue;
        removeFromAIRenameQueue = api.removeFromAIRenameQueue;
        cancelAIProcessForDownload = api.cancelAIProcessForDownload;
        isInQueue = api.isInQueue;
        getQueuePosition = api.getQueuePosition;
        updateQueueStatusInUI = api.updateQueueStatusInUI;
        tidyDeps.migrateAIRenameKeys = api.migrateAIRenameKeys;
      }
    })();

    async function init() {
      console.log("=== DOWNLOAD PREVIEW SCRIPT STARTING ===");
      debugLog("Starting initialization");
      if (!DownloadsAdapter.isAvailable()) {
        console.error("Download Preview Mistral AI: Downloads API not available");
        aiRenamingPossible = false;
        return;
      }
      try {
        DownloadsAdapter.getAllDownloadsList()
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

          // When the pile expands (zen-stuff fires pile-shown), remove sticky pods from the pods row
          document.addEventListener('pile-shown', clearAllStickyPods);
          document.addEventListener('pile-hidden', () => {
            debugLog('[PileRepair] pile-hidden: restore download chrome + focus invariants');
            updateDownloadCardsVisibility();
            if (focusedKeyRef.current && !activeDownloadCards.has(focusedKeyRef.current)) {
              focusedKeyRef.current =
                orderedPodKeys.length > 0 ? orderedPodKeys[orderedPodKeys.length - 1] : null;
              updateUIForFocusedDownload(focusedKeyRef.current, false);
            }
          });
          
          // Add close handler for the master tooltip's close button AFTER creating podsRowContainerElement
          const masterCloseBtn = masterTooltipDOMElement.querySelector(".card-close-button");
          if (masterCloseBtn) {
            const masterCloseHandler = (e) => {
              e.preventDefault();
              e.stopPropagation();
              debugLog(`[MasterClose] Master close button clicked. FocusedDownloadKey: ${focusedKeyRef.current}`);
              
              if (focusedKeyRef.current) {
                const keyToRemove = focusedKeyRef.current; // Capture the key
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
              if ((e.key === "Enter" || e.key === " ") && focusedKeyRef.current) {
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
                  debugLog(`[MasterUndo] Master undo/resume button clicked. FocusedDownloadKey: ${focusedKeyRef.current}`);
                  
                  if (focusedKeyRef.current) {
                      await undoRename(focusedKeyRef.current);
                      // UI update is handled within undoRename via updateUIForFocusedDownload
                  }
              };
              masterUndoBtn.addEventListener("click", masterUndoHandler);
              masterUndoBtn.addEventListener("keydown", async (e) => {
                  if ((e.key === "Enter" || e.key === " ") && focusedKeyRef.current) {
                      e.preventDefault();
                      await masterUndoHandler(e); // Make sure to await if handler is async
                  }
              });
          }

        } else if (downloadCardsContainer) {
          if (!podsRowContainerElement) {
            podsRowContainerElement = document.getElementById("userchrome-pods-row-container");
          }
          if (!masterTooltipDOMElement) {
            masterTooltipDOMElement = downloadCardsContainer.querySelector(".master-tooltip");
          }
        }

        if (window.zenTidyDownloadsTooltipLayout?.init) {
          Object.assign(
            tooltipLayoutRef,
            window.zenTidyDownloadsTooltipLayout.init({
              store,
              getPref,
              debugLog,
              formatBytes,
              previewApi,
              getAiRenamingPossible: () => aiRenamingPossible,
              addToAIRenameQueue,
              scheduleCardRemoval,
              isInQueue,
              updateQueueStatusInUI,
              getMasterTooltip: () => masterTooltipDOMElement,
              getPodsRowContainer: () => podsRowContainerElement,
              getDownloadCardsContainer: () => downloadCardsContainer,
              updateDownloadCardsVisibility
            })
          );
        }

        if (window.zenTidyDownloadsSync?.init && masterTooltipDOMElement && podsRowContainerElement) {
          const syncFns = window.zenTidyDownloadsSync.init({
            getMasterTooltip: () => masterTooltipDOMElement,
            getPodsContainer: () => podsRowContainerElement,
            getActiveCards: () => activeDownloadCards,
            focusedKeyRef,
            updateUI: (k, b) => updateUIForFocusedDownload(k, b),
            sidebarWidthRef,
            debugLog
          });
          initSidebarWidthSyncFn = syncFns.initSidebarWidthSync;
        }

        if (podsRowContainerElement) {
          podsRowContainerElement.addEventListener("wheel", handlePodScrollFocus, { passive: false });
        }

        const podsApi = window.zenTidyDownloadsPods.init({
          store,
          getPref,
          debugLog,
          getDownloadKey,
          getSafeFilename,
          previewApi,
          openDownloadedFile,
          getContentTypeFromFilename,
          SecurityUtils,
          Cc,
          Ci,
          getAddToAIRenameQueue: () => addToAIRenameQueue,
          getAiRenamingPossible: () => aiRenamingPossible,
          scheduleCardRemoval,
          clearStickyPodsOnly,
          updateDownloadCardsVisibility,
          updateUIForFocusedDownload,
          getPodsRowContainer: () => podsRowContainerElement,
          migrateAIRenameKeys: (oldKey, newKey) => tidyDeps.migrateAIRenameKeys(oldKey, newKey)
        });
        throttledCreateOrUpdateCard = podsApi.throttledCreateOrUpdateCard;

        const downloadListener = DownloadsAdapter.createDownloadViewListener({
          onCompletedState: (dl) => throttledCreateOrUpdateCard(dl),
          onRemoved: async (dl) => {
            const key = getDownloadKey(dl);
            await cancelAIProcessForDownload(key);

            const cardData = activeDownloadCards.get(key);
            if (cardData?.isManuallyCleaning) {
              debugLog(`[OnDownloadRemoved] Skipping removeCard/actual-download-removed for manually cleaned download: ${key}`);
              return;
            }

            await removeCard(key, false);

            actualDownloadRemovedEventListeners.forEach(callback => {
              try {
                callback(key);
              } catch (error) {
                debugLog('[API Event] Error in actualDownloadRemoved callback:', error);
              }
            });
            fireCustomEvent('actual-download-removed', { podKey: key });
            debugLog(`[API Event] Fired actual-download-removed for key: ${key}`);
          }
        });

        DownloadsAdapter.getAllDownloadsList()
          .then((list) => {
            if (!list) {
              console.error("DL Preview Mistral AI: No download list");
              return;
            }
            list.addView(downloadListener);
            list.getAll().then((all) => {
              const recentDownloads = DownloadsAdapter.filterInitialCompletedDownloads(all, {
                getDownloadKey,
                getPref,
                dismissedDownloads,
                activeDownloadCards,
                debugLog
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

        if (focusedKeyRef.current === downloadKey) {
          focusedKeyRef.current = null; // Clear focus first
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
            focusedKeyRef.current = newFocusKey;
            debugLog(`[RemoveCard] Old focus ${downloadKey} removed. New focus attempt: ${focusedKeyRef.current}`);
          }
        }
        

        
        // Update UI based on new focus (or lack thereof)
        // This will also hide the master tooltip if no pods are left or re-evaluate layout
        updateUIForFocusedDownload(focusedKeyRef.current, false); 
        
        // Additional check: if no cards remain, ensure container is hidden
        if (orderedPodKeys.length === 0 && downloadCardsContainer) {
          downloadCardsContainer.style.display = "none";
          downloadCardsContainer.style.opacity = "0";
          downloadCardsContainer.style.visibility = "hidden";
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
      }, getPref("extensions.downloads.autohide_delay_ms", 10000));
      
      debugLog(`scheduleCardRemoval: Scheduled removal for key: ${downloadKey} in ${getPref("extensions.downloads.autohide_delay_ms", 10000)}ms`, null, 'autohide');
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
      cardData.podElement.style.pointerEvents = 'auto';
      cardData.podElement.style.cursor = 'pointer';
      cardData.podElement.addEventListener('mouseenter', () => {
        document.dispatchEvent(new CustomEvent('request-pile-expand', { bubbles: true }));
      });
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
    if (focusedKeyRef.current === downloadKey && masterTooltipDOMElement) {
      masterTooltipDOMElement.style.opacity = "0";
      masterTooltipDOMElement.style.transform = "scaleY(0.8) translateY(10px)";
      masterTooltipDOMElement.style.pointerEvents = "none";
      // Set display: none after animation (same as manual close)
      setTimeout(() => {
        if (masterTooltipDOMElement.style.opacity === "0") {
          masterTooltipDOMElement.style.display = "none";
        }
      }, 300);
      focusedKeyRef.current = null;
      if (orderedPodKeys.length > 0) {
        focusedKeyRef.current = orderedPodKeys[orderedPodKeys.length - 1];
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

  // Remove sticky pods from DOM and state but keep containers visible (for new download replacing stickies).
  function clearStickyPodsOnly() {
    const keys = Array.from(stickyPods);
    if (keys.length === 0) return;
    debugLog(`[Sticky] Clearing ${keys.length} sticky pod(s) only (new download), keeping containers visible`);
    keys.forEach(clearStickyPod);
    if (podsRowContainerElement) podsRowContainerElement.style.pointerEvents = '';
  }

  // renameDownloadFileAndUpdateRecord, undoRename: tidy-downloads-fileops.uc.js (createRenameHandlers)

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

  } // Close initializeMainScript function

})();
