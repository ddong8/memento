import { defineConfig } from "vitest/config";

// Route tests rebuild one shared test database: one file at a time
export default defineConfig({ test: { fileParallelism: false } });
