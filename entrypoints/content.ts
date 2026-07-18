export default defineContentScript({
  matches: ['<all_urls>'],
  main() {
    // Storage/DOM sensor glue and the border overlay are added in
    // Phase 3-4. This entrypoint intentionally stays inert in Phase 1.
  },
});
