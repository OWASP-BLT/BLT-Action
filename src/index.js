const core = require("@actions/core");
const github = require("@actions/github");
const fs = require("fs");
const { Octokit } = require("@octokit/core");
const { WebClient } = require("@slack/web-api");


const run = async () => {
  try {
    console.log("Starting GitHub Action...");

    // Get necessary inputs
    const gitHubToken = core.getInput("repo-token", { required: true });
    const octokit = github.getOctokit(gitHubToken);

    const { eventName, payload, repo } = github.context;
    const { issue, comment } = payload;
    const repository = `${repo.owner}/${repo.repo}`;
    const [owner, repoName] = repository.split("/");

    console.log(`Processing event: ${eventName} in repository ${repository}`);

    // Assignment keywords
    const assignKeywords = [
      "/assign",
      "assign to me",
      "assign this to me",
      "assign it to me",
      "assign me this",
      "work on this",
      "i can try fixing this",
      "i am interested in doing this",
      "be assigned this",
      "i am interested in contributing",
    ];
    const unassignKeywords = ["/unassign"];

    if (eventName === "issue_comment" && issue && comment) {
      console.log("Processing issue comment...");
      const commentBody = comment.body.toLowerCase();
      const shouldAssign = assignKeywords.some((keyword) =>
        commentBody.includes(keyword)
      );
      const shouldUnassign = unassignKeywords.some((keyword) =>
        commentBody.startsWith(keyword)
      );

      if (shouldUnassign) {
        console.log(
          `Unassigning issue #${issue.number} from ${comment.user.login}`
        );

        try {
          // Fetch issue details
          const issueDetails = await octokit.issues.get({
            owner,
            repo: repoName,
            issue_number: issue.number,
          });

          const hasAssignedLabel = issueDetails.data.labels.some(
            (label) => label.name === "assigned"
          );

          if (hasAssignedLabel) {
            await octokit.issues.removeAssignees({
              owner,
              repo: repoName,
              issue_number: issue.number,
              assignees: [comment.user.login],
            });

            await octokit.issues
              .removeLabel({
                owner,
                repo: repoName,
                issue_number: issue.number,
                name: "assigned",
              })
              .catch(() => console.log("Label already removed or not found."));

            // Check existing comments to avoid duplicates
            const existingComments = await octokit.issues.listComments({
              owner,
              repo: repoName,
              issue_number: issue.number,
            });

            const unassignMessageExists = existingComments.data.some(
              (comment) =>
                comment.body.includes(
                  "⏰ This issue has been automatically unassigned due to 24 hours of inactivity."
                ) ||
                comment.body.includes(
                  "You have been unassigned from this issue."
                )
            );

            if (!unassignMessageExists) {
              await octokit.issues.createComment({
                owner,
                repo: repoName,
                issue_number: issue.number,
                body: `You have been unassigned from this issue. It’s now open for others. You can reassign it anytime by typing /assign.`,
              });
            }
          } else {
            console.log(
              `Issue #${issue.number} does not have the "assigned" label, skipping unassign.`
            );
          }
        } catch (error) {
          console.error(`Error unassigning issue #${issue.number}:`, error);
        }
      }

      if (shouldAssign) {
        console.log(
          `Assigning issue #${issue.number} to ${comment.user.login}`
        );
        try {
          const assigneeLogin = comment.user.login;

          // Get assigned issues
          const assignedIssues = await octokit.paginate(
            octokit.issues.listForRepo,
            {
              owner,
              repo: repoName,
              state: "open",
              assignee: assigneeLogin,
            }
          );

          // Check if user has unresolved issues without a PR
          let issuesWithoutPR = [];
          for (const assignedIssue of assignedIssues) {
            if (assignedIssue.number === issue.number) continue;

            const query = `type:pr state:open repo:${owner}/${repoName} ${assignedIssue.number} in:body`;
            const pullRequests = await octokit.search.issuesAndPullRequests({
              q: query,
            });

            if (pullRequests.data.total_count === 0) {
              console.log(
                `Issue #${assignedIssue.number} does not have an open pull request`
              );
              issuesWithoutPR.push(assignedIssue.number);
            }
          }

          if (issuesWithoutPR.length > 0) {
            const issueList = issuesWithoutPR.join(", #");
            await octokit.issues.createComment({
              owner,
              repo: repoName,
              issue_number: issue.number,
              body: `You cannot be assigned to this issue because you are already assigned to the following issues without an open pull request: #${issueList}. Please submit a pull request for these issues before getting assigned to a new one.`,
            });
            return;
          }

          // Assign user to the issue
          await octokit.issues.addAssignees({
            owner,
            repo: repoName,
            issue_number: issue.number,
            assignees: [assigneeLogin],
          });

          // Add "assigned" label
          await octokit.issues.addLabels({
            owner,
            repo: repoName,
            issue_number: issue.number,
            labels: ["assigned"],
          });

          await octokit.issues.createComment({
            owner,
            repo: repoName,
            issue_number: issue.number,
            body: `Hello @${assigneeLogin}! You've been assigned to [${repository} issue #${issue.number}](https://github.com/${repository}/issues/${issue.number}). You have 24 hours to complete a pull request.`,
          });
        } catch (error) {
          console.error(`Error assigning issue #${issue.number}:`, error);
        }
      }
    }

    console.log("Checking for stale assignments...");
    const presentDate = new Date();

    try {
      const events = await octokit.paginate(
        octokit.issues.listEventsForRepo,
        {
          owner,
          repo: repoName,
          per_page: 100,
        },
        (response) =>
          response.data.filter((event) => event.event === "assigned")
      );

      for (const event of events) {
        if (event.issue.assignee && event.issue.state === "open") {
          const timeSinceUpdate =
            presentDate.getTime() - new Date(event.issue.updated_at).getTime();
          const daysInactive = timeSinceUpdate / (1000 * 3600 * 24);

          if (daysInactive > 1) {
            console.log(
              `Unassigning issue #${event.issue.number} due to inactivity`
            );

            const issueDetails = await octokit.issues.get({
              owner,
              repo: repoName,
              issue_number: event.issue.number,
            });

            const hasAssignedLabel = issueDetails.data.labels.some(
              (label) => label.name === "assigned"
            );

            if (hasAssignedLabel) {
              await octokit.issues.removeAssignees({
                owner,
                repo: repoName,
                issue_number: event.issue.number,
                assignees: [event.issue.assignee.login],
              });

              await octokit.issues.removeLabel({
                owner,
                repo: repoName,
                issue_number: event.issue.number,
                name: "assigned",
              });

              await octokit.issues.createComment({
                owner,
                repo: repoName,
                issue_number: event.issue.number,
                body: `⏰ This issue has been automatically unassigned due to 24 hours of inactivity. The issue is now available for anyone to work on again.`,
              });
            } else {
              console.log(
                `Issue #${event.issue.number} does not have the "assigned" label, skipping unassign.`
              );
            }
          }
        }
      }
    } catch (error) {
      console.error("Error processing stale assignments:", error);
    }
  } catch (error) {
    console.error("Critical error in GitHub Action:", error);
  }
  try {
    const githubContextPath = process.argv[2];
    if (!githubContextPath || !fs.existsSync(githubContextPath)) {
      console.error("GitHub context file missing or not provided");
      process.exit(1);
    }

    const contextData = fs.readFileSync(githubContextPath, "utf8");
    const context = JSON.parse(contextData);

    const event = context.event || {};
    const comment = event.comment || {};
    const issue = event.issue || {};
    const repository = event.repository || {};

    if (!comment.body || !issue.number || !repository.full_name) {
      console.error("Missing required GitHub context data");
      process.exit(1);
    }

    const bountyRegex = /\/bounty\s+\$(\d+)/;
    const match = comment.body.match(bountyRegex);

    if (!match) {
      // console.log('No bounty command found');
      return;
    }

    const bountyAmount = parseInt(match[1], 10);
    const [repoOwner, repoName] = repository.full_name.split("/");
    const issueNumber = issue.number;
    const commenter = comment.user?.login || "Unknown";

    const github = new Octokit({ auth: process.env.PERSONAL_ACCESS_TOKEN });
    const slack = new WebClient(process.env.SLACK_BOT_TOKEN);

    const { data: labels } = await github.issues.listLabelsOnIssue({
      owner: repoOwner,
      repo: repoName,
      issue_number: issueNumber,
    });

    let totalBounty = bountyAmount;
    const bountyLabelPrefix = "$";
    const bountyLabel = labels.find((label) =>
      label.name.startsWith(bountyLabelPrefix)
    );

    if (bountyLabel) {
      const existingBounty = parseInt(bountyLabel.name.slice(1), 10);
      totalBounty += existingBounty;
    }

    const newBountyLabel = `${bountyLabelPrefix}${totalBounty}`;

    try {
      if (bountyLabel) {
        await github.issues.updateLabel({
          owner: repoOwner,
          repo: repoName,
          name: bountyLabel.name,
          new_name: newBountyLabel,
        });
      } else {
        await github.issues.addLabels({
          owner: repoOwner,
          repo: repoName,
          issue_number: issueNumber,
          labels: [newBountyLabel],
        });
      }
    } catch (labelError) {
      console.error("Label Update Error:", labelError);
    }

    const sponsorshipHistory = {};
    if (!sponsorshipHistory[commenter]) {
      sponsorshipHistory[commenter] = 1;
    } else {
      sponsorshipHistory[commenter] += 1;
    }

    const { data: comments } = await github.issues.listComments({
      owner: repoOwner,
      repo: repoName,
      issue_number: issueNumber,
    });

    const bountyComment = comments.find((c) =>
      c.body.includes("💰 A bounty has been added!")
    );

    const commentBody = `💰 A bounty has been added!\n\nThis issue now has a total bounty of **$${totalBounty}** thanks to @${commenter}.\nThey have sponsored **${sponsorshipHistory[commenter]}** developers so far!\n\nWant to contribute? Solve this issue and claim the reward.`;

    try {
      if (bountyComment) {
        await github.issues.updateComment({
          owner: repoOwner,
          repo: repoName,
          comment_id: bountyComment.id,
          body: commentBody,
        });
      } else {
        await github.issues.createComment({
          owner: repoOwner,
          repo: repoName,
          issue_number: issueNumber,
          body: commentBody,
        });
      }
    } catch (commentError) {
      console.error("Comment Creation Error:", commentError);
    }

    try {
      await slack.chat.postMessage({
        channel: "#bounty-alerts",
        text: `🚀 *Bounty Alert!*\n@${commenter} has added a *$${bountyAmount}* bounty to <https://github.com/${repository.full_name}/issues/${issueNumber}|#${issueNumber}>.\nThe total bounty for this issue is now *$${totalBounty}*.\nContribute now and earn rewards!`,
      });
    } catch (slackError) {
      console.error("Slack Notification Error:", slackError);
    }

    // console.log(`Bounty processed: $${bountyAmount} added by ${commenter}`);
  } catch (error) {
    console.error("Bounty Bot Unexpected Error:", error);
    process.exit(1);
  }
};

run();
