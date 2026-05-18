// Stub for pkce-challenge — the real package uses a dynamic ESM import
// (import('node:crypto')) which Node 18's Jest CJS VM cannot execute.
// Tests that exercise MCP OAuth/PKCE flows should mock this at the test level.
'use strict';
module.exports = function pkceChallenge() {
  return Promise.resolve({ code_challenge: 'mock_challenge', code_verifier: 'mock_verifier' });
};
module.exports.default = module.exports;
