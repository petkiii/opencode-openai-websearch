# Fix Broken Patches

Goal: fix broken files under `patcher/patches/` after upstream opencode changes. Persist only patch file changes unless user explicitly allows more; use a clean opencode worktree as scratch to generate patches.

Workflow:

1. Inspect patch files in `patcher/patches/`.
2. Inspect current opencode checkout in `../opencode` for touched target files.
3. Run patch checks from `../opencode`:

   ```sh
   git apply --check --3way ../patcher/patches/*.patch
   ```

4. If checks fail, edit the actual opencode source in a clean worktree, then regenerate patch files from `git diff`. Preserve existing behavior. Do not add features.
5. Final response: list modified patch files, what upstream shape changed, verification run.

Rules:

- Persist only `patcher/patches/*.patch` changes unless user asks otherwise.
- Do not manually rework patch hunks; edit source first, then regenerate patch files from `git diff`.
- Keep changes minimal.
- Preserve old patch behavior exactly.
- Do not add hooks, types, or behavior not already present in existing patches.
- Do not revert user changes.
- Use `apply_patch` for manual edits.
