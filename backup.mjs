#!/usr/bin/env zx
import "zx/globals";
import * as p from "@clack/prompts";

const SOURCE_PATH = os.homedir();

const CONFIG_DIR = path.join(__dirname, "config");
const PROFILE_FILE = path.join(CONFIG_DIR, ".borg_profile");

if (!fs.existsSync(PROFILE_FILE)) {
  throw new Error(`Missing profile file: ${PROFILE_FILE}`);
}

const profile = fs.readFileSync(PROFILE_FILE, "utf-8").trim();

if (!/^[a-zA-Z0-9_-]+$/.test(profile)) {
  throw new Error(`Invalid profile name: ${profile}`);
}

const commonPath = path.join(CONFIG_DIR, "common.json");
const machinePath = path.join(CONFIG_DIR, `${profile}.json`);

if (!fs.existsSync(machinePath)) {
  throw new Error(`Missing machine config: ${machinePath}`);
}

const machine = JSON.parse(fs.readFileSync(machinePath, "utf8"));
const common = JSON.parse(fs.readFileSync(commonPath, "utf8"));

const config = {
  ...common,
  ...machine,
  retention: {
    daily: 7,
    weekly: 4,
    monthly: 6,
    ...(common.retention ?? {}),
    ...(machine.retention ?? {}),
  },
};

const allHaveKeys = config.repositories.every(
  (repo) => Object.hasOwn(repo, "name") && Object.hasOwn(repo, "location"),
);

if (!allHaveKeys) {
  throw new Error("A repository is missing the name or location key");
}

if (typeof config.excludeFile !== "string" || !config.excludeFile.trim()) {
  throw new Error(
    `Missing "excludeFile" in config/${profile}.json or config/common.json`,
  );
}

function expandHome(value) {
  return value.replace(/^~(?=$|\/)/, os.homedir());
}

function log(msg) {
  console.log(msg);
}

function header(title) {
  console.log(chalk.bold.magenta(`\n=== ${title} ===`));
}

function success(msg) {
  console.log(chalk.green(`\n[OK] ${msg}`));
}

function error(msg) {
  console.log(chalk.red(`\n[ERROR] ${msg}`));
}

function warn(msg) {
  console.log(chalk.yellow(`\n[WARN] ${msg}`));
}

async function testConnection() {
  try {
    await $`ssh -p ${SERVER.port} -o ConnectTimeout=3 -o BatchMode=yes ${SERVER.username}@${SERVER.hostname} exit 0`;
    return true;
  } catch {
    error(`Connection to ${SERVER.hostname} failed`);
    return false;
  }
}

async function checkExcludeFile(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    warn(`Exclude file: ${file} does not exist`);
    return false;
  }
}

