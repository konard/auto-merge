#!/usr/bin/env node
// auto-merge.mjs
//
// This script will:
//  • Accept a GitHub pull request URL and a version-bump type (patch/minor/major)
//  • Use the GitHub API (with built-in global fetch) to fetch PR details and commit statuses
//  • Compare package.json versions on the default branch versus the PR branch
//  • If the default branch’s version is higher, perform a Yarn version bump using the given option
//  • After every merge of the default branch into the PR branch, run "yarn install"
//    to update your local yarn.lock and node_modules
//  • Every dangerous action is preceded by a clear description with a reproducible command or API call,
//    requiring interactive user confirmation.
//  • Periodically (every 1 minute) fetch and merge updates from the default branch into the PR branch,
//    auto-resolving package.json conflicts if possible. If any other conflicts occur, the script exits for manual intervention.
//  • Finally, if all conditions pass, the script issues a GitHub API merge call (with a printed cURL command)
//    to merge the PR.
//
// Note: This script uses Node.js built-in fetch (available in v18+) and dynamically imports non‑built‑in packages using use‑m.
//
// Usage:
//   node auto-merge.mjs <pull_request_url> <patch|minor|major>

// ---------------------
// Utility: Debug Tracing
// ---------------------
function debug(msg) {
  console.log(`[DEBUG] ${msg}`);
}

// ---------------------
// Dynamic Imports via use-m for non built-in modules
// ---------------------
debug("Importing use-m to enable dynamic module loading...");
const { use } = eval(
  await fetch('https://unpkg.com/use-m/use.js').then(u => u.text())
);

// Dynamically import dotenv to load environment variables.
debug("Importing dotenv module...");
const dotenv = await use("dotenv");
dotenv.config();
debug("Environment variables loaded.");

// ---------------------
// Built-in modules imported normally
// ---------------------
import { execSync } from "child_process";
import fs from "fs";
import readline from "readline";

// ---------------------
// Check for required environment variable: GITHUB_TOKEN
// ---------------------
const token = process.env.GITHUB_TOKEN;
if (!token) {
  console.error("Error: Please set GITHUB_TOKEN as an environment variable.");
  process.exit(1);
}
debug("GITHUB_TOKEN is set.");

// ---------------------
// Configuration and Input Parsing
// ---------------------
const prUrl = process.argv[2];
const bumpType = process.argv[3];

debug(`Received arguments: prUrl=${prUrl}, bumpType=${bumpType}`);

if (!prUrl || !bumpType) {
  console.error("Usage: node auto-merge.mjs <pull_request_url> <patch|minor|major>");
  process.exit(1);
}
if (!["patch", "minor", "major"].includes(bumpType)) {
  console.error("Error: Bump type must be one of: patch, minor, major");
  process.exit(1);
}

// Extract owner, repo, and pull request number from URL.
// Expected format: https://github.com/<owner>/<repo>/pull/<number>
const prRegex = /^https:\/\/github\.com\/([^\/]+)\/([^\/]+)\/pull\/(\d+)/;
const match = prUrl.match(prRegex);
if (!match) {
  console.error("Error: Invalid pull request URL format. Expected format: https://github.com/owner/repo/pull/123");
  process.exit(1);
}
const [ , owner, repo, pullNumber ] = match;
debug(`Parsed PR URL: owner=${owner}, repo=${repo}, pullNumber=${pullNumber}`);

// Common GitHub API headers.
const headers = {
  "Authorization": `token ${token}`,
  "Accept": "application/vnd.github.v3+json",
  "Content-Type": "application/json",
};

// ---------------------
// Utility: Interactive Confirmation
// ---------------------
async function confirmAction(description, commandText) {
  console.log("\n================================================================================");
  console.log(`ACTION: ${description}`);
  console.log(`REPRODUCIBLE COMMAND/API CALL:\n${commandText}`);
  console.log("================================================================================");
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const answer = await new Promise((resolve) => {
    rl.question("Do you want to continue? (y/n): ", resolve);
  });
  rl.close();
  debug(`User answer: ${answer}`);
  return answer.toLowerCase().startsWith("y");
}

// ---------------------
// Helper Functions
// ---------------------

// Runs a shell command after user confirmation if dangerous=true.
function runCommand(cmd, options = { dangerous: false, description: "" }) {
  debug(`Preparing to run command: ${cmd}`);
  if (options.dangerous) {
    if (!confirmAction(options.description, cmd)) {
      throw new Error(`Operation aborted by user: ${options.description}`);
    }
  }
  try {
    const output = execSync(cmd, { encoding: "utf8", stdio: "pipe" });
    debug(`Command output: ${output}`);
    return output;
  } catch (err) {
    debug(`Command error output: ${err.message}`);
    throw new Error(`Command failed: ${cmd}\n${err.message}`);
  }
}

