// Barrel export of the backend-agnostic public API. Backend-specific modules
// (backends/opencode.js, backends/grok.js) are intentionally NOT re-exported
// here -- import them by subpath so a consumer only pulls in the CLI it uses.
export * from "./text.js";
export * from "./cwd.js";
export * from "./queue.js";
export * from "./errors.js";
export * from "./types.js";