async function cmdBackup(repoPath, isDryRun = false) {
  header(isDryRun ? "Backup (DRY RUN)" : "Backup");

  const excludeFileExists = await checkExcludeFile(config.excludeFile);
  if (!excludeFileExists) {
    process.exit(1);
  }

  const archiveName = `${profile}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const fullRepoTarget = `${repoPath}::${archiveName}`;

  log(chalk.cyan(`Target: ${fullRepoTarget}`));
  log(chalk.cyan(`Source: ${SOURCE_PATH}`));

  const start = Date.now();

  try {
    const dryRunFlag = isDryRun ? ["--dry-run"] : [];
    const statsFlag = isDryRun ? [] : ["--stats"];
    const filterFlag = isDryRun ? [] : ["--filter", "AME"];

    await $`borg create \
            ${dryRunFlag} \
            ${statsFlag} \
            --exclude-caches \
            --exclude-if-present .nobackup \
            --exclude-from ${config.excludeFile} \
            --compression auto,zstd,7 \
            --progress \
            --list ${filterFlag} \
            ${fullRepoTarget} ${SOURCE_PATH}`;

    const duration = ((Date.now() - start) / 1000).toFixed(1);
    success(`Backup completed in ${duration}s`);
  } catch (err) {
    console.log("");
    if (
      err.message?.includes("password retries") ||
      err.stderr?.includes("password retries")
    ) {
      error(
        "SSH connection failed: password authentication not allowed. Use SSH keys.",
      );
    } else {
      error(`Backup failed: ${err.stderr || err.message}`);
    }
    process.exit(1);
  }
}

async function cmdInfo(repoPath) {
  log(chalk.cyan(`Repo: ${repoPath}`));

  try {
    await $`borg info ${repoPath}`.pipe(process.stdout);
  } catch {
    error("No access to remote repository or repository not initialized.");
  }
}

async function cmdList(repoPath) {
  header("List of Archives");

  try {
    await $`borg list --short ${repoPath}`.pipe(process.stdout);
  } catch {
    error("Empty list of archives or repository unreachable.");
  }
}

async function cmdPrune(repoPath) {
  header("Clean Archives (Prune)");

  try {
    const res = await $`borg prune \
            --keep-daily ${config.retention.daily} \
            --keep-weekly ${config.retention.weekly} \
            --keep-monthly ${config.retention.monthly} \
            --list ${repoPath}`.pipe(process.stdout);
    success("Clean done");
  } catch {
    error("Unable to run prune over network");
  }
}

async function cmdCheck(repoPath) {
  header("Integrity check");

  try {
    await $`borg check --verify-data ${repoPath}`.pipe(process.stdout);
    success("Repository OK");
  } catch {
    error("Integrity check failed");
  }
}

async function cmdRestore(archiveName) {
  header("Restore Archive");

  if (!archiveName) {
    error("Please specify an archive name to restore.");
    log(chalk.yellow("Usage: ./backup.mjs restore <archive_name>"));
    process.exit(1);
  }

  log(chalk.cyan(`Restoring archive: ${archiveName}...`));

  try {
    await $`borg extract --list ${REPO_PATH}::${archiveName}`;
    success("Restore complete.");
  } catch (e) {
    error(`Restore failed: ${e.message}`);
  }
}
async function getSelections() {
  const scope = await p.select({
    message: "Select repository scope:",
    options: [
      { value: "all", label: "All repositories" },
      { value: "select", label: "Select specific repositories" },
    ],
  });

  if (p.isCancel(scope)) {
    p.cancel("Operation cancelled.");
    return null;
  }

  let repos = [];
  if (scope === "all") {
    repos = config.repositories;
  } else {
    const selectedRepos = await p.multiselect({
      message: "Select repositories:",
      options: [
        ...config.repositories.map((repo) => ({
          value: repo.location,
          label: `${repo.name} - ${repo.location}`,
        })),
      ],
    });

    if (p.isCancel(selectedRepos)) {
      p.cancel("Operation cancelled.");
      return null;
    }

    if (selectedRepos.length === 0) {
      p.cancel("No repositories selected.");
      return null;
    }

    repos = config.repositories.filter((repo) =>
      selectedRepos.includes(repo.location),
    );
  }
  const selectedAction = await p.select({
    message: "Select action:",
    options: [
      { value: "backup", label: "Backup" },
      { value: "dry-run", label: "Dry run" },
      { value: "info", label: "Info" },
      { value: "list", label: "List archives" },
      { value: "prune", label: "Prune archives" },
      { value: "check", label: "Check integrity" },
    ],
  });

  if (p.isCancel(selectedAction)) {
    p.cancel("Operation cancelled.");
    return null;
  }

  return { repos, selectedAction };
}

const cleanArgs = argv._.filter(
  (arg) =>
    typeof arg === "string" && !arg.endsWith(".mjs") && !arg.endsWith(".ts"),
);
const command = cleanArgs[0] || "backup";
const extraArg = cleanArgs[1]; // to restore a specific archive, if needed

try {
  const selections = await getSelections();
  if (!selections) {
    error(`Cancled.`);
    process.exit(1);
  }

  const { repos, selectedAction } = selections;

  for (const repo of repos) {
    const repoPath = repo.location;
    const repoName = repo.name;

    switch (selectedAction) {
      case "backup":
        await cmdBackup(repoPath, false);
        break;

      case "dry-run":
        await cmdBackup(repoPath, true);
        break;

      case "info":
        await cmdInfo(repoPath);
        break;

      case "list":
        await cmdList(repoPath);
        break;

      case "prune":
        await cmdPrune(repoPath);
        break;

      case "check":
        await cmdCheck(repoPath);
        break;

      case "restore":
        await cmdRestore(extraArg);
        break;

      default:
        error(`Unknown command ${selectedAction}`);
        process.exit(1);
    }
  }
} catch (err) {
  error(`Unexpected script failure: ${err.message}`);
  process.exit(1);
}