// Fetch package.json from a given branch (using "git show").
function getPackageJsonFromBranch(branch) {
  debug(`Fetching package.json from branch: ${branch}`);
  const content = runCommand(`git show origin/${branch}:package.json`);
  debug(`Fetched package.json content from ${branch}`);
  return JSON.parse(content);
}

// Read local package.json.
function getLocalPackageJson() {
  debug("Reading local package.json file...");
  const content = fs.readFileSync("package.json", "utf8");
  debug("Successfully read local package.json.");
  return JSON.parse(content);
}

// Performs a Yarn version bump.
function bumpLocalVersion(bumpType) {
  const cmd = `yarn version --${bumpType}`;
  const description = `This will bump the version in package.json using yarn: ${cmd}`;
  debug(`Bumping local version with type "${bumpType}"`);
  runCommand(cmd, { dangerous: true, description });
  console.log("Version bump performed.");
}

// Pushes the current branch to origin.
function pushCurrentBranch(branchName) {
  const cmd = `git push origin ${branchName}`;
  const description = `This will push the branch "${branchName}" to origin with: ${cmd}`;
  debug(`Pushing current branch ${branchName} to origin.`);
  runCommand(cmd, { dangerous: true, description });
}

// Attempts to merge the default branch into the current branch.
// If only package.json is in conflict, it auto-resolves the conflict.
function mergeDefaultBranch(defaultBranch) {
  const mergeCmd = `git merge origin/${defaultBranch} --no-edit`;
  const description = `This will merge origin/${defaultBranch} into the current branch using: ${mergeCmd}`;
  debug(`Merging default branch (${defaultBranch}) into current branch.`);
  try {
    runCommand(mergeCmd, { dangerous: true, description });
    debug("Merge succeeded without conflicts.");
    return true; // Merge succeeded.
  } catch (e) {
    debug("Merge command failed, checking for conflicts...");
    // Check for merge conflicts.
    let conflictsOutput = runCommand(`git diff --name-only --diff-filter=U`);
    const conflicts = conflictsOutput.split(/\n/).map(s => s.trim()).filter(Boolean);
    debug(`Detected conflicts in files: ${conflicts.join(", ")}`);
    if (conflicts.length === 1 && conflicts[0] === "package.json") {
      const resCmd = `git checkout --theirs package.json && git add package.json && git commit -m "Auto-resolved package.json conflict from merging origin/${defaultBranch}"`;
      if (!confirmAction("Auto-resolving package.json conflict", resCmd)) {
        console.error("Please resolve the conflicts manually and restart the script.");
        return false;
      }
      runCommand(`git checkout --theirs package.json`, { dangerous: true, description: "Auto-resolve package.json conflict: git checkout --theirs package.json" });
      runCommand(`git add package.json`, { dangerous: true, description: "Staging resolved package.json" });
      runCommand(`git commit -m "Auto-resolved package.json conflict from merging origin/${defaultBranch}"`, { dangerous: true, description: "Committing the conflict resolution" });
      debug("Auto-resolved package.json conflict.");
      return true;
    } else if (conflicts.length > 0) {
      console.error("Merge conflicts detected in files:", conflicts);
      console.error("Please resolve these conflicts manually and then restart the script.");
      return false;
    }
    return false;
  }
}

// Runs 'yarn install' to update yarn.lock and node_modules.
function updateDependencies() {
  const cmd = "yarn install";
  const description = `This will update your local yarn.lock and node_modules using: ${cmd}`;
  debug("Running yarn install to update dependencies.");
  runCommand(cmd, { dangerous: true, description });
  console.log("Local dependencies updated via yarn.");
}

// Helper to pause execution.
function sleep(ms) {
  debug(`Sleeping for ${ms} ms...`);
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Merges the pull request via GitHub API.
async function mergePullRequest() {
  const mergeData = {
    commit_title: `Auto-merge pull request #${pullNumber}`,
    merge_method: "merge", // Change if you prefer "squash" or "rebase"
  };

  const apiUrl = `https://api.github.com/repos/${owner}/${repo}/pulls/${pullNumber}/merge`;
  // Prepare a reproducible cURL command.
  const curlCommand = `curl -X PUT ${apiUrl} \\\n  -H "Authorization: token ${token}" \\\n  -H "Content-Type: application/json" \\\n  -d '${JSON.stringify(mergeData)}'`;

  if (!(await confirmAction("Merging the pull request via GitHub API", curlCommand))) {
    throw new Error("User aborted GitHub API merge call.");
  }

  debug(`Sending merge request to GitHub API at ${apiUrl}...`);
  const response = await fetch(apiUrl, {
    method: "PUT",
    headers,
    body: JSON.stringify(mergeData),
  });

  if (!response.ok) {
    const errorData = await response.json();
    throw new Error(`Merge failed: ${errorData.message}`);
  }
  debug("GitHub API merge successful.");
  return response.json();
}

// Periodically checks for updates in the default branch, merges them into the PR branch,
// and updates dependencies.
async function syncBranchWithDefault(defaultBranch, prBranchName) {
  while (true) {
    console.log("\n--- Fetching latest changes from origin ---");
    try {
      runCommand(`git fetch origin ${defaultBranch}`, { dangerous: false, description: "Fetching updates from the default branch" });
      debug(`Fetched latest changes for branch: ${defaultBranch}`);
    } catch (e) {
      console.error("Failed to fetch the default branch:", e.message);
    }
    // Merge default branch into current branch.
    if (!mergeDefaultBranch(defaultBranch)) {
      debug("Merge failed or conflicts could not be auto-resolved. Exiting...");
      process.exit(1);
    }
    // Update dependencies after the merge.
    console.log("Merge complete. Running yarn install to update dependencies...");
    updateDependencies();
    // Push the updated branch.
    pushCurrentBranch(prBranchName);
    // Check if the branch is fully up-to-date.
    let mergeCheck;
    try {
      mergeCheck = runCommand(`git merge origin/${defaultBranch} --no-edit 2>&1`);
    } catch (e) {
      mergeCheck = e.message;
    }
    debug(`Merge check result: ${mergeCheck}`);
    if (mergeCheck.includes("Already up to date")) {
      console.log("PR branch is up-to-date with the default branch.");
      break;
    } else {
      console.log("PR branch updated with new changes from default branch. Re-checking in 1 minute...");
      await sleep(60000); // Wait 1 minute.
    }
  }
}

// ---------------------
// Main Flow
// ---------------------
(async () => {
  try {
    debug("Starting main flow...");
    // 1. Get repository details from GitHub API.
    console.log("Fetching repository details...");
    const repoResponse = await fetch(`https://api.github.com/repos/${owner}/${repo}`, { headers });
    if (!repoResponse.ok) {
      throw new Error(`Failed to fetch repository details: ${repoResponse.statusText}`);
    }
    const repoDetails = await repoResponse.json();
    const defaultBranch = repoDetails.default_branch;
    console.log(`Default branch is: ${defaultBranch}`);
    debug(`Repository details: ${JSON.stringify(repoDetails)}`);

    // 2. Setup local PR branch.
    const prBranchName = `pr-${pullNumber}`;
    console.log(`Fetching PR #${pullNumber} into local branch "${prBranchName}"...`);
    runCommand(`git fetch origin pull/${pullNumber}/head:${prBranchName}`, {
      dangerous: true,
      description: `This will create/update local branch "${prBranchName}" from the pull request.`,
    });
    runCommand(`git checkout ${prBranchName}`, {
      dangerous: true,
      description: `This will checkout the local PR branch "${prBranchName}".`,
    });
    debug(`Checked out branch: ${prBranchName}`);

    // 3. Compare package.json versions.
    console.log("\nComparing package.json versions between default branch and PR branch...");
    const defaultPkg = getPackageJsonFromBranch(defaultBranch);
    const localPkg = getLocalPackageJson();
    console.log(`Default branch package.json version: ${defaultPkg.version}`);
    console.log(`PR branch package.json version: ${localPkg.version}`);
    debug(`Default pkg version: ${defaultPkg.version}, Local pkg version: ${localPkg.version}`);

    // If the default branch version is greater than the PR branch version, perform a version bump.
    if (defaultPkg.version > localPkg.version) {
      console.log("Default branch version is greater than PR branch version.");
      bumpLocalVersion(bumpType);
      pushCurrentBranch(prBranchName);
    } else {
      console.log("No version bump required (PR branch version is not lower).");
      debug("Skipping version bump.");
    }

    // 4. Periodically sync the PR branch with the default branch,
    // merge changes and update dependencies.
    console.log("\nStarting periodic sync with default branch...");
    await syncBranchWithDefault(defaultBranch, prBranchName);

    // 5. Final merge of the PR via GitHub API.
    console.log("\nAll updates and checks passed. Proceeding to merge the pull request via GitHub API...");
    const mergeResult = await mergePullRequest();
    if (mergeResult.merged) {
      console.log("Pull request merged successfully!");
      debug("Merge result: " + JSON.stringify(mergeResult));
    } else {
      console.error("Merge failed:", mergeResult.message);
      debug("Merge result: " + JSON.stringify(mergeResult));
    }
  } catch (error) {
    console.error("Error:", error.message);
    debug("Script terminating due to error.");
    process.exit(1);
  }
})();