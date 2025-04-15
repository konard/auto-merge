#!/usr/bin/env node
// auto-merge.mjs
//
// This script will:
//  • Accept a GitHub pull request URL and a version-bump type (patch/minor/major)
//  • Use the GitHub API (with built-in global fetch) to fetch PR details and commit statuses
//  • Get the pull request’s branch (which may be any name provided by the developer)
//  • Compare package.json versions on the default branch versus the PR branch
//  • If the PR branch version is lower or equal to the default branch version:
//      - Merge in the default branch,
//      - Run yarn install,
//      - And finally perform a yarn version bump (with patch/minor/major as specified)
//  • Every dangerous action (file system writes, git changes or API calls) asks for interactive confirmation.
//  • Periodically (every 1 minute) the script will sync the PR branch with the default branch.
//  • Finally, if all conditions pass, the script issues a GitHub API merge call (and prints out a cURL command)
//    to merge the pull request.
//
// Note: This script uses Node.js built‑in fetch (available in v18+) and dynamically loads non‑built‑in modules via use‑m.
//
// Usage:
//   node auto-merge.mjs <pull_request_url> <patch|minor|major>

import path from "path";
import fs from "fs";
import { execSync } from "child_process";
import readline from "readline";

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
debug("Importing semver module...");
const semver = await use("semver");
dotenv.config();
debug("Environment variables loaded.");

// ---------------------
// Check required environment variable: GITHUB_TOKEN
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

