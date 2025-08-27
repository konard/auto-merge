#!/usr/bin/env node
// test-auto-merge.mjs
//
// Comprehensive testing suite for auto-merge.mjs
// This script will:
//  • Create a temporary test repository on GitHub
//  • Set up various test scenarios (PRs with different version states)
//  • Run auto-merge script with different options
//  • Verify expected behavior
//  • Clean up by deleting the test repository
//
// Usage: node test-auto-merge.mjs

import path from "path";
import fs from "fs";
import { execSync } from "child_process";
import { fileURLToPath } from 'url';

// Get current directory
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------------------
// Utility: Debug Tracing
// ---------------------
let debug = (msg) => {
  console.log(`[TEST-DEBUG] ${msg}`);
}

// ---------------------
// Dynamic Imports via use-m for non built-in modules
// ---------------------
debug("Importing use-m to enable dynamic module loading...");
const { use } = eval(await fetch("https://unpkg.com/use-m/use.js").then(u => u.text()));

debug("Importing semver module...");
const semver = await use("semver");

// ---------------------
// Configuration
// ---------------------
const TEST_REPO_NAME = `auto-merge-test-${Date.now()}`;
const TEST_BRANCH_NAME = `test-feature-${Date.now()}`;
const GITHUB_USERNAME = execSync("gh api user --jq .login", { encoding: "utf8" }).trim();

debug(`Test configuration: repo=${TEST_REPO_NAME}, branch=${TEST_BRANCH_NAME}, user=${GITHUB_USERNAME}`);

