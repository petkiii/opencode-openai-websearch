#!/usr/bin/env bun
import { $ } from "bun";
import {
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BRANCH = "local/patch";
const SUFFIX = "patched";
const BUILD_LOG = "build-patched.log";

type Options = {
  build: boolean;
};

function options(): Options {
  const result = { build: false };

  for (const argument of process.argv.slice(2)) {
    if (argument === "--build") {
      result.build = true;
      continue;
    }
    if (argument === "--help") {
      console.log(
        [
          "Usage: bun patcher.ts [--build]",
          "",
          "No flags: clone/update, install dependencies, and patch opencode.",
          "--build: build and verify patched opencode after default steps.",
        ].join("\n"),
      );
      process.exit(0);
    }
    fail(`Unknown option: ${argument}`);
  }

  return result;
}

function log(message: string) {
  console.log(`\n==> ${message}`);
}

function info(message: string) {
  console.log(`    ${message}`);
}

function fail(message: string): never {
  console.error(`\nERROR: ${message}`);
  process.exit(1);
}

async function run(label: string, command: () => Promise<unknown>) {
  log(label);
  try {
    return await command();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    fail(`${label} failed\n\n${message}`);
  }
}

async function text(label: string, command: () => Promise<string>) {
  return String(await run(label, command)).trim();
}

function read(pathname: string) {
  if (!existsSync(pathname)) fail(`Missing required file: ${pathname}`);
  return readFileSync(pathname, "utf8");
}

function isDirectory(pathname: string) {
  return existsSync(pathname) && statSync(pathname).isDirectory();
}

function writeJson(pathname: string, mutate: (value: any) => void) {
  const value = JSON.parse(read(pathname));
  const oldVersion = value.version;
  mutate(value);
  writeFileSync(pathname, JSON.stringify(value, null, 2) + "\n");
  return { oldVersion, newVersion: value.version };
}

async function branchExists(branch: string) {
  const result =
    await $`git rev-parse --verify --quiet ${`refs/heads/${branch}`}`
      .quiet()
      .nothrow();
  return result.exitCode === 0;
}

async function currentBranch() {
  return (await $`git branch --show-current`.text()).trim();
}

async function workingTreeDirty() {
  return (await $`git status --porcelain`.text()).trim().length > 0;
}

function latestVersionTag(tagsText: string) {
  const tags = tagsText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((tag) => /^v\d+\.\d+\.\d+(?:[-+].*)?$/.test(tag))
    .filter((tag) => !tag.endsWith(`-${SUFFIX}`));

  return tags[0];
}

function findBinaries(root: string) {
  const result: string[] = [];

  function walk(dir: string) {
    if (!existsSync(dir)) return;

    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      const stat = statSync(full);

      if (stat.isDirectory()) {
        walk(full);
        continue;
      }

      if (name === "opencode" || name === "opencode.exe") {
        result.push(full);
      }
    }
  }

  walk(root);
  return result;
}

function findPatchFiles(root: string) {
  if (!existsSync(root)) fail(`Missing patches directory: ${root}`);
  if (!isDirectory(root)) fail(`Expected patches directory: ${root}`);

  const result: string[] = [];

  function walk(dir: string) {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      const stat = statSync(full);

      if (stat.isDirectory()) {
        walk(full);
        continue;
      }

      if (/\.(?:patch|diff)$/.test(name)) {
        result.push(full);
      }
    }
  }

  walk(root);
  return result.sort((left, right) => left.localeCompare(right));
}

async function main() {
  const config = options();
  const patcherRoot = path.dirname(fileURLToPath(import.meta.url));
  const repositoryRoot = path.resolve(patcherRoot, "..");
  const opencodeRoot = path.join(repositoryRoot, "opencode");
  const patchesRoot = path.join(patcherRoot, "patches");

  await run("Ensure opencode repository", async () => {
    if (!existsSync(opencodeRoot)) {
      await $`git clone https://github.com/anomalyco/opencode ${opencodeRoot}`;
      return;
    }

    if (!isDirectory(opencodeRoot)) {
      fail(`Expected opencode checkout to be a directory: ${opencodeRoot}`);
    }

    if (!existsSync(path.join(opencodeRoot, ".git"))) {
      fail(`Existing path is not a git checkout: ${opencodeRoot}`);
    }
  });

  process.chdir(opencodeRoot);
  $.cwd(opencodeRoot);

  log("Repository");
  info(opencodeRoot);

  await run("Fetch origin tags", async () => {
    await $`git fetch origin --tags --prune`;
  });

  const tagsText = await text("Read version tags", async () => {
    return await $`git tag --list "v[0-9]*" --sort=-v:refname`.text();
  });

  const latestTag = latestVersionTag(tagsText);
  if (!latestTag) {
    fail(
      [
        "Could not find a non-patched semver tag like v1.14.24.",
        "Run this to inspect local tags:",
        "  git tag --list 'v[0-9]*' --sort=-v:refname | head -50",
      ].join("\n"),
    );
  }

  const patchedTag = `${latestTag}-${SUFFIX}`;
  const patchedVersion = `${latestTag.replace(/^v/, "")}-${SUFFIX}`;

  log("Version plan");
  info(`latest tag:      ${latestTag}`);
  info(`patched tag:     ${patchedTag}`);
  info(`patched version: ${patchedVersion}`);

  await run(`Checkout/create ${BRANCH}`, async () => {
    if (await branchExists(BRANCH)) {
      await $`git checkout ${BRANCH}`;
    } else {
      await $`git checkout -b ${BRANCH} ${latestTag}`;
    }
  });

  const checkedOut = await currentBranch();
  if (checkedOut !== BRANCH) {
    fail(
      `Expected to be on ${BRANCH}, but current branch is ${checkedOut || "(detached)"}`,
    );
  }

  await run(`Reset ${BRANCH} to ${latestTag}`, async () => {
    await $`git reset --hard ${latestTag}`;
  });

  await run("Remove generated local artifacts", async () => {
    rmSync(BUILD_LOG, { force: true });
  });

  if (await workingTreeDirty()) {
    const status = await $`git status --short`.text();
    fail(
      [
        "Working tree is dirty immediately after reset. This should not happen.",
        "Status:",
        status,
      ].join("\n"),
    );
  }

  await run("Apply local patches", async () => {
    const patches = findPatchFiles(patchesRoot);
    if (patches.length === 0) {
      fail(`No .patch or .diff files found under ${patchesRoot}`);
    }

    try {
      for (const patchFile of patches) {
        info(path.relative(patcherRoot, patchFile));
        await $`git apply --3way ${patchFile}`;
      }
    } catch (error) {
      await $`git reset --hard ${latestTag}`;
      throw error;
    }
  });

  await run("Stamp package versions", async () => {
    const targets = [
      "packages/opencode/package.json",
      "packages/plugin/package.json",
    ];

    for (const target of targets) {
      const { oldVersion, newVersion } = writeJson(target, (value) => {
        value.version = patchedVersion;
      });
      info(`${target}: ${oldVersion} -> ${newVersion}`);
    }
  });

  await run("Commit patch branch", async () => {
    await $`git add -A`;

    const staged = (await $`git diff --cached --name-only`.text()).trim();
    if (!staged) {
      info("No staged changes. Nothing to commit.");
      return;
    }

    await $`git -c user.name=opencode-openai-websearch -c user.email=opencode-openai-websearch@localhost commit -m ${`chore: apply local patches (${patchedTag})`}`;
  });

  await run(`Create/update git tag ${patchedTag}`, async () => {
    await $`git tag -f ${patchedTag}`;
  });

  await run("Install dependencies without mutating bun.lock", async () => {
    await $`bun install --frozen-lockfile`;
  });

  if (!config.build) {
    log("Done");
    info(`branch:  ${await currentBranch()}`);
    info(`commit:  ${(await $`git rev-parse --short HEAD`.text()).trim()}`);
    info(`tag:     ${patchedTag}`);
    info(`version: ${patchedVersion}`);
    return;
  }

  await run("Build standalone binary", async () => {
    const env = {
      ...process.env,
      VERSION: patchedVersion,
      OPENCODE_VERSION: patchedVersion,
      OPENCODE_RELEASE_VERSION: patchedVersion,
      GITHUB_REF_NAME: patchedTag,
    };

    const command =
      $`bun run ./packages/opencode/script/build.ts --single 2>&1 | tee ${BUILD_LOG}`.env(
        env,
      );
    await command;
  });

  const binaries = findBinaries("packages/opencode/dist");

  log("Built binaries");
  if (binaries.length === 0) {
    fail(
      [
        "No opencode binary was found under packages/opencode/dist.",
        `Check ${BUILD_LOG}.`,
      ].join("\n"),
    );
  }

  for (const binary of binaries) {
    info(binary);
  }

  const primary = binaries[0];
  if (!primary) fail("No primary opencode binary found.");

  const versionOutput = await text("Verify binary version", async () => {
    return await $`${primary} --version`.text();
  });

  if (!versionOutput.includes(patchedVersion)) {
    fail(
      [
        `Binary version does not contain expected version.`,
        `Expected: ${patchedVersion}`,
        `Actual:   ${versionOutput}`,
        "",
        `Build log: ${BUILD_LOG}`,
        "",
        "The binary was built, but OpenCode's build script ignored the version env vars.",
        "Search the build script for the version source:",
        '  grep -R "0.0.0\\|VERSION\\|GITHUB_REF_NAME\\|git rev-parse" -n packages/opencode/script packages/opencode/src',
      ].join("\n"),
    );
  }

  log("Done");
  info(`branch:  ${await currentBranch()}`);
  info(`commit:  ${(await $`git rev-parse --short HEAD`.text()).trim()}`);
  info(`tag:     ${patchedTag}`);
  info(`version: ${patchedVersion}`);
  info(`binary:  ${primary}`);
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
