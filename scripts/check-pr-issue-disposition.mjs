#!/usr/bin/env node

import fs from "node:fs";
import process from "node:process";

import { loadCurrentPullRequestDisposition } from "./lib/github-pr-issue-disposition.mjs";
import { validatePullRequestDisposition } from "./lib/pr-issue-disposition.mjs";

function usage() {
  return (
    "Usage: node scripts/check-pr-issue-disposition.mjs " +
    "[--event <event.json> | --repository <owner/name> --pull-request <number>] [--metadata <metadata.json>]"
  );
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!["--event", "--metadata", "--repository", "--pull-request"].includes(argument)) throw new Error(usage());
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(usage());
    options[argument.slice(2)] = value;
    index += 1;
  }
  return options;
}

function readJson(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`${label} could not be read as JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function eventPullRequestInput(event) {
  const pullRequest = event?.pull_request;
  const repository = event?.repository?.full_name;
  if (!pullRequest || typeof repository !== "string") {
    throw new Error("GitHub event does not contain pull_request and repository.full_name metadata.");
  }
  return {
    repository,
    pullRequestNumber: pullRequest.number,
    body: pullRequest.body ?? "",
    authorLogin: pullRequest.user?.login ?? "",
    authorType: pullRequest.user?.type ?? "",
    headRefName: pullRequest.head?.ref ?? "",
    headSha: pullRequest.head?.sha ?? "",
    headRepository: pullRequest.head?.repo?.full_name ?? "",
    baseRefName: pullRequest.base?.ref ?? "",
    baseSha: pullRequest.base?.sha ?? "",
    baseRepository: pullRequest.base?.repo?.full_name ?? repository,
    title: pullRequest.title ?? "",
  };
}

function writeSummary(input, result) {
  const lines = ["## Pull request issue disposition", ""];
  if (result.status === "exempt") {
    lines.push(`Exempt: ${result.exemption}.`);
  } else {
    lines.push(`Validated ${input.repository}#${input.pullRequestNumber}.`);
    lines.push(`- Closes: ${result.closes.length > 0 ? result.closes.map((n) => `#${n}`).join(", ") : "none"}`);
    lines.push(`- Refs: ${result.refs.length > 0 ? result.refs.map((n) => `#${n}`).join(", ") : "none"}`);
  }
  const summary = `${lines.join("\n")}\n`;
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  process.stdout.write(summary);
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const directInputRequested = options.repository !== undefined || options["pull-request"] !== undefined;
  if (directInputRequested && (options.event !== undefined || !options.repository || !options["pull-request"])) {
    throw new Error(usage());
  }
  let eventInput;
  if (directInputRequested) {
    const pullRequestNumber = Number.parseInt(options["pull-request"], 10);
    if (!Number.isSafeInteger(pullRequestNumber) || pullRequestNumber <= 0) throw new Error(usage());
    eventInput = { repository: options.repository, pullRequestNumber };
  } else {
    const eventPath = options.event ?? process.env.GITHUB_EVENT_PATH;
    if (!eventPath) throw new Error(`${usage()}\nGITHUB_EVENT_PATH is not set.`);
    eventInput = eventPullRequestInput(readJson(eventPath, "GitHub event"));
  }
  const input = options.metadata
    ? { ...eventInput, ...readJson(options.metadata, "Disposition metadata") }
    : await loadCurrentPullRequestDisposition({
        repository: eventInput.repository,
        pullRequestNumber: eventInput.pullRequestNumber,
      });
  const result = validatePullRequestDisposition(input);
  writeSummary(input, result);
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`PR issue disposition failed: ${message}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Pull request issue disposition\n\nFailed: ${message}\n`);
  }
  process.exitCode = 1;
}
