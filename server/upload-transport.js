"use strict";

const http = require("http");

// The native client sets a ten-minute upload timeout. Keep a finite total receive deadline with
// headroom for slow networks, including the existing larger web upload routes.
const UPLOAD_REQUEST_TIMEOUT_MS = 15 * 60 * 1000;

function createUploadServer(handler, options = {}) {
  return http.createServer({
    requestTimeout: UPLOAD_REQUEST_TIMEOUT_MS,
    headersTimeout: 60 * 1000,
    connectionsCheckingInterval: 1000,
    ...options
  }, handler);
}

module.exports = { createUploadServer, UPLOAD_REQUEST_TIMEOUT_MS };
