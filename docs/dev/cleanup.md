# Cleanup: Replace Legacy Test Configuration Fixtures

**Status:** Proposed
**Confidence:** 0.97

## Goal

Restore a fully green test suite after the intentional removal of `orc.config.yaml` and home-directory configuration overrides. Tests must construct configuration explicitly in memory; no test may create, read, or depend on an override file.

This cleanup does not change production configuration behavior. Production continues to load only the committed `config/providers/*.yaml`, `config/runners.yaml`, and `config/registry.yaml` files.

## Design

Create one reusable test-only configuration builder in `tests/helpers/` with a precise, durable responsibility: build valid `Config` objects for deterministic harness tests.

Suggested interface:

```ts
createTestConfig({
  providers?: { fake?: string[]; codex?: string[]; /* ... */ },
  profiles?: Record<string, { provider: string }>,
  defaultProfile?: string,
  timeouts?: ModelRegistry['timeouts'],
  manifest?: Manifest
}): Config
```

The builder must start from a clone of `DEFAULT_REGISTRY`, then add requested test providers (including `fake`) as `{ models, defaultModel }` catalogues. It must return a valid profile map and a manifest with profile-based skills. It must not write files, mutate `DEFAULT_REGISTRY`, or call `loadConfig`.

Use a small companion helper only if needed to clone/alter registry values for adapter timeout tests. Do not introduce a broad `helpers.ts` or a generic fixture bucket.

## Required Test Migration

### 1. Add the in-memory test configuration builder

**Files:** `tests/helpers/` (new purpose-named module), optionally `tests/helpers/fs.ts` only to remove no-longer-needed file setup.

**Instructions:**

- Export a `createTestConfig` function and narrow input types for provider catalogues, profiles, timeouts, and manifest replacement.
- Represent every provider using the runtime shape:

  ```ts
  fake: { models: ['fake-model'], defaultModel: 'fake-model' }
  ```

- Add `fake` only when a caller requests it. The production `DEFAULT_REGISTRY` must remain fake-free.
- Default test profiles should be opaque names such as `test-audit`, `test-follow-up`, and `test-implement`; do not make test behavior depend on production profile names.
- Provide a default test manifest whose skills use `runnerProfile`, never `agent`/`model`.
- Use `structuredClone` (or equivalent) to ensure a test cannot mutate shared configuration.

**Verification:**

- A helper test proves the default result has no `fake` provider.
- A helper test proves requested `fake` is present only in the returned config and not in `DEFAULT_REGISTRY`.
- A helper test proves a timeout override and custom profile/provider are preserved.

### 2. Migrate direct loop and e2e tests

**Files:**

- `tests/loop-implement.test.ts`
- `tests/loop-live.test.ts`
- `tests/loop-continuity.test.ts`
- `tests/loop-followup-runner.test.ts`
- `tests/e2e/smash.test.ts` where it needs fake configuration
- `tests/agy-contract.test.ts` where it currently writes an override fixture

**Instructions:**

- Delete each `writeFileSync(..., 'orc.config.yaml', ...)` setup block.
- Replace `loadConfig(tempRoot)` calls that existed only to obtain fake/codex test catalogues with `createTestConfig(...)`.
- Keep `loadConfig` only where the test is explicitly verifying production packaged configuration or manifest loading.
- Pass the returned config directly to `runLoop` and adapter registry constructors.
- Preserve existing resolved runner values at execution boundaries. Tests that require a fake runner must request fake in their test config and pass a matching profile/CLI override, rather than relying on an ignored project file.
- For mixed-provider continuity cases, request both fake and the real/provider-under-test catalogue explicitly, with profiles that select each required provider.

**Verification:**

- Every migrated suite passes without an `orc.config.yaml` in its temporary directory.
- Continuity, follow-up inheritance, implementation, and dual-target isolation assertions remain unchanged in intent.
- No production test configuration exposes fake unless its test explicitly requests fake.

### 3. Migrate command-level configuration seams

**Files:**

- `tests/smash-action.test.ts`
- `tests/commands/smash-timeout.test.ts`

**Instructions:**

