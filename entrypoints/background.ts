export default defineBackground(() => {
  // Chrome API glue (cookies/webRequest/messaging/storage) is added in
  // Phase 3-4. This entrypoint intentionally stays inert in Phase 1, which
  // is pure, Chrome-API-free detection logic only (src/shared, src/engine,
  // src/identity, src/sensors/*).
});