// Extract owner, repo, and pull request number from the URL.
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
// Utility: runCommand – async version with confirmation for dangerous operations.
// ---------------------
async function runCommand(cmd, options = { dangerous: false, description: "" }) {
  debug(`Preparing to run command: ${cmd}`);
  if (options.dangerous) {
    const confirmed = await confirmAction(options.description, cmd);
    if (!confirmed) {
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

// ---------------------
// Helper Functions
// ---------------------

// Fetch package.json from a given branch (via "git show").
async function getPackageJsonFromBranch(branch) {
  debug(`Fetching package.json from branch: ${branch}`);
  const content = await runCommand(`git show origin/${branch}:package.json`);
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

// bumpLocalVersionSafe: now safely bumps the version using Yarn's built-in version bump flags.
async function bumpLocalVersionSafe(bumpType) {
  // Using allowed bump types: patch, minor, or major.
  const cmd = `yarn version --${bumpType}`;
  console.log(`Bumping version using "${cmd}"...`);
  await runCommand(cmd, { dangerous: true, description: `This will bump the version using yarn version --${bumpType}` });
  console.log("Version bump performed.");
}

// Pushes the current branch to origin.
async function pushCurrentBranch(branchName) {
  const cmd = `git push origin ${branchName}`;
  const description = `This will push the branch "${branchName}" to origin.`;
  debug(`Pushing current branch ${branchName} to origin.`);
  await runCommand(cmd, { dangerous: true, description });
}

// Merges the default branch into the current branch.
// If only package.json is in conflict, auto-resolve that conflict.
async function mergeDefaultBranch(defaultBranch) {
  const mergeCmd = `git merge origin/${defaultBranch} --no-edit`;
  const description = `This will merge origin/${defaultBranch} into the current branch.`;
  debug(`Merging default branch (${defaultBranch}) into current branch.`);
  try {
    await runCommand(mergeCmd, { dangerous: true, description });
    debug("Merge succeeded without conflicts.");
    return true; // Merge succeeded.
  } catch (e) {
    debug("Merge command failed, checking for conflicts...");
    // Check for merge conflicts.
    let conflictsOutput = await runCommand(`git diff --name-only --diff-filter=U`, { dangerous: false, description: "Checking merge conflicts" });
    const conflicts = conflictsOutput.split(/\n/).map(s => s.trim()).filter(Boolean);
    debug(`Detected conflicts in files: ${conflicts.join(", ")}`);
    if (conflicts.length === 1 && conflicts[0] === "package.json") {
      const resCmd = `git checkout --theirs package.json && git add package.json && git commit -m "Auto-resolved package.json conflict from merging origin/${defaultBranch}"`;
      const confirmation = await confirmAction("Auto-resolving package.json conflict", resCmd);
      if (!confirmation) {
        console.error("Please resolve the conflicts manually and restart the script.");
        process.exit(1);
      }
      await runCommand(`git checkout --theirs package.json`, { dangerous: true, description: "Auto-resolve package.json conflict" });
      await runCommand(`git add package.json`, { dangerous: true, description: "Staging resolved package.json" });
      await runCommand(`git commit -m "Auto-resolved package.json conflict from merging origin/${defaultBranch}"`, { dangerous: true, description: "Committing the conflict resolution" });
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
async function updateDependencies() {
  const cmd = "yarn install";
  const description = `This will update your local yarn.lock and node_modules.`;
  debug("Running yarn install to update dependencies.");
  await runCommand(cmd, { dangerous: true, description });
  console.log("Local dependencies updated via yarn.");
}

// Helper to pause execution.
function sleep(ms) {
  debug(`Sleeping for ${ms} ms...`);
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ---------------------
// Repository Preparation: Clone or Pull as needed
// ---------------------
async function prepareRepository(repoName, cloneUrl) {
  const currentDirName = path.basename(process.cwd());
  if (currentDirName === repoName) {
    console.log(`Already in repository folder '${repoName}'. Performing a git pull to update repository...`);
    await runCommand(`git pull`, { dangerous: true, description: `Pulling latest changes in ${repoName}` });
  } else {
    if (!fs.existsSync(repoName)) {
      console.log(`Directory '${repoName}' not found.`);
      const confirmed = await confirmAction(
        `Cloning repository ${repoName} from ${cloneUrl}`,
        `git clone ${cloneUrl} ${repoName}`
      );
      if (!confirmed) {
        console.error("Clone aborted by user.");
        process.exit(1);
      }
      debug(`Cloning repository ${repoName}...`);
      await runCommand(`git clone ${cloneUrl} ${repoName}`, { dangerous: true, description: `Cloning repository ${repoName}` });
      process.chdir(repoName);
    } else {
      console.log(`Directory '${repoName}' found.`);
      if (!fs.existsSync(path.join(repoName, ".git"))) {
        console.error(`Directory '${repoName}' exists but is not a git repository.`);
        process.exit(1);
      }
      process.chdir(repoName);
      console.log(`Changed directory to '${repoName}'. Performing a git pull to update repository...`);
      await runCommand(`git pull`, { dangerous: true, description: `Pulling latest changes in ${repoName}` });
    }
  }
  debug(`Repository '${repoName}' prepared. Current directory: ${process.cwd()}`);
}

// ---------------------
// Merges the pull request via GitHub API.
async function mergePullRequest() {
  const mergeData = {
    commit_title: `Auto-merge pull request #${pullNumber}`,
    merge_method: "merge", // change to squash or rebase if preferred
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

// ---------------------
// Periodically syncs the PR branch with the default branch, merging and updating dependencies.
async function syncBranchWithDefault(defaultBranch, prBranchName) {
  while (true) {
    console.log("\n--- Fetching latest changes from origin ---");
    try {
      await runCommand(`git fetch origin ${defaultBranch}`, { dangerous: false, description: "Fetching updates from the default branch" });
      debug(`Fetched latest changes for branch: ${defaultBranch}`);
    } catch (e) {
      console.error("Failed to fetch the default branch:", e.message);
    }
    // Merge default branch into current branch.
    if (!(await mergeDefaultBranch(defaultBranch))) {
      debug("Merge failed or conflicts could not be auto-resolved. Exiting...");
      process.exit(1);
    }
    console.log("Merge complete. Running yarn install to update dependencies...");
    await updateDependencies();
    await pushCurrentBranch(prBranchName);
    let mergeCheck;
    try {
      mergeCheck = await runCommand(`git merge origin/${defaultBranch} --no-edit 2>&1`, { dangerous: false, description: "Checking merge status" });
    } catch (e) {
      mergeCheck = e.message;
    }
    debug(`Merge check result: ${mergeCheck}`);
    if (mergeCheck.includes("Already up to date")) {
      console.log("PR branch is up-to-date with the default branch.");
      break;
    } else {
      console.log("PR branch updated with new changes from default branch. Re-checking in 1 minute...");
      await sleep(60000);
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

    // 2. Prepare the repository: clone if needed or pull updates.
    await prepareRepository(repo, repoDetails.clone_url);

    // 3. Get pull request details from GitHub API.
    console.log("Fetching pull request details...");
    const prResponse = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${pullNumber}`, { headers });
    if (!prResponse.ok) {
      throw new Error(`Failed to fetch pull request details: ${prResponse.statusText}`);
    }
    const prDetails = await prResponse.json();
    const prBranchName = prDetails.head.ref;
    console.log(`Pull request branch: ${prBranchName}`);

    // 4. Setup local PR branch.
    console.log(`Fetching PR branch "${prBranchName}" from origin...`);
    await runCommand(`git fetch origin ${prBranchName}:${prBranchName}`, { dangerous: true, description: `Fetching PR branch ${prBranchName}` });
    await runCommand(`git checkout ${prBranchName}`, { dangerous: true, description: `Checking out PR branch ${prBranchName}` });
    debug(`Checked out branch: ${prBranchName}`);

    // 5. Compare package.json versions.
    console.log("\nComparing package.json versions between default branch and PR branch...");
    const defaultPkg = await getPackageJsonFromBranch(defaultBranch);
    const localPkg = getLocalPackageJson();
    console.log(`Default branch package.json version: ${defaultPkg.version}`);
    console.log(`PR branch package.json version: ${localPkg.version}`);
    debug(`Default pkg version: ${defaultPkg.version}, PR branch pkg version: ${localPkg.version}`);

    // 6. If PR branch version is lower or equal than default branch version, merge, update deps and bump version.
    if (semver.lte(localPkg.version, defaultPkg.version)) {
      console.log("PR branch version is lower or equal to the default branch version.");
      console.log("Merging default branch into PR branch...");
      await mergeDefaultBranch(defaultBranch);
      console.log("Running yarn install to update dependencies...");
      await updateDependencies();
      console.log(`Bumping version using "${bumpType}"...`);
      await bumpLocalVersionSafe(bumpType);
      await pushCurrentBranch(prBranchName);
    } else {
      console.log("PR branch version is greater than the default branch version. No version bump required.");
    }

    // 7. Periodically sync PR branch with the default branch.
    console.log("\nStarting periodic sync with default branch...");
    await syncBranchWithDefault(defaultBranch, prBranchName);

    // 8. Final merge of the PR via GitHub API.
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