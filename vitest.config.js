import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.js'],
    },
    // Integration tests require a running Postgres — run separately
    // Unit tests: test/unit/**
    // Integration tests: test/integration/**
  },
});