- Replace override-file setup with `vi.spyOn(configModule, 'loadConfig').mockReturnValue(createTestConfig(...))` in each test or suite setup.
- Restore mocks in `afterEach`; do not let a test config leak into another test.
- For tests exercising `smashAction`, build the exact profiles/providers needed by the command and the injected adapter registry. This is required because `smashAction` resolves CLI overrides against its loaded registry before invoking `runLoop`.
- For timeout tests, create an in-memory registry with the requested `timeouts` value and assert the registry passed into `createProductionAdapterRegistry` contains it.
- Keep the assertion that the default factory receives the loaded registry, but remove any assertion that a project-local config file influenced it.

**Verification:**

- Command tests cover fake runner resolution through an explicit test config.
- Timeout tests cover `opencode`, `codex`, `claude`, and `agy` using config objects with explicit timeout values.
- A regression asserts that creating `orc.config.yaml` in a target has no effect on `loadModelRegistry` or `smashAction` configuration.

### 4. Migrate adapter timeout integration tests

**Files:** `tests/adapters/registry-timeout-integration.test.ts`, plus any timeout-only setup in `tests/commands/smash-timeout.test.ts`.

**Instructions:**

- Build `Config`/`ModelRegistry` input in memory, including only the timeout being tested.
- Call `createProductionAdapterRegistry(config.registry, overrides)` directly for adapter-level integration coverage.
- Retain the existing environment-variable assertion for OpenCode: environment timeout overrides the registry-configured timeout at execution, while the adapter factory still receives the configured default timeout.
- Do not use `os.homedir` mocks; home-directory discovery no longer exists.

**Verification:**

- Configured timeout reaches each adapter seam.
- OpenCode built-in fallback and `OPENCODE_RUN_TIMEOUT_MS` precedence remain covered.
- Claude, Codex, and Agy remain config-only and do not gain environment-variable fallback tests.

### 5. Remove legacy assumptions and add a repository guard

**Files:** all tests listed above; `tests/config.test.ts` or a dedicated focused regression test.

**Instructions:**

- Remove imports made solely for legacy override fixtures: `os`, `writeFileSync`, or path helpers where they are otherwise unused.
- Update comments/messages that describe project-local or home configuration as supported behavior.
- Add a focused regression that creates a temporary `orc.config.yaml` with a different provider/default and verifies `loadModelRegistry(tempDir)` still equals the packaged registry.
- Add a source-level repository guard if it is maintainable: test fixture setup must not reference `orc.config.yaml`. Prefer a narrow test that scans `tests/` for this literal, excluding this cleanup document and any intentional negative regression fixture.

**Verification:**

- `rg -n "orc\\.config\\.yaml" tests` returns only the intentional negative-regression fixture/comment, if any.
- `rg -n "homedir" tests` returns no configuration-discovery mocks.
- No test depends on provider-list ordering; use `defaultModel` explicitly.

## Execution Order

1. Add and test `createTestConfig`.
2. Migrate adapter timeout tests; they are isolated and establish the builder’s timeout contract.
3. Migrate direct loop suites, then e2e/contract suites.
4. Migrate `smashAction` and command timeout suites using a `loadConfig` mock seam.
5. Remove stale imports/comments and add the override-ignored regression.
6. Run the full validation sequence and fix only migration regressions; do not restore override parsing to make a legacy test pass.

## Full Verification

- `npm run typecheck`
- `npm test`
- Existing env-gated OpenCode, Codex, and Claude contract commands when their environment is configured.
- Agy deterministic tests, plus the normal authenticated-shell manual check if available.

The completion gate is a green full deterministic suite with no test configuration file override path, while production catalogues remain the only runtime provider/model source.

## Non-Goals

- Do not restore `orc.config.yaml`, home-directory config, legacy schemas, or merge behavior.
- Do not add `fake` to committed production catalogues or the production adapter registry.
- Do not change provider model IDs, adapter arguments, session continuity, loop semantics, prompts, or artifact naming as part of this cleanup.
- Do not use test-only hooks in production runner resolution; test configuration must enter through explicit test inputs or a mocked `loadConfig` boundary.