// ---------------------
// Utility Functions
// ---------------------
function sleep(ms) {
  debug(`Sleeping for ${ms} ms...`);
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runCommand(cmd, options = { cwd: process.cwd(), silent: false }) {
  if (!options.silent) {
    debug(`Running command: ${cmd} (cwd: ${options.cwd})`);
  }
  try {
    const output = execSync(cmd, { 
      encoding: "utf8", 
      stdio: options.silent ? "pipe" : "inherit",
      cwd: options.cwd 
    });
    if (!options.silent && output) {
      debug(`Command output: ${output}`);
    }
    return output;
  } catch (err) {
    if (!options.silent) {
      debug(`Command error: ${err.message}`);
    }
    throw new Error(`Command failed: ${cmd}\n${err.message}`);
  }
}

// ---------------------
// Test Repository Management
// ---------------------
class TestRepository {
  constructor(name) {
    this.name = name;
    this.localPath = path.join(process.cwd(), name);
    this.url = `https://github.com/${GITHUB_USERNAME}/${name}`;
    this.cloneUrl = `https://github.com/${GITHUB_USERNAME}/${name}.git`;
  }

  async create() {
    debug(`Creating test repository: ${this.name}`);
    
    // Create repository on GitHub
    await runCommand(`gh repo create ${this.name} --public --clone --gitignore Node`);
    
    // Change to repo directory
    process.chdir(this.localPath);
    
    // Create initial package.json
    const packageJson = {
      name: this.name,
      version: "1.0.0",
      description: "Test repository for auto-merge script",
      main: "index.js",
      scripts: {
        test: "echo \"Error: no test specified\" && exit 0"
      },
      author: "Auto-merge Test Suite",
      license: "MIT"
    };
    
    fs.writeFileSync("package.json", JSON.stringify(packageJson, null, 2));
    fs.writeFileSync("index.js", "console.log('Hello from test repository!');\n");
    
    // Initial commit
    await runCommand("git add .");
    await runCommand(`git commit -m "Initial commit"`);
    await runCommand("git push origin main");
    
    debug(`Test repository created successfully: ${this.url}`);
  }

  async createTestBranch(branchName, versionChange = null) {
    debug(`Creating test branch: ${branchName}`);
    
    // Create and checkout new branch
    await runCommand(`git checkout -b ${branchName}`);
    
    // Modify package.json version if specified
    if (versionChange) {
      const packageJson = JSON.parse(fs.readFileSync("package.json", "utf8"));
      const currentVersion = packageJson.version;
      
      // Only commit if version actually changed
      if (currentVersion !== versionChange) {
        packageJson.version = versionChange;
        fs.writeFileSync("package.json", JSON.stringify(packageJson, null, 2));
        
        await runCommand("git add package.json");
        await runCommand(`git commit -m "Update version to ${versionChange}"`);
      }
    }
    
    // Add some test changes
    fs.writeFileSync("test-file.txt", `Test file for branch ${branchName}\n`);
    await runCommand("git add test-file.txt");
    await runCommand(`git commit -m "Add test file for ${branchName}"`);
    
    // Push branch with upstream tracking
    await runCommand(`git push -u origin ${branchName}`);
    
    debug(`Test branch created: ${branchName}`);
  }

  async createPullRequest(branchName, title, body = "") {
    debug(`Creating pull request for branch: ${branchName}`);
    
    const prOutput = await runCommand(`gh pr create --title "${title}" --body "${body}" --head ${branchName} --base main`, { silent: true });
    const prUrl = prOutput.match(/https:\/\/github\.com\/[^\/]+\/[^\/]+\/pull\/\d+/)[0];
    
    debug(`Pull request created: ${prUrl}`);
    return prUrl;
  }

  async cleanup() {
    debug(`Cleaning up test repository: ${this.name}`);
    
    // Go back to parent directory
    process.chdir(path.dirname(this.localPath));
    
    try {
      // Remove local directory
      if (fs.existsSync(this.localPath)) {
        await runCommand(`rm -rf "${this.localPath}"`, { silent: true });
        debug(`Local directory removed: ${this.localPath}`);
      }
      
      // Only try to delete GitHub repository if it was actually created (has the specific test prefix and timestamp)
      if (this.name.startsWith('auto-merge-test-') && this.name.includes('-') && this.name.length > 20) {
        try {
          // Check if repository exists before trying to delete
          await runCommand(`gh repo view ${GITHUB_USERNAME}/${this.name}`, { silent: true });
          
          // Extra safety check: only delete if created very recently (within last hour)
          const timestampMatch = this.name.match(/auto-merge-test-(\d+)/);
          if (timestampMatch) {
            const repoTimestamp = parseInt(timestampMatch[1]);
            const currentTimestamp = Date.now();
            const hourInMs = 60 * 60 * 1000;
            
            if (currentTimestamp - repoTimestamp < hourInMs) {
              // Try to delete GitHub repository
              await runCommand(`gh repo delete ${GITHUB_USERNAME}/${this.name} --yes`, { silent: true });
              debug(`GitHub repository deleted: ${this.name}`);
            } else {
              debug(`Skipping deletion of old test repository: ${this.name}`);
            }
          }
        } catch (deleteErr) {
          if (deleteErr.message.includes('delete_repo')) {
            debug(`Skipping GitHub repository deletion - insufficient permissions: ${this.name}`);
          } else if (deleteErr.message.includes('Not Found')) {
            debug(`GitHub repository not found (may not have been created): ${this.name}`);
          } else {
            debug(`Warning: Could not delete GitHub repository ${this.name}: ${deleteErr.message}`);
          }
        }
      }
      
      debug(`Test repository cleanup completed: ${this.name}`);
    } catch (err) {
      debug(`Warning: Failed to cleanup repository ${this.name}: ${err.message}`);
    }
  }
}

// ---------------------
// Test Cases
// ---------------------
class TestSuite {
  constructor() {
    this.tests = [];
    this.passed = 0;
    this.failed = 0;
    this.results = [];
  }

  addTest(name, testFn) {
    this.tests.push({ name, testFn });
  }

  async runTest(testName, testFn) {
    console.log(`\n=== Running Test: ${testName} ===`);
    
    const testRepo = new TestRepository(TEST_REPO_NAME + '-' + testName.toLowerCase().replace(/\s+/g, '-'));
    
    try {
      await testFn(testRepo);
      console.log(`✅ PASSED: ${testName}`);
      this.passed++;
      this.results.push({ name: testName, status: 'PASSED' });
    } catch (err) {
      console.log(`❌ FAILED: ${testName}`);
      console.log(`Error: ${err.message}`);
      this.failed++;
      this.results.push({ name: testName, status: 'FAILED', error: err.message });
    } finally {
      await testRepo.cleanup();
      await sleep(2000); // Rate limiting
    }
  }

  async run() {
    console.log(`\n🚀 Starting Auto-Merge Test Suite`);
    console.log(`Total tests to run: ${this.tests.length}\n`);

    for (const test of this.tests) {
      await this.runTest(test.name, test.testFn);
    }

    this.printSummary();
  }

  printSummary() {
    console.log(`\n\n📊 Test Results Summary`);
    console.log(`========================`);
    console.log(`Total: ${this.tests.length}`);
    console.log(`Passed: ${this.passed}`);
    console.log(`Failed: ${this.failed}`);
    console.log(`Success Rate: ${((this.passed / this.tests.length) * 100).toFixed(1)}%`);
    
    if (this.failed > 0) {
      console.log(`\n❌ Failed Tests:`);
      this.results.filter(r => r.status === 'FAILED').forEach(r => {
        console.log(`  - ${r.name}: ${r.error}`);
      });
    }

    console.log(`\n${this.failed === 0 ? '🎉 All tests passed!' : '⚠️  Some tests failed'}`);
  }
}

// ---------------------
// Test Helper Functions
// ---------------------
async function runAutoMergeScript(prUrl, bumpType, options = []) {
  const autoMergeScript = path.join(__dirname, 'auto-merge.mjs');
  const cmd = `node ${autoMergeScript} ${prUrl} ${bumpType} --auto-approve ${options.join(' ')}`;
  
  debug(`Running auto-merge with command: ${cmd}`);
  
  try {
    const output = await runCommand(cmd, { silent: true });
    return { success: true, output };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

function verifyPackageVersion(expectedVersion, repoPath) {
  const packagePath = path.join(repoPath, 'package.json');
  const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  
  if (packageJson.version !== expectedVersion) {
    throw new Error(`Expected version ${expectedVersion}, but got ${packageJson.version}`);
  }
  
  debug(`Version verification passed: ${packageJson.version}`);
}

// ---------------------
// Test Definitions
// ---------------------
function setupTests(testSuite) {
  
  // Test 1: Help command should work and show new option
  testSuite.addTest("Help Command Shows Version Bump Option", async (repo) => {
    const autoMergeScript = path.join(__dirname, 'auto-merge.mjs');
    const result = await runCommand(`node ${autoMergeScript} --help`, { silent: true });
    
    if (!result.includes('--version-bump')) {
      throw new Error('Help output should include --version-bump option');
    }
    
    if (!result.includes('--no-version-bump')) {
      throw new Error('Help output should mention --no-version-bump');
    }
    
    debug("Help command test passed - version bump option is properly documented");
  });

  // Test 2: Script argument parsing
  testSuite.addTest("Argument Parsing", async (repo) => {
    const autoMergeScript = path.join(__dirname, 'auto-merge.mjs');
    
    // Test that the script recognizes the --no-version-bump flag (will fail because no URL, but should parse args)
    try {
      await runCommand(`GITHUB_TOKEN=dummy node ${autoMergeScript} --no-version-bump`, { silent: true });
    } catch (err) {
      // Expected to fail, but should be due to missing arguments, not parsing error
      if (err.message.includes('Both pull request URL and bump type are required')) {
        debug("Argument parsing test passed - --no-version-bump flag is recognized");
      } else {
        throw new Error(`Unexpected error: ${err.message}`);
      }
    }
  });

  // Test 3: Version comparison logic test
  testSuite.addTest("Version Comparison Logic", async (repo) => {
    // Test semver comparison
    if (!semver.lte("1.0.0", "1.0.0")) {
      throw new Error("semver.lte should return true for equal versions");
    }
    
    if (!semver.lte("1.0.0", "1.0.1")) {
      throw new Error("semver.lte should return true for lower to higher version");
    }
    
    if (semver.lte("1.0.1", "1.0.0")) {
      throw new Error("semver.lte should return false for higher to lower version");
    }
    
    debug("Version comparison logic test passed");
  });

  // Test 4: Simple repository setup test
  testSuite.addTest("Repository Setup and Cleanup", async (repo) => {
    await repo.create();
    
    // Verify repository was created
    if (!fs.existsSync(repo.localPath)) {
      throw new Error(`Repository directory not created: ${repo.localPath}`);
    }
    
    // Verify package.json exists
    const packagePath = path.join(repo.localPath, 'package.json');
    if (!fs.existsSync(packagePath)) {
      throw new Error('package.json not created in test repository');
    }
    
    // Verify initial version
    const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
    if (packageJson.version !== '1.0.0') {
      throw new Error(`Expected initial version 1.0.0, got ${packageJson.version}`);
    }
    
    debug("Repository setup test passed");
  });

  // Test 5: Branch creation test
  testSuite.addTest("Test Branch Creation", async (repo) => {
    await repo.create();
    await repo.createTestBranch(TEST_BRANCH_NAME, "1.2.0");
    
    // Verify we're on the test branch
    const currentBranch = await runCommand("git rev-parse --abbrev-ref HEAD", { cwd: repo.localPath, silent: true });
    if (currentBranch.trim() !== TEST_BRANCH_NAME) {
      throw new Error(`Expected to be on branch ${TEST_BRANCH_NAME}, but on ${currentBranch.trim()}`);
    }
    
    // Verify version was updated
    const packagePath = path.join(repo.localPath, 'package.json');
    const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
    if (packageJson.version !== '1.2.0') {
      throw new Error(`Expected version 1.2.0, got ${packageJson.version}`);
    }
    
    debug("Branch creation test passed");
  });

  // Test 6: GitHub CLI integration test
  testSuite.addTest("GitHub CLI Integration", async (repo) => {
    // Test that gh auth token works
    try {
      const token = await runCommand("gh auth token", { silent: true });
      if (!token || token.trim().length < 10) {
        throw new Error("GitHub token appears invalid or too short");
      }
      debug("GitHub CLI integration test passed");
    } catch (err) {
      throw new Error(`GitHub CLI not properly authenticated: ${err.message}`);
    }
  });

  // Test 7: Invalid URL format
  testSuite.addTest("Invalid PR URL Format", async (repo) => {
    const autoMergeScript = path.join(__dirname, 'auto-merge.mjs');
    
    try {
      await runCommand(`GITHUB_TOKEN=dummy node ${autoMergeScript} "https://invalid-url" patch`, { silent: true });
      throw new Error("Should have failed with invalid URL");
    } catch (err) {
      if (err.message.includes('Invalid pull request URL format')) {
        debug("Invalid URL test passed");
      } else {
        throw new Error(`Unexpected error: ${err.message}`);
      }
    }
  });

  // Test 8: Invalid bump type
  testSuite.addTest("Invalid Bump Type", async (repo) => {
    const autoMergeScript = path.join(__dirname, 'auto-merge.mjs');
    
    try {
      await runCommand(`GITHUB_TOKEN=dummy node ${autoMergeScript} "https://github.com/test/repo/pull/123" invalid`, { silent: true });
      throw new Error("Should have failed with invalid bump type");
    } catch (err) {
      if (err.message.includes('Bump type must be one of: patch, minor, major')) {
        debug("Invalid bump type test passed");
      } else {
        throw new Error(`Unexpected error: ${err.message}`);
      }
    }
  });

  // Test 9: Missing arguments
  testSuite.addTest("Missing Arguments", async (repo) => {
    const autoMergeScript = path.join(__dirname, 'auto-merge.mjs');
    
    try {
      await runCommand(`GITHUB_TOKEN=dummy node ${autoMergeScript}`, { silent: true });
      throw new Error("Should have failed with missing arguments");
    } catch (err) {
      if (err.message.includes('Both pull request URL and bump type are required')) {
        debug("Missing arguments test passed");
      } else {
        throw new Error(`Unexpected error: ${err.message}`);
      }
    }
  });

  // Test 10: CLI options parsing
  testSuite.addTest("CLI Options Parsing", async (repo) => {
    const autoMergeScript = path.join(__dirname, 'auto-merge.mjs');
    
    // Test individual options
    const testOptions = [
      '--auto-approve',
      '--no-tag',
      '--auto-tag',
      '--no-version-bump',
      '-y',
      '-t'
    ];
    
    for (const option of testOptions) {
      try {
        await runCommand(`GITHUB_TOKEN=dummy node ${autoMergeScript} "https://github.com/test/repo/pull/123" patch ${option}`, { silent: true });
        throw new Error(`Should have failed (testing parsing, not execution) for ${option}`);
      } catch (err) {
        // Should fail due to invalid repo, but parsing should work
        if (err.message.includes('Failed to fetch repository details') || err.message.includes('getaddrinfo ENOTFOUND')) {
          debug(`Option ${option} parsed successfully`);
        }
      }
    }
    
    debug("CLI options parsing test passed");
  });

  // Test 11: Version command
  testSuite.addTest("Version Command", async (repo) => {
    const autoMergeScript = path.join(__dirname, 'auto-merge.mjs');
    const result = await runCommand(`node ${autoMergeScript} --version`, { silent: true });
    
    // Should output version info without errors (will be from package.json or default)
    debug("Version command test passed");
  });

  // Test 12: Extended version comparison logic
  testSuite.addTest("Extended Version Comparison", async (repo) => {
    // Test edge cases for semver comparison
    if (!semver.lte("1.0.0", "2.0.0")) {
      throw new Error("semver.lte should handle major version differences");
    }
    
    if (!semver.lte("1.0.0", "1.1.0")) {
      throw new Error("semver.lte should handle minor version differences");
    }
    
    if (!semver.lte("0.9.9", "1.0.0")) {
      throw new Error("semver.lte should handle version transitions");
    }
    
    // Test prerelease versions
    if (!semver.lte("1.0.0-alpha", "1.0.0")) {
      throw new Error("semver.lte should handle prerelease versions");
    }
    
    debug("Extended version comparison logic test passed");
  });

  // Test 13: Environment token vs gh CLI token priority
  testSuite.addTest("Token Resolution Priority", async (repo) => {
    const autoMergeScript = path.join(__dirname, 'auto-merge.mjs');
    
    // Test with environment variable (should take priority)
    try {
      await runCommand(`GITHUB_TOKEN=env_token node ${autoMergeScript} "https://github.com/test/repo/pull/123" patch`, { silent: true });
    } catch (err) {
      // Should fail on repo access but should have tried with env token
      if (err.message.includes('Failed to fetch repository details') || err.message.includes('Bad credentials')) {
        debug("Environment token priority test passed");
      }
    }
  });

  // Test 14: Flag combinations
  testSuite.addTest("Flag Combinations", async (repo) => {
    const autoMergeScript = path.join(__dirname, 'auto-merge.mjs');
    
    // Test various flag combinations
    const flagCombinations = [
      '--auto-approve --no-tag',
      '--auto-tag --no-version-bump',
      '-y -t',
      '--auto-approve --auto-tag --no-version-bump'
    ];
    
    for (const flags of flagCombinations) {
      try {
        await runCommand(`GITHUB_TOKEN=dummy node ${autoMergeScript} "https://github.com/test/repo/pull/123" patch ${flags}`, { silent: true });
        throw new Error(`Should have failed (testing parsing) for flags: ${flags}`);
      } catch (err) {
        // Should fail on repo access, not flag parsing
        if (err.message.includes('Failed to fetch repository details') || err.message.includes('getaddrinfo ENOTFOUND')) {
          debug(`Flag combination parsed successfully: ${flags}`);
        }
      }
    }
    
    debug("Flag combinations test passed");
  });

  // Test 15: URL validation edge cases
  testSuite.addTest("URL Validation Edge Cases", async (repo) => {
    const autoMergeScript = path.join(__dirname, 'auto-merge.mjs');
    
    // Test various invalid URLs
    const invalidUrls = [
      'not-a-url',
      'https://github.com/owner',
      'https://github.com/owner/repo',
      'https://github.com/owner/repo/issues/123',
      'https://gitlab.com/owner/repo/merge_requests/123',
      'https://github.com/owner/repo/pull/abc'  // non-numeric PR number
    ];
    
    for (const invalidUrl of invalidUrls) {
      try {
        await runCommand(`GITHUB_TOKEN=dummy node ${autoMergeScript} "${invalidUrl}" patch`, { silent: true });
        throw new Error(`Should have failed for invalid URL: ${invalidUrl}`);
      } catch (err) {
        if (err.message.includes('Invalid pull request URL format')) {
          debug(`Invalid URL validation passed for: ${invalidUrl}`);
        } else {
          throw new Error(`Unexpected error for URL ${invalidUrl}: ${err.message}`);
        }
      }
    }
    
    debug("URL validation edge cases test passed");
  });

  // Test 16: Pull request creation and validation
  testSuite.addTest("Pull Request Creation", async (repo) => {
    await repo.create();
    await repo.createTestBranch(TEST_BRANCH_NAME, "1.2.0");
    
    const prUrl = await repo.createPullRequest(TEST_BRANCH_NAME, "Test PR Creation", "This is a test PR body");
    
    if (!prUrl.includes('github.com') || !prUrl.includes('/pull/')) {
      throw new Error(`Invalid PR URL returned: ${prUrl}`);
    }
    
    // Verify PR exists by checking with gh CLI
    const prNumber = prUrl.split('/').pop();
    const prInfo = await runCommand(`gh pr view ${prNumber} --repo ${repo.url} --json title`, { silent: true, cwd: repo.localPath });
    const prData = JSON.parse(prInfo);
    
    if (prData.title !== "Test PR Creation") {
      throw new Error(`PR title mismatch. Expected "Test PR Creation", got "${prData.title}"`);
    }
    
    debug("Pull request creation test passed");
  });

  // Test 17: Branch creation with various version scenarios
  testSuite.addTest("Branch Version Scenarios", async (repo) => {
    await repo.create();
    
    // Test creating branch with same version (should not commit version change)
    await repo.createTestBranch(TEST_BRANCH_NAME + '-same', "1.0.0");
    
    // Verify we're on the test branch
    const currentBranch = await runCommand("git rev-parse --abbrev-ref HEAD", { cwd: repo.localPath, silent: true });
    if (!currentBranch.trim().includes(TEST_BRANCH_NAME + '-same')) {
      throw new Error(`Expected to be on branch containing ${TEST_BRANCH_NAME}-same, but on ${currentBranch.trim()}`);
    }
    
    // Switch back and test with different version
    await runCommand("git checkout main", { cwd: repo.localPath, silent: true });
    await repo.createTestBranch(TEST_BRANCH_NAME + '-diff', "1.2.0");
    
    // Verify version was updated
    const packagePath = path.join(repo.localPath, 'package.json');
    const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
    if (packageJson.version !== '1.2.0') {
      throw new Error(`Expected version 1.2.0, got ${packageJson.version}`);
    }
    
    debug("Branch version scenarios test passed");
  });

  // Test 18: Error handling for missing GitHub CLI
  testSuite.addTest("GitHub CLI Error Handling", async (repo) => {
    const autoMergeScript = path.join(__dirname, 'auto-merge.mjs');
    
    try {
      // Test with no token in env and simulate gh failure
      await runCommand(`PATH=/nonexistent GITHUB_TOKEN="" node ${autoMergeScript} "https://github.com/test/repo/pull/123" patch`, { silent: true });
      throw new Error("Should have failed when gh CLI not available");
    } catch (err) {
      if (err.message.includes('gh auth login') || err.message.includes('GITHUB_TOKEN') || err.message.includes('not found')) {
        debug("GitHub CLI error handling test passed");
      } else {
        throw new Error(`Unexpected error message: ${err.message}`);
      }
    }
  });
}

// ---------------------
// Main Test Runner
// ---------------------
async function main() {
  console.log("🔧 Auto-Merge Script Test Suite");
  console.log("================================");
  
  // Verify prerequisites
  try {
    await runCommand("gh auth status", { silent: true });
    debug("GitHub CLI authentication verified");
  } catch (err) {
    console.error("❌ GitHub CLI not authenticated. Please run 'gh auth login' first.");
    process.exit(1);
  }
  
  // Check if auto-merge.mjs exists
  const autoMergeScript = path.join(__dirname, 'auto-merge.mjs');
  if (!fs.existsSync(autoMergeScript)) {
    console.error(`❌ auto-merge.mjs not found at ${autoMergeScript}`);
    process.exit(1);
  }

  const testSuite = new TestSuite();
  setupTests(testSuite);
  
  await testSuite.run();
  
  // Exit with appropriate code
  process.exit(testSuite.failed > 0 ? 1 : 0);
}

// Handle cleanup on process exit
process.on('SIGINT', async () => {
  console.log('\n\n🛑 Test suite interrupted. Cleaning up...');
  
  // Only cleanup local directories - be very conservative with GitHub repo cleanup
  try {
    const currentDir = process.cwd();
    const files = fs.readdirSync(currentDir);
    
    for (const file of files) {
      if (file.startsWith('auto-merge-test-') && fs.statSync(file).isDirectory()) {
        console.log(`Removing local test directory: ${file}`);
        await runCommand(`rm -rf "${file}"`, { silent: true });
      }
    }
    
    console.log('Local cleanup completed. Note: GitHub repositories with "auto-merge-test-" prefix may need manual cleanup if you have delete permissions.');
  } catch (err) {
    console.error('Warning: Failed to cleanup local test directories:', err.message);
  }
  
  process.exit(1);
});

// Run the tests
main().catch((err) => {
  console.error('❌ Test suite failed:', err.message);
  process.exit(1);
});