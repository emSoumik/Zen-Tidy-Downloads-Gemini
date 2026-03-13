// ==UserScript==
// @include   main
// @ignorecache
// ==/UserScript==

// tidy-downloads-fileops.uc.js
// File operations: open, erase from history, content-type detection
// Receives context from tidy-downloads.uc.js
(function () {
  "use strict";

  if (location.href !== "chrome://browser/content/browser.xhtml") return;

  const { classes: Cc, interfaces: Ci } = Components;

  window.zenTidyDownloadsFileOps = {
    /**
     * Initialize file ops module. Called by tidy-downloads.uc.js with context.
     * @param {Object} ctx - Context from main script
     * @param {Object} ctx.SecurityUtils - Path validation utilities
     * @param {function} ctx.debugLog - debugLog
     * @returns {{ openDownloadedFile, eraseDownloadFromHistory, getContentTypeFromFilename }}
     */
    init(ctx) {
      const { SecurityUtils, debugLog } = ctx;

      /**
       * Open a downloaded file with the default system application
       * @param {Object} download - Download object with target path
       */
      function openDownloadedFile(download) {
        if (!download || !download.target || !download.target.path) {
          debugLog("openDownloadedFile: Invalid download object or path", { download });
          return;
        }

        const filePath = download.target.path;

        const validation = SecurityUtils.validateFilePath(filePath, { strict: false });
        if (!validation.valid) {
          debugLog("openDownloadedFile: Path validation failed", {
            filePath,
            error: validation.error,
            code: validation.code
          });
          return;
        }

        debugLog("openDownloadedFile: Attempting to open file", { filePath });

        try {
          const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
          file.initWithPath(filePath);

          if (file.exists() && file.isReadable()) {
            file.launch();
            debugLog("openDownloadedFile: File launched successfully", { filePath });
          } else {
            debugLog("openDownloadedFile: File does not exist or is not readable", { filePath });
          }
        } catch (ex) {
          const errorInfo = {
            filePath,
            error: ex.message || ex.toString(),
            name: ex.name || "Error",
            stack: ex.stack
          };
          debugLog("openDownloadedFile: Error launching file", errorInfo);
          console.error("openDownloadedFile failed:", errorInfo);
        }
      }

      /**
       * Erase download from Firefox history
       * @param {Object} download - Download object to remove
       * @throws {Error} If download object is invalid or operation fails
       */
      async function eraseDownloadFromHistory(download) {
        if (!download) {
          debugLog("eraseDownloadFromHistory: Invalid download object", { download });
          throw new Error("Invalid download object");
        }

        if (download.target?.path) {
          const pathValidation = SecurityUtils.validateFilePath(download.target.path, { strict: false });
          if (!pathValidation.valid) {
            debugLog("eraseDownloadFromHistory: Path validation warning", {
              path: download.target.path,
              error: pathValidation.error,
              code: pathValidation.code
            });
          }
        }

        try {
          debugLog("eraseDownloadFromHistory: Attempting to erase download", {
            id: download.id,
            path: download.target?.path,
            state: download.state
          });

          const list = await window.Downloads.getList(window.Downloads.ALL);
          const downloads = await list.getAll();
          const targetDownload = downloads.find(dl => {
            if (download.id && dl.id === download.id) return true;

            if (download.target?.path && dl.target?.path) {
              const downloadPathValid = SecurityUtils.validateFilePath(download.target.path, { strict: false });
              const dlPathValid = SecurityUtils.validateFilePath(dl.target.path, { strict: false });
              if (downloadPathValid.valid && dlPathValid.valid &&
                dl.target.path === download.target.path) return true;
            }

            if (download.source?.url && dl.source?.url &&
              dl.source.url === download.source.url &&
              download.startTime && dl.startTime &&
              Math.abs(new Date(download.startTime) - new Date(dl.startTime)) < 5000) return true;

            return false;
          });

          if (targetDownload) {
            await list.remove(targetDownload);
            debugLog("eraseDownloadFromHistory: Successfully removed download from list", {
              id: targetDownload.id,
              originalId: download.id,
              path: targetDownload.target?.path
            });
          } else {
            debugLog("eraseDownloadFromHistory: Download not found in list", {
              id: download.id,
              path: download.target?.path,
              availableDownloads: downloads.length
            });
          }
        } catch (error) {
          debugLog("eraseDownloadFromHistory: Error erasing download", {
            id: download.id,
            path: download.target?.path,
            error: error.message,
            stack: error.stack
          });
          throw error;
        }
      }

      /**
       * Get MIME type from filename extension
       * @param {string} filename - Filename with extension
       * @returns {string} MIME type or application/octet-stream
       */
      function getContentTypeFromFilename(filename) {
        if (!filename) return "application/octet-stream";

        const ext = filename.toLowerCase().split(".").pop();
        const mimeTypes = {
          jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png",
          gif: "image/gif", webp: "image/webp", bmp: "image/bmp",
          svg: "image/svg+xml", ico: "image/x-icon",

          pdf: "application/pdf", doc: "application/msword",
          docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          xls: "application/vnd.ms-excel",
          xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          ppt: "application/vnd.ms-powerpoint",
          pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",

          txt: "text/plain", html: "text/html", css: "text/css",
          js: "text/javascript", json: "application/json",
          xml: "text/xml", csv: "text/csv",

          mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg",
          flac: "audio/flac", aac: "audio/aac", m4a: "audio/mp4",

          mp4: "video/mp4", avi: "video/x-msvideo", mov: "video/quicktime",
          wmv: "video/x-ms-wmv", flv: "video/x-flv", webm: "video/webm",
          mkv: "video/x-matroska",

          zip: "application/zip", rar: "application/x-rar-compressed",
          "7z": "application/x-7z-compressed", tar: "application/x-tar",
          gz: "application/gzip",

          exe: "application/x-msdownload", msi: "application/x-msi",
          deb: "application/x-debian-package", rpm: "application/x-rpm"
        };

        return mimeTypes[ext] || "application/octet-stream";
      }

      return {
        openDownloadedFile,
        eraseDownloadFromHistory,
        getContentTypeFromFilename
      };
    }
  };
})();
