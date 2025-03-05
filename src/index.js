import { getInput, setFailed } from "@actions/core";
import { getOctokit, context } from "@actions/github";
import { WebClient } from "@slack/web-api";

const run = async () => {
  try {
    console.log("Starting GitHub Action...");

    // Handle missing repo-token gracefully
    const githubToken = getInput("repo-token") || process.env.GITHUB_TOKEN || process.env.PERSONAL_ACCESS_TOKEN;
    if (!githubToken) {
      throw new Error("Missing required GitHub token. Ensure 'repo-token' or 'GITHUB_TOKEN' is set.");
    }

    const octokit = getOctokit(githubToken);
    const slack = new WebClient(process.env.SLACK_BOT_TOKEN);

    const { eventName, payload, repo } = context;
    const { issue, comment } = payload;
    const repository = `${repo.owner}/${repo.repo}`;
    const [owner, repoName] = repository.split("/");

    console.log(`Processing event: ${eventName} in repository ${repository}`);

    if (eventName !== "issue_comment" || !issue || !comment) return;

    const commentBody = comment.body.toLowerCase();
    const assignKeywords = ["/assign", "assign to me", "work on this"];
    const unassignKeywords = ["/unassign"];

    const shouldAssign = assignKeywords.some((kw) => commentBody.includes(kw));
    const shouldUnassign = unassignKeywords.some((kw) => commentBody.startsWith(kw));

    if (shouldUnassign) {
      await unassignUser(octokit, owner, repoName, issue, comment);
    }

    if (shouldAssign) {
      await assignUser(octokit, owner, repoName, issue, comment);
    }

    await handleStaleAssignments(octokit, owner, repoName);

    if (commentBody.startsWith("/bounty ")) {
      await processBounty(octokit, slack, owner, repoName, issue, comment);
    }
  } catch (error) {
    console.error("Critical error:", error);
    setFailed(error.message);
  }
};

const unassignUser = async (octokit, owner, repo, issue, comment) => {
  console.log(`Unassigning issue #${issue.number} from ${comment.user.login}`);

  try {
    const { data: issueDetails } = await octokit.issues.get({ owner, repo, issue_number: issue.number });

    if (issueDetails.labels.some((label) => label.name === "assigned")) {
      await octokit.issues.removeAssignees({ owner, repo, issue_number: issue.number, assignees: [comment.user.login] });
      await octokit.issues.removeLabel({ owner, repo, issue_number: issue.number, name: "assigned" });

      await octokit.issues.createComment({
        owner,
        repo,
        issue_number: issue.number,
        body: `You have been unassigned. This issue is open for others.`,
      });
    }
  } catch (error) {
    console.error(`Error unassigning issue #${issue.number}:`, error);
  }
};

const assignUser = async (octokit, owner, repo, issue, comment) => {
  console.log(`Assigning issue #${issue.number} to ${comment.user.login}`);

  try {
    await octokit.issues.addAssignees({ owner, repo, issue_number: issue.number, assignees: [comment.user.login] });
    await octokit.issues.addLabels({ owner, repo, issue_number: issue.number, labels: ["assigned"] });

    await octokit.issues.createComment({
      owner,
      repo,
      issue_number: issue.number,
      body: `Hello @${comment.user.login}! You've been assigned this issue. You have 24 hours to submit a PR.`,
    });
  } catch (error) {
    console.error(`Error assigning issue #${issue.number}:`, error);
  }
};

const handleStaleAssignments = async (octokit, owner, repo) => {
  console.log("Checking for stale assignments...");

  try {
    const events = await octokit.paginate(octokit.issues.listEventsForRepo, {
      owner,
      repo,
      per_page: 100,
    });

    const now = new Date();

    for (const event of events) {
      if (event.issue.assignee && event.issue.state === "open") {
        const lastUpdated = new Date(event.issue.updated_at);
        const daysInactive = (now - lastUpdated) / (1000 * 3600 * 24);

        if (daysInactive > 1) {
          console.log(`Unassigning inactive issue #${event.issue.number}`);

          await octokit.issues.removeAssignees({ owner, repo, issue_number: event.issue.number, assignees: [event.issue.assignee.login] });
          await octokit.issues.removeLabel({ owner, repo, issue_number: event.issue.number, name: "assigned" });

          await octokit.issues.createComment({
            owner,
            repo,
            issue_number: event.issue.number,
            body: `⏰ This issue has been unassigned due to inactivity.`,
          });
        }
      }
    }
  } catch (error) {
    console.error("Error processing stale assignments:", error);
  }
};

const processBounty = async (octokit, slack, owner, repo, issue, comment) => {
  console.log("Processing bounty...");

  const bountyRegex = /\/bounty\s+\$(\d+)/;
  const match = comment.body.match(bountyRegex);

  if (!match) return;

  const bountyAmount = parseInt(match[1], 10);
  const issueNumber = issue.number;
  const commenter = comment.user?.login || "Unknown";

  try {
    const { data: labels } = await octokit.issues.listLabelsOnIssue({ owner, repo, issue_number: issueNumber });

    let totalBounty = bountyAmount;
    const bountyLabel = labels.find((label) => label.name.startsWith("$"));

    if (bountyLabel) {
      const existingBounty = parseInt(bountyLabel.name.slice(1), 10);
      totalBounty += existingBounty;
    }

    const newBountyLabel = `$${totalBounty}`;
    if (bountyLabel) {
      await octokit.issues.updateLabel({ owner, repo, name: bountyLabel.name, new_name: newBountyLabel });
    } else {
      await octokit.issues.addLabels({ owner, repo, issue_number: issueNumber, labels: [newBountyLabel] });
    }

    await octokit.issues.createComment({
      owner,
      repo,
      issue_number: issueNumber,
      body: `💰 A bounty of **$${bountyAmount}** was added by @${commenter}. Total bounty is now **$${totalBounty}**.`,
    });

    await slack.chat.postMessage({
      channel: "#bounty-alerts",
      text: `🚀 *Bounty Alert!* @${commenter} added *$${bountyAmount}* to issue #${issueNumber}. Total: *$${totalBounty}*.`,
    });

  } catch (error) {
    console.error("Bounty Error:", error);
  }
};

run();
