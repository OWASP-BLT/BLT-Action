const core = require('@actions/core');
const github = require('@actions/github');
const fs = require('fs');
const { WebClient } = require('@slack/web-api');

const run = async () => {
    try {
        console.log("Starting GitHub Action...");

        // Get necessary inputs
        const gitHubToken = core.getInput('repo-token') || process.env.PERSONAL_ACCESS_TOKEN;

        if (!gitHubToken) {
            console.warn("⚠️ Warning: GitHub Token is missing. Skipping GitHub API calls.");
            return; // Exit gracefully instead of crashing
        }
        const octokit = github.getOctokit(gitHubToken);
        const slack = new WebClient(process.env.SLACK_BOT_TOKEN);
        
        const { eventName, payload, repo } = github.context;
        const { issue, comment } = payload;
        const repository = `${repo.owner}/${repo.repo}`;
        const [owner, repoName] = repository.split('/');

        console.log(`Processing event: ${eventName} in repository ${repository}`);

        if (!comment || !issue) {
            console.error("No comment or issue detected. Exiting.");
            return;
        }
        
        const commentBody = comment.body.toLowerCase();
        const assigneeLogin = comment.user.login;

        // Assignment keywords
        const assignKeywords = ['/assign', 'assign to me', 'assign this to me', 'assign it to me', 'assign me this', 'work on this', 'i can try fixing this', 'i am interested in doing this', 'be assigned this', 'i am interested in contributing'];
        const unassignKeywords = ['/unassign'];
        const bountyRegex = /\/bounty\s+\$(\d+)/;

        const shouldAssign = assignKeywords.some(keyword => commentBody.includes(keyword));
        const shouldUnassign = unassignKeywords.some(keyword => commentBody.startsWith(keyword));
        const bountyMatch = commentBody.match(bountyRegex);
        
        if (shouldUnassign) {
            console.log(`Unassigning issue #${issue.number} from ${assigneeLogin}`);
            await unassignIssue(octokit, owner, repoName, issue.number, assigneeLogin);
        }
        
        if (shouldAssign) {
            console.log(`Assigning issue #${issue.number} to ${assigneeLogin}`);
            await assignIssue(octokit, owner, repoName, issue.number, assigneeLogin);
        }
        
        if (bountyMatch) {
            const bountyAmount = parseInt(bountyMatch[1], 10);
            console.log(`Processing bounty of $${bountyAmount} by ${assigneeLogin}`);
            await processBounty(octokit, slack, owner, repoName, issue.number, assigneeLogin, bountyAmount);
        }

        console.log('Checking for stale assignments...');
        await processStaleAssignments(octokit, owner, repoName);
    } catch (error) {
        console.error("Critical error in GitHub Action:", error);
    }
};

const assignIssue = async (octokit, owner, repo, issueNumber, assignee) => {
    try {
        await octokit.issues.addAssignees({ owner, repo, issue_number: issueNumber, assignees: [assignee] });
        await octokit.issues.addLabels({ owner, repo, issue_number: issueNumber, labels: ["assigned"] });
        await octokit.issues.createComment({
            owner, repo, issue_number: issueNumber,
            body: `Hello @${assignee}! You've been assigned to this issue. You have 24 hours to submit a pull request.`
        });
    } catch (error) {
        console.error(`Error assigning issue #${issueNumber}:`, error);
    }
};

const unassignIssue = async (octokit, owner, repo, issueNumber, assignee) => {
    try {
        await octokit.issues.removeAssignees({ owner, repo, issue_number: issueNumber, assignees: [assignee] });
        await octokit.issues.removeLabel({ owner, repo, issue_number: issueNumber, name: "assigned" }).catch(() => {});
        await octokit.issues.createComment({
            owner, repo, issue_number: issueNumber,
            body: `You have been unassigned from this issue. It’s now open for others.`
        });
    } catch (error) {
        console.error(`Error unassigning issue #${issueNumber}:`, error);
    }
};

const processBounty = async (octokit, slack, owner, repo, issueNumber, commenter, bountyAmount) => {
    try {
        const { data: labels } = await octokit.issues.listLabelsOnIssue({ owner, repo, issue_number: issueNumber });
        let totalBounty = bountyAmount;
        const bountyLabel = labels.find(label => label.name.startsWith("$"));

        if (bountyLabel) {
            totalBounty += parseInt(bountyLabel.name.slice(1), 10);
            await octokit.issues.updateLabel({ owner, repo, name: bountyLabel.name, new_name: `$${totalBounty}` });
        } else {
            await octokit.issues.addLabels({ owner, repo, issue_number: issueNumber, labels: [`$${totalBounty}`] });
        }
        
        await octokit.issues.createComment({
            owner, repo, issue_number: issueNumber,
            body: `💰 A bounty has been added! This issue now has a total bounty of **$${totalBounty}** thanks to @${commenter}.` 
        });
    } catch (error) {
        console.error("Error processing bounty:", error);
    }
};

const processStaleAssignments = async (octokit, owner, repo) => {
    try {
        const events = await octokit.paginate(octokit.issues.listEventsForRepo, {
            owner, repo, per_page: 100,
        }, response => response.data.filter(event => event.event === "assigned"));

        for (const event of events) {
            if (event.issue.assignee && event.issue.state === "open") {
                const daysInactive = (new Date().getTime() - new Date(event.issue.updated_at).getTime()) / (1000 * 3600 * 24);
                if (daysInactive > 1) {
                    console.log(`Unassigning issue #${event.issue.number} due to inactivity`);
                    await unassignIssue(octokit, owner, repo, event.issue.number, event.issue.assignee.login);
                }
            }
        }
    } catch (error) {
        console.error("Error processing stale assignments:", error);
    }
};

run();
