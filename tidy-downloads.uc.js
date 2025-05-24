// userChrome.js / download_preview_mistral_pixtral_rename.uc.js - FINAL FIXED VERSION
// AI-powered download preview and renaming with Mistral vision API support
(function () {
  "use strict";

  // Use Components for Firefox compatibility
  const { classes: Cc, interfaces: Ci } = Components;

  // Wait for browser window to be ready
  if (location.href !== "chrome://browser/content/browser.xhtml") return;

  // --- Configuration ---
  const MISTRAL_API_URL = "https://api.mistral.ai/v1/chat/completions";
  const MISTRAL_MODEL = "pixtral-large-latest";
  let ENABLE_AI_RENAMING = true;
  const MISTRAL_API_KEY_PREF = "extensions.downloads.mistral_api_key";
  const DISABLE_AUTOHIDE_PREF = "extensions.downloads.disable_autohide";
  const AI_RENAMING_MAX_FILENAME_LENGTH = 70;
  const CARD_AUTOHIDE_DELAY_MS = 20000;
  const MAX_CARDS_DOM_LIMIT = 10;
  const CARD_INTERACTION_GRACE_PERIOD_MS = 5000;
  const PREVIEW_SIZE = "42px";
  const IMAGE_LOAD_ERROR_ICON = "🚫";
  const TEMP_LOADER_ICON = "⏳";
  const RENAMED_SUCCESS_ICON = "✓";
  const DEBUG_LOGGING = true;
  const MAX_FILE_SIZE_FOR_AI = 50 * 1024 * 1024; // 50MB limit
  const IMAGE_EXTENSIONS = new Set([
    ".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".svg", ".avif",
    ".ico", ".tif", ".tiff", ".jfif"
  ]);

  // Platform-agnostic path separator detection
  const PATH_SEPARATOR = navigator.platform.includes("Win") ? "\\" : "/";

  // Global state variables
  let downloadCardsContainer;
  const activeDownloadCards = new Map();
  let renamedFiles = new Set();
  let aiRenamingPossible = false;
  let cardUpdateThrottle = new Map(); // Prevent rapid updates

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

  // Improved key generation for downloads
  function getDownloadKey(download) {
    // Use target path as primary key since id is often undefined
    if (download?.target?.path) {
      return download.target.path;
    }
    if (download?.id) {
      return download.id;
    }
    // Generate a temporary key based on URL and timestamp
    const url = download?.source?.url || download?.url || "unknown";
    return `temp_${url}_${Date.now()}`;
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
      downloadCardsContainer = document.getElementById("userchrome-download-cards-container");
      if (!downloadCardsContainer) {
        downloadCardsContainer = document.createElement("div");
        downloadCardsContainer.id = "userchrome-download-cards-container";
        downloadCardsContainer.setAttribute("style", `
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
        `);
        document.body.appendChild(downloadCardsContainer);
      }

      // Attach listeners
      let downloadListener = {
        onDownloadAdded: (dl) => throttledCreateOrUpdateCard(dl),
        onDownloadChanged: (dl) => throttledCreateOrUpdateCard(dl),
        onDownloadRemoved: (dl) => removeCard(getDownloadKey(dl), false),
      };

      window.Downloads.getList(window.Downloads.ALL)
        .then((list) => {
          list.addView(downloadListener);
          list.getAll().then((all) =>
            all.forEach((dl) => {
              throttledCreateOrUpdateCard(dl, true);
            })
          );
        })
        .catch((e) => console.error("DL Preview Mistral AI: List error:", e));
    } catch (e) {
      console.error("DL Preview Mistral AI: Init error", e);
    }
  }

  // Throttled update to prevent rapid calls
  function throttledCreateOrUpdateCard(download, isNewCardOnInit = false) {
    const key = getDownloadKey(download);
    const now = Date.now();
    const lastUpdate = cardUpdateThrottle.get(key) || 0;
    
    // Only allow updates every 100ms unless it's the final state
    if (now - lastUpdate < 100 && !download.succeeded && !download.error && !download.canceled) {
      return;
    }
    
    cardUpdateThrottle.set(key, now);
    createOrUpdateCard(download, isNewCardOnInit);
  }

  // Function to create or update a download card - FIXED VERSION
  function createOrUpdateCard(download, isNewCardOnInit = false) {
    const key = getDownloadKey(download);
    if (!key) {
      debugLog("Skipping download object without usable key", download);
      return null;
    }

    // Enhanced diagnostic logging
    debugLog("[FUNC] createOrUpdateCard called", { 
        key, 
        succeeded: download.succeeded, 
        error: download.error,
        bytesReceived: download.bytesReceived,
        currentBytes: download.currentBytes,
        totalBytes: download.totalBytes,
        hasProgress: download.hasProgress,
        state: download.state,
        availableKeys: Object.keys(download) 
    });

    // Get or create card data
    let cardData = activeDownloadCards.get(key);
    const safeFilename = getSafeFilename(download);
    const displayName = download.aiName || safeFilename;

    if (!cardData) {
      // Create new card
      const cardElement = document.createElement("div");
      cardElement.className = "modern-download-card";
      cardElement.id = `userchrome-download-card-${Date.now()}`;
      cardElement.dataset.downloadKey = key; // Use key instead of id

      try {
        cardElement.innerHTML = `
          <div style="background:rgba(0,0,0,0.90);border-radius:14px;box-shadow:0 2px 8px rgba(0,0,0,0.25);display:flex;align-items:center;padding:14px 20px 14px 14px;min-width:340px;max-width:410px;margin-bottom:10px;">
            <div class="card-preview-container" style="flex:0 0 44px;width:44px;height:44px;display:flex;align-items:center;justify-content:center;background:rgba(255,255,255,0.07);border-radius:8px;overflow:hidden;margin-right:14px;"></div>
            <div style="flex:1;min-width:0;">
              <div class="card-status" style="font-size:13px;color:#b5b5b5;margin-bottom:2px;">Starting download...</div>
              <div class="card-title" style="font-size:15px;font-weight:600;line-height:1.3;color:white;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${displayName}</div>
              <div class="card-progress" style="font-size:12px;color:#8e8e8e;margin-top:2px;">Calculating size...</div>
            </div>
            <span class="card-close-button" title="Close" tabindex="0" role="button" style="margin-left:10px;background:none;border:none;color:#bbb;font-size:18px;cursor:pointer;padding:4px;">✕</span>
          </div>
        `;

        // Add close handler - FINAL FIX for dynamic key lookup
        const closeBtn = cardElement.querySelector(".card-close-button");
        if (closeBtn) {
          const closeHandler = (e) => {
            e.preventDefault();
            e.stopPropagation();
            // Find the current key for this card element dynamically
            let currentKey = null;
            for (const [mapKey, mapData] of activeDownloadCards.entries()) {
              if (mapData.cardElement === cardElement) {
                currentKey = mapKey;
                break;
              }
            }
            if (currentKey) {
              removeCard(currentKey, true);
            } else {
              // Fallback: remove the DOM element directly if not found in map
              debugLog("Card not found in activeDownloadCards, removing DOM element directly");
              if (cardElement.parentNode) {
                cardElement.style.transition = "opacity 0.3s";
                cardElement.style.opacity = "0";
                setTimeout(() => {
                  if (cardElement.parentNode) {
                    cardElement.parentNode.removeChild(cardElement);
                  }
                }, 300);
              }
            }
          };
          closeBtn.addEventListener("click", closeHandler);
          closeBtn.addEventListener("keydown", (e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              closeHandler(e);
            }
          });
        }

        // Set initial preview and add click listener to open file
        const previewElement = cardElement.querySelector(".card-preview-container");
        if (previewElement) {
          setGenericIcon(previewElement, download.contentType || "application/octet-stream");
          previewElement.style.cursor = "pointer";
          previewElement.title = "Click to open file"; // Tooltip
          
          previewElement.addEventListener("click", (e) => {
            e.stopPropagation(); // Prevent card close if preview is inside other clickable areas
            const currentCardData = activeDownloadCards.get(cardElement.dataset.downloadKey);
            if (currentCardData && currentCardData.download) {
              openDownloadedFile(currentCardData.download);
            } else {
              // Fallback if key changed or data is missing, try with the initial download object
              // This might be less reliable if path changed due to rename and was not updated on original 'download' ref
              debugLog("openDownloadedFile: Card data not found by key, attempting with initial download object", { key: cardElement.dataset.downloadKey });
              openDownloadedFile(download); 
            }
          });
        }

        // Store card data
        cardData = {
          cardElement,
          download,
          complete: false,
          key: key,
          originalFilename: safeFilename,
          lastInteractionTime: Date.now()
        };
        
        activeDownloadCards.set(key, cardData);

        // Add to container
        if (downloadCardsContainer) {
          downloadCardsContainer.appendChild(cardElement);
          debugLog("[UI] Card created and appended", { key, filename: safeFilename });
        }

      } catch (domErr) {
        debugLog("Error creating download card DOM:", domErr);
        return null;
      }
    } else {
      // Update existing card
      cardData.download = download; // Update download reference
    }

    // Update card content
    const cardElement = cardData.cardElement;
    const statusElement = cardElement.querySelector(".card-status");
    const titleElement = cardElement.querySelector(".card-title");
    const progressElement = cardElement.querySelector(".card-progress");

    // Update status based on download state
    if (statusElement) {
      if (download.error) {
        statusElement.textContent = `Error: ${download.error.message || "Download failed"}`;
        statusElement.style.color = "#ff6b6b";
      } else if (download.canceled) {
        statusElement.textContent = "Download canceled";
        statusElement.style.color = "#ff9f43";
      } else if (download.succeeded) {
        statusElement.textContent = "Download completed";
        statusElement.style.color = "#1dd1a1";
        
        // Mark as complete and set preview
        if (!cardData.complete) {
          cardData.complete = true;
          cardElement.classList.add("completed");
          
          const previewElement = cardElement.querySelector(".card-preview-container");
          if (previewElement) {
            // Await the preview setting since it can now be async (for text snippets)
            setCompletedFilePreview(previewElement, download) 
              .catch(e => debugLog("Error setting completed file preview (async)", {error: e, download}));
          }

          // Process AI renaming if enabled
          if (ENABLE_AI_RENAMING && aiRenamingPossible && 
              download.target?.path && !renamedFiles.has(download.target.path)) {
            
            setTimeout(() => {
              processDownloadForAIRenaming(download, safeFilename, key)
                .catch((e) => console.error("Error in AI renaming:", e));
            }, 1500); // Delay to ensure file is fully written
          }

          // Schedule auto-hide
          scheduleCardRemoval(key);
        }
      } else if (typeof download.currentBytes === 'number' && download.totalBytes > 0 && download.hasProgress) { // Use currentBytes
        const percent = Math.round((download.currentBytes / download.totalBytes) * 100);
        statusElement.textContent = `Downloading... ${percent}%`;
        statusElement.style.color = "#54a0ff";
      } else if (!download.succeeded && !download.error && !download.canceled) { // Generic in-progress state
        statusElement.textContent = "Downloading...";
        statusElement.style.color = "#54a0ff";
      } else {
        statusElement.textContent = "Starting download...";
        statusElement.style.color = "#b5b5b5";
      }
    }

    // Update filename if AI renamed
    if (titleElement) {
      const currentDisplayName = download.aiName || safeFilename;
      if (titleElement.textContent !== currentDisplayName) {
        titleElement.textContent = currentDisplayName;
        titleElement.title = currentDisplayName;
      }
    }

    // Update progress info
    if (progressElement) {
      if (download.succeeded) {
        let finalSize = download.currentBytes; // Use currentBytes first
        // If currentBytes is not a valid number or is 0, try totalBytes.
        if (!(typeof finalSize === 'number' && finalSize > 0)) {
          finalSize = download.totalBytes;
        }
        progressElement.textContent = `${formatBytes(finalSize || 0)}`;
      } else if (typeof download.currentBytes === 'number' && download.totalBytes > 0) { // Use currentBytes
        const downloaded = formatBytes(download.currentBytes);
        const total = formatBytes(download.totalBytes);
        progressElement.textContent = `${downloaded} / ${total}`;
      } else if (!download.succeeded && !download.error && !download.canceled) { // If actively downloading but no numbers yet
        progressElement.textContent = "Processing..."; 
      } else { // Initial state or unknown
        progressElement.textContent = "Calculating size...";
      }
    }

    return cardElement;
  }

  // Improved card removal function
  function removeCard(downloadKey, force = false) {
    try {
      const cardData = activeDownloadCards.get(downloadKey);
      if (!cardData) {
        debugLog(`removeCard: No card data found for key: ${downloadKey}`);
        return false;
      }

      const cardElement = cardData.cardElement;
      if (!cardElement) {
        debugLog(`removeCard: No card element found for key: ${downloadKey}`);
        return false;
      }

      // Don't remove if user has interacted recently unless forced
      if (!force && cardData.lastInteractionTime && 
          Date.now() - cardData.lastInteractionTime < CARD_INTERACTION_GRACE_PERIOD_MS) {
        debugLog(`removeCard: Skipping removal due to recent interaction: ${downloadKey}`);
        return false;
      }

      // Clean animation
      cardElement.style.transition = "opacity 0.3s, transform 0.3s";
      cardElement.style.opacity = "0";
      cardElement.style.transform = "translateY(-20px)";

      setTimeout(() => {
        if (cardElement.parentNode) {
          cardElement.parentNode.removeChild(cardElement);
        }
        activeDownloadCards.delete(downloadKey);
        cardUpdateThrottle.delete(downloadKey);
        debugLog(`Card removed for download: ${downloadKey}`);
      }, 300);

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

      setTimeout(() => {
        removeCard(downloadKey, false);
      }, CARD_AUTOHIDE_DELAY_MS);
    } catch (e) {
      console.error("Error scheduling card removal:", e);
    }
  }

  // Helper function to get preferences
  function getPref(prefName, defaultValue) {
    try {
      const prefService = Cc["@mozilla.org/preferences-service;1"]
        .getService(Ci.nsIPrefService);
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
    if (!previewElement) return;
    try {
      let icon = "📄";
      if (typeof contentType === "string") {
        if (contentType.includes("image/")) icon = "🖼️";
        else if (contentType.includes("video/")) icon = "🎬";
        else if (contentType.includes("audio/")) icon = "🎵";
        else if (contentType.includes("text/")) icon = "📝";
        else if (contentType.includes("application/pdf")) icon = "📕";
        else if (contentType.includes("application/zip") || contentType.includes("application/x-rar")) icon = "🗜️";
        else if (contentType.includes("application/")) icon = "📦";
      }
      previewElement.innerHTML = `<span style="font-size: 24px;">${icon}</span>`;
    } catch (e) {
      debugLog("Error setting generic icon:", e);
      previewElement.innerHTML = `<span style="font-size: 24px;">📄</span>`;
    }
  }

  // Set preview for completed image file
  async function setCompletedFilePreview(previewElement, download) {
    if (!previewElement) return;

    debugLog("[setCompletedFilePreview] Called", { 
      contentType: download?.contentType, 
      targetPath: download?.target?.path,
      filename: download?.filename 
    });

    const textMimeTypes = new Set([
      "text/plain",
      "text/markdown",
      "application/javascript",
      "text/javascript",
      "text/css",
      "text/html",
      "application/json",
      "application/xml",
      "text/xml"
      // Add more as needed
    ]);

    try {
      if (download.target?.path && textMimeTypes.has(download.contentType?.toLowerCase())) {
        const snippet = await readTextFileSnippet(download.target.path);
        if (snippet) {
          previewElement.innerHTML = ""; // Clear previous content
          const pre = document.createElement("pre");
          pre.textContent = snippet;
          pre.style.fontSize = "9px";
          pre.style.lineHeight = "1.2";
          pre.style.fontFamily = "monospace";
          pre.style.color = "#ccc";
          pre.style.margin = "0";
          pre.style.padding = "4px";
          pre.style.overflow = "hidden";
          pre.style.maxWidth = PREVIEW_SIZE; 
          pre.style.maxHeight = PREVIEW_SIZE;
          pre.style.borderRadius = "4px";
          pre.style.backgroundColor = "rgba(255,255,255,0.05)";
          pre.style.whiteSpace = "pre-wrap"; // Allow wrapping
          pre.style.wordBreak = "break-all"; // Break long words if necessary
          previewElement.appendChild(pre);
          debugLog("[setCompletedFilePreview] Text snippet preview set", { path: download.target.path });
          return; // Snippet set, exit
        }
      } else if (download?.contentType?.startsWith("image/") && download.target?.path) {
        // Existing image preview logic (good first check)
        debugLog("[setCompletedFilePreview] Attempting image preview via contentType", { path: download.target.path, contentType: download.contentType });
        const img = document.createElement("img");
        const imgSrc = `file:///${download.target.path.replace(/\\/g, '/')}`;
        img.src = imgSrc;
        img.style.maxWidth = PREVIEW_SIZE;
        img.style.maxHeight = PREVIEW_SIZE;
        img.style.objectFit = "contain";
        img.style.borderRadius = "4px";
        img.style.transition = "all 0.3s ease";
        img.style.opacity = "0";
        
        img.onload = () => { 
          img.style.opacity = "1"; 
          debugLog("[setCompletedFilePreview] Image loaded successfully (by contentType)", { src: imgSrc });
        };
        img.onerror = () => {
          debugLog("[setCompletedFilePreview] Image failed to load (by contentType)", { src: imgSrc });
          // Fallback to generic icon if even contentType-based image load fails
          setGenericIcon(previewElement, "image/generic"); // Indicate it was thought to be an image
        };
        
        previewElement.innerHTML = "";
        previewElement.appendChild(img);
      } else if (download.target?.path) { // Fallback: Check extension if contentType is missing or not an image type
        const filePath = download.target.path.toLowerCase();
        let isImageTypeByExtension = false;
        for (const ext of IMAGE_EXTENSIONS) {
          if (filePath.endsWith(ext)) {
            isImageTypeByExtension = true;
            break;
          }
        }
        if (isImageTypeByExtension) {
          debugLog("[setCompletedFilePreview] Attempting image preview via file extension", { path: download.target.path });
          const img = document.createElement("img");
          const imgSrc = `file:///${download.target.path.replace(/\\/g, '/')}`;
          img.src = imgSrc;
          img.style.maxWidth = PREVIEW_SIZE;
          img.style.maxHeight = PREVIEW_SIZE;
          img.style.objectFit = "contain";
          img.style.borderRadius = "4px";
          img.style.transition = "all 0.3s ease";
          img.style.opacity = "0";
          
          img.onload = () => { 
            img.style.opacity = "1"; 
            debugLog("[setCompletedFilePreview] Image loaded successfully (by extension)", { src: imgSrc });
          };
          img.onerror = () => {
            debugLog("[setCompletedFilePreview] Image failed to load (by extension)", { src: imgSrc });
            // Fallback to generic icon if even extension-based image load fails
            setGenericIcon(previewElement, "image/generic"); // Indicate it was thought to be an image
          };
          
          previewElement.innerHTML = "";
          previewElement.appendChild(img);
        } else {
          debugLog("[setCompletedFilePreview] No specific preview (contentType or extension), setting generic icon", { contentType: download?.contentType, path: download.target.path });
          setGenericIcon(previewElement, download?.contentType);
        }
      } else {
        debugLog("[setCompletedFilePreview] No target path for preview, setting generic icon", { download });
        setGenericIcon(previewElement, null); // No path, no content type known
      }
    } catch (e) {
      debugLog("Error setting file preview:", e);
      previewElement.innerHTML = `<span style="font-size: 24px;">🚫</span>`;
    }
  }

  // Process download for AI renaming - with file size check
  async function processDownloadForAIRenaming(download, originalNameForUICard, keyOverride) {
    const key = keyOverride || getDownloadKey(download);
    const cardData = activeDownloadCards.get(key);
    if (!cardData) {
      debugLog("Card data not found for download");
      return false;
    }

    const cardElement = cardData.cardElement;
    const statusEl = cardElement.querySelector(".card-status");
    if (!statusEl) return false;

    const previewElement = cardElement.querySelector(".card-preview-container");
    let originalPreviewTitle = "";
    if (previewElement) {
      originalPreviewTitle = previewElement.title;
    }

    const downloadPath = download.target.path;
    if (!downloadPath) return false;

    // Skip if already processed
    if (renamedFiles.has(downloadPath)) {
      debugLog(`Skipping rename - already processed: ${downloadPath}`);
      return false;
    }

    // Check file size before processing
    try {
      const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
      file.initWithPath(downloadPath);
      if (file.fileSize > MAX_FILE_SIZE_FOR_AI) {
        debugLog(`Skipping AI rename - file too large: ${formatBytes(file.fileSize)}`);
        statusEl.textContent = "File too large for AI analysis";
        return false;
      }
    } catch (e) {
      debugLog("Error checking file size:", e);
      return false;
    }

    renamedFiles.add(downloadPath);

    try {
      cardElement.classList.add("renaming");
      statusEl.textContent = "Analyzing file...";
      if (previewElement) {
        previewElement.style.pointerEvents = "none";
        previewElement.title = "Renaming in progress...";
      }

      const currentFilename = downloadPath.split(PATH_SEPARATOR).pop();
      const fileExtension = currentFilename.includes(".") 
        ? currentFilename.substring(currentFilename.lastIndexOf(".")).toLowerCase() 
        : "";

      const isImage = IMAGE_EXTENSIONS.has(fileExtension);
      debugLog(`Processing file: ${currentFilename} (${isImage ? "Image" : "Non-image"})`);

      let suggestedName = null;

      // Try image analysis for images
      if (isImage) {
        statusEl.textContent = "Analyzing image...";
        const imagePrompt = `Create a specific, descriptive filename for this image.
Rules:
- Use 2-4 specific words describing the main subject or content
- Be specific about what's in the image (e.g. "mountain-lake-sunset" not just "landscape")
- Use hyphens between words
- No generic words like "image" or "photo"
- Keep extension "${fileExtension}"
- Maximum length: ${AI_RENAMING_MAX_FILENAME_LENGTH} characters
Respond with ONLY the filename.`;

        suggestedName = await callMistralAPI({
          prompt: imagePrompt,
          localPath: downloadPath,
          fileExtension: fileExtension,
        });
      }

      // Fallback to metadata-based naming
      if (!suggestedName) {
        statusEl.textContent = "Generating better name...";
        const sourceURL = download.source?.url || "unknown";
        const metadataPrompt = `Create a specific, descriptive filename for this ${isImage ? "image" : "file"}.
Original filename: "${currentFilename}"
Download URL: "${sourceURL}"
Rules:
- Use 2-5 specific words about the content or purpose
- Be more specific than the original name
- Use hyphens between words
- Keep extension "${fileExtension}"
- Maximum length: ${AI_RENAMING_MAX_FILENAME_LENGTH} characters
Respond with ONLY the filename.`;

        suggestedName = await callMistralAPI({
          prompt: metadataPrompt,
          localPath: null,
          fileExtension: fileExtension,
        });
      }

      if (!suggestedName || suggestedName === "rate-limited") {
        debugLog("No valid name suggestion received");
        statusEl.textContent = suggestedName === "rate-limited" ? 
          "⚠️ API rate limit reached" : "Could not generate a better name";
        renamedFiles.delete(downloadPath);
        return false;
      }

      // Clean and validate the suggested name
      let cleanName = suggestedName
        .replace(/[^a-zA-Z0-9\-_\.]/g, "")
        .replace(/\s+/g, "-")
        .toLowerCase();

      if (cleanName.length > AI_RENAMING_MAX_FILENAME_LENGTH - fileExtension.length) {
        cleanName = cleanName.substring(0, AI_RENAMING_MAX_FILENAME_LENGTH - fileExtension.length);
      }

      if (fileExtension && !cleanName.toLowerCase().endsWith(fileExtension.toLowerCase())) {
        cleanName = cleanName + fileExtension;
      }

      if (cleanName.length <= 2 || cleanName.toLowerCase() === currentFilename.toLowerCase()) {
        debugLog("Skipping rename - name too short or same as original");
        renamedFiles.delete(downloadPath);
        return false;
      }

      debugLog(`Renaming to: ${cleanName}`);
      statusEl.textContent = `Renaming to: ${cleanName}`;

      const success = await renameDownloadFileAndUpdateRecord(download, cleanName, key);

      if (success) {
        // Update the download object and card
        download.aiName = cleanName;
        const titleEl = cardElement.querySelector(".card-title");
        if (titleEl) {
          titleEl.textContent = cleanName;
          titleEl.title = cleanName;
        }

        statusEl.textContent = "Renamed successfully";
        statusEl.style.color = "#1dd1a1";
        cardElement.classList.remove("renaming");
        cardElement.classList.add("renamed");

        debugLog(`Successfully renamed to: ${cleanName}`);
        return true;
      } else {
        renamedFiles.delete(downloadPath);
        statusEl.textContent = "Rename failed";
        cardElement.classList.remove("renaming");
        return false;
      }
    } catch (e) {
      console.error("AI Rename error:", e);
      renamedFiles.delete(downloadPath);
      statusEl.textContent = "Rename error";
      cardElement.classList.remove("renaming");
      return false;
    } finally {
      // Ensure preview element clickability is restored
      if (previewElement) {
        previewElement.style.pointerEvents = "auto";
        previewElement.title = originalPreviewTitle;
      }
    }
  }

  // Improved file renaming function
  async function renameDownloadFileAndUpdateRecord(download, newName, key) {
    try {
      const oldPath = download.target.path;
      if (!oldPath) throw new Error("No file path available");

      const directory = oldPath.substring(0, oldPath.lastIndexOf(PATH_SEPARATOR));
      const oldFileName = oldPath.split(PATH_SEPARATOR).pop();
      const fileExt = oldFileName.includes(".") 
        ? oldFileName.substring(oldFileName.lastIndexOf(".")) 
        : "";

      let cleanNewName = newName.trim().replace(/[\\/:*?"<>|]/g, "");
      if (fileExt && !cleanNewName.endsWith(fileExt)) {
        cleanNewName += fileExt;
      }

      // Handle duplicate names
      let finalName = cleanNewName;
      let counter = 1;
      while (counter < 100) {
        const testPath = directory + PATH_SEPARATOR + finalName;
        let exists = false;
        try {
          const testFile = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
          testFile.initWithPath(testPath);
          exists = testFile.exists();
        } catch (e) {
          // File doesn't exist or can't access - proceed
        }
        if (!exists) break;
        
        const baseName = cleanNewName.includes(".") 
          ? cleanNewName.substring(0, cleanNewName.lastIndexOf(".")) 
          : cleanNewName;
        finalName = `${baseName}-${counter}${fileExt}`;
        counter++;
      }

      const newPath = directory + PATH_SEPARATOR + finalName;
      debugLog("Rename paths", { oldPath, newPath });

      const oldFile = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
      oldFile.initWithPath(oldPath);

      if (!oldFile.exists()) throw new Error("Source file does not exist");

      // Perform the rename
      oldFile.moveTo(null, finalName);

      // Update download record
      download.target.path = newPath;
      
      // Update card data key mapping
      const cardData = activeDownloadCards.get(key);
      if (cardData) {
        activeDownloadCards.delete(key);
        activeDownloadCards.set(newPath, cardData);
        cardData.key = newPath;
        debugLog(`Updated card key mapping from ${key} to ${newPath}`);
      }

      debugLog("File renamed successfully");
      return true;
    } catch (e) {
      console.error("Rename failed:", e);
      return false;
    }
  }

  function formatBytes(b, d = 2) {
    if (b === 0) return "0 B";
    const sizes = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(b) / Math.log(1024));
    return `${parseFloat((b / Math.pow(1024, i)).toFixed(d))} ${sizes[i]}`;
  }

  // Mistral API function - with better error handling
  async function callMistralAPI({ prompt, localPath, fileExtension }) {
    try {
      // Get API key
      let apiKey = "";
      try {
        const prefService = Cc["@mozilla.org/preferences-service;1"]
          .getService(Ci.nsIPrefService);
        const branch = prefService.getBranch("extensions.downloads.");
        apiKey = branch.getStringPref("mistral_api_key", "");
      } catch (e) {
        debugLog("Failed to get API key from preferences", e);
        return null;
      }

      if (!apiKey) {
        debugLog("No API key found");
        return null;
      }

      // Build message content
      let content = [{ type: "text", text: prompt }];

      // Add image data if provided
      if (localPath) {
        try {
          const imageBase64 = fileToBase64(localPath);
          if (imageBase64) {
            const mimeType = getMimeTypeFromExtension(fileExtension);
            content.push({
              type: "image_url",
              image_url: { url: `data:${mimeType};base64,${imageBase64}` },
            });
          }
        } catch (e) {
          debugLog("Failed to encode image, proceeding without it", e);
        }
      }

      const payload = {
        model: MISTRAL_MODEL,
        messages: [{ role: "user", content: content }],
        max_tokens: 100,
        temperature: 0.2,
      };

      debugLog("Sending API request to Mistral");

      const response = await fetch(MISTRAL_API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        if (response.status === 429) return "rate-limited";
        debugLog(`API error ${response.status}: ${response.statusText}`);
        return null;
      }

      const data = await response.json();
      debugLog("Raw API response:", data);

      return data.choices?.[0]?.message?.content?.trim() || null;
    } catch (error) {
      console.error("Mistral API error:", error);
      return null;
    }
  }

  function getMimeTypeFromExtension(ext) {
    switch (ext?.toLowerCase()) {
      case ".png": return "image/png";
      case ".gif": return "image/gif";
      case ".svg": return "image/svg+xml";
      case ".webp": return "image/webp";
      case ".bmp": return "image/bmp";
      case ".avif": return "image/avif";
      case ".ico": return "image/x-icon";
      case ".tif": return "image/tiff";
      case ".tiff": return "image/tiff";
      case ".jfif": return "image/jpeg";
      default: return "image/jpeg";
    }
  }

  function fileToBase64(path) {
    try {
      const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
      file.initWithPath(path);
      
      // Check file size
      if (file.fileSize > MAX_FILE_SIZE_FOR_AI) {
        debugLog("File too large for base64 conversion");
        return null;
      }

      const fstream = Cc["@mozilla.org/network/file-input-stream;1"]
        .createInstance(Ci.nsIFileInputStream);
      fstream.init(file, -1, 0, 0);
      
      const bstream = Cc["@mozilla.org/binaryinputstream;1"]
        .createInstance(Ci.nsIBinaryInputStream);
      bstream.setInputStream(fstream);
      
      const bytes = bstream.readBytes(file.fileSize);
      fstream.close();
      bstream.close();

      // Convert to base64 in chunks to avoid memory issues
      const chunks = [];
      const CHUNK_SIZE = 0x8000;
      for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
        chunks.push(
          String.fromCharCode.apply(
            null,
            bytes.slice(i, i + CHUNK_SIZE).split("").map(c => c.charCodeAt(0))
          )
        );
      }
      
      return btoa(chunks.join(""));
    } catch (e) {
      debugLog("fileToBase64 error:", e);
      return null;
    }
  }

  // --- Helper Function to Read Text File Snippet ---
  async function readTextFileSnippet(filePath, maxLines = 5, maxLengthPerLine = 80) {
    let fstream = null;
    let scriptableStream = null;
    try {
      const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
      file.initWithPath(filePath);

      if (!file.exists() || !file.isReadable()) {
        debugLog("readTextFileSnippet: File does not exist or is not readable", { filePath });
        return null;
      }

      if (file.fileSize === 0) {
        return "[Empty file]";
      }
      
      if (file.fileSize > 1 * 1024 * 1024) { // 1MB limit for snippet reading
        debugLog("readTextFileSnippet: File too large for snippet", { filePath, fileSize: file.fileSize });
        return "[File too large for preview]";
      }

      fstream = Cc["@mozilla.org/network/file-input-stream;1"].createInstance(Ci.nsIFileInputStream);
      fstream.init(file, -1, 0, 0); 
      
      scriptableStream = Cc["@mozilla.org/scriptableinputstream;1"].createInstance(Ci.nsIScriptableInputStream);
      scriptableStream.init(fstream);

      const textDecoder = new TextDecoder("utf-8");
      let lineBuffer = ""; 
      let linesRead = 0;
      let outputLines = [];
      const bufferSize = 4096; // How much to read at a time
      let chunk = "";

      while (linesRead < maxLines) {
        // Read a chunk of data. scriptableStream.read returns a string of bytes here.
        let byteString = scriptableStream.read(bufferSize);
        if (byteString.length === 0) { // EOF
          if (lineBuffer.length > 0) { 
            let trimmedLine = lineBuffer.trimEnd();
            if (trimmedLine.length > maxLengthPerLine) {
              trimmedLine = trimmedLine.substring(0, maxLengthPerLine) + "...";
            }
            outputLines.push(trimmedLine);
            linesRead++;
          }
          break; // Exit while loop
        }
        
        // Decode the byte string to a proper UTF-8 string.
        // Need to be careful with characters split across chunks. Pass {stream: true} to decoder.
        lineBuffer += textDecoder.decode(Uint8Array.from(byteString, c => c.charCodeAt(0)), { stream: true });
        
        let eolIndex;
        // Process all complete lines found in the buffer
        while ((eolIndex = lineBuffer.indexOf('\n')) !== -1 && linesRead < maxLines) {
          let currentLine = lineBuffer.substring(0, eolIndex);
          let trimmedLine = currentLine.trimEnd();
          if (trimmedLine.length > maxLengthPerLine) {
            trimmedLine = trimmedLine.substring(0, maxLengthPerLine) + "...";
          }
          outputLines.push(trimmedLine);
          linesRead++;
          lineBuffer = lineBuffer.substring(eolIndex + 1);
        }
        
        // If we've read maxLines, but there's still unprocessed data in lineBuffer (without a newline)
        // and we still have capacity in outputLines (this check is mostly for safety, might be redundant)
        if (linesRead >= maxLines && lineBuffer.length > 0 && outputLines.length === maxLines) {
            // If the last processed line made us hit maxLines, and there's a remainder,
            // we might want to indicate truncation on the *last added line* if it wasn't already done.
            // For now, this will just mean the lineBuffer remainder is ignored if maxLines is hit.
        }
      }
      
      // After the loop, if maxLines was not reached and there's still data in lineBuffer (last line without newline)
      if (linesRead < maxLines && lineBuffer.length > 0) {
        let trimmedLine = lineBuffer.trimEnd();
        if (trimmedLine.length > maxLengthPerLine) {
          trimmedLine = trimmedLine.substring(0, maxLengthPerLine) + "...";
        }
        outputLines.push(trimmedLine);
      }

      if (outputLines.length === 0) {
        // This might happen if the file is very small and only newlines, or other edge cases.
        return "[Could not read snippet contents]"; 
      }

      return outputLines.join("\n");

    } catch (ex) {
      debugLog("readTextFileSnippet error:", { filePath, error: ex.message, stack: ex.stack });
      return "[Error reading file preview]"; 
    } finally {
      if (scriptableStream && typeof scriptableStream.close === 'function') {
        try { scriptableStream.close(); } catch (e) { debugLog("Error closing scriptableStream",{e}); }
      }
      if (fstream && typeof fstream.close === 'function') {
          try { fstream.close(); } catch (e) { debugLog("Error closing fstream in finally", {e}); }
      }
    }
  }

  // --- Function to Open Downloaded File ---
  function openDownloadedFile(download) {
    if (!download || !download.target || !download.target.path) {
      debugLog("openDownloadedFile: Invalid download object or path", { download });
      return;
    }

    const filePath = download.target.path;
    debugLog("openDownloadedFile: Attempting to open file", { filePath });

    try {
      const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
      file.initWithPath(filePath);

      if (file.exists() && file.isReadable()) {
        file.launch(); // Opens with default system application
      } else {
        debugLog("openDownloadedFile: File does not exist or is not readable", { filePath });
        // Optionally, notify the user via the card status or an alert
        // For now, just logging.
      }
    } catch (ex) {
      debugLog("openDownloadedFile: Error launching file", { filePath, error: ex.message, stack: ex.stack });
      // Optionally, notify the user
    }
  }

  // Verify Mistral API connection
  async function verifyMistralConnection() {
    try {
      let apiKey = "";
      try {
        const prefService = Cc["@mozilla.org/preferences-service;1"]
          .getService(Ci.nsIPrefService);
        const branch = prefService.getBranch("extensions.downloads.");
        apiKey = branch.getStringPref("mistral_api_key", "");
      } catch (e) {
        console.error("Failed to get API key from preferences", e);
        aiRenamingPossible = false;
        ENABLE_AI_RENAMING = false;
        return;
      }

      if (!apiKey) {
        debugLog("No Mistral API key found in preferences. AI renaming disabled.");
        aiRenamingPossible = false;
        ENABLE_AI_RENAMING = false;
        return;
      }

      const testResponse = await fetch(MISTRAL_API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: MISTRAL_MODEL,
          messages: [
            { role: "system", content: "You are a helpful assistant." },
            { role: "user", content: "Hello, this is a test connection. Respond with 'ok'." },
          ],
          max_tokens: 5,
        }),
      });

      if (testResponse.ok) {
        debugLog("Mistral API connection successful!");
        aiRenamingPossible = true;
        ENABLE_AI_RENAMING = true;
      } else {
        console.error("Mistral API connection failed:", await testResponse.text());
        aiRenamingPossible = false;
        ENABLE_AI_RENAMING = false;
      }
    } catch (e) {
      console.error("Error verifying Mistral API connection:", e);
      aiRenamingPossible = false;
      ENABLE_AI_RENAMING = false;
    }
  }

  console.log("Download Preview Mistral AI Script (FINAL FIXED): Execution finished, initialization scheduled/complete.");
})(); 