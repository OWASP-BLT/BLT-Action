const core = require('@actions/core');
const github = require('@actions/github');
const {WebClient} = require('@slack/web-api');

const run = async () => {
    try {
        console.log("Starting GitHub Action...");

        // Get necessary inputs
        const gitHubToken = core.getInput('repo-token') || process.env.PERSONAL_ACCESS_TOKEN;
        const slackToken = core.getInput('slack-token');
        const slackChannel = core.getInput('slack-channel');
        const bountyAmount = core.getInput('bounty-amount') || 0;
        const octokit = github.getOctokit(gitHubToken);
        const slack = new WebClient(slackToken);

        const { eventName, payload, repo } = github.context;
        const { issue, comment } = payload;
        const repository = `${repo.owner}/${repo.repo}`;
        const [owner, repoName] = repository.split('/');

        console.log(`Processing event: ${eventName} in repository ${repository}`);

        // Assignment keywords
        const assignKeywords = ['/assign', 'assign to me', 'assign this to me', 'assign it to me', 'assign me this', 'work on this', 'i can try fixing this', 'i am interested in doing this', 'be assigned this', 'i am interested in contributing'];
        const unassignKeywords = ['/unassign'];

        if (eventName === 'issue_comment' && issue && comment) {
            console.log('Processing issue comment...');
            const commentBody = comment.body.toLowerCase();
            const shouldAssign = assignKeywords.some(keyword => commentBody.includes(keyword));
            const shouldUnassign = unassignKeywords.some(keyword => commentBody.startsWith(keyword));

            if (shouldUnassign) {
                console.log(`Unassigning issue #${issue.number} from ${comment.user.login}`);

                try {
                    // Fetch issue details
                    const issueDetails = await octokit.issues.get({
                        owner,
                        repo: repoName,
                        issue_number: issue.number
                    });

                    const hasAssignedLabel = issueDetails.data.labels.some(label => label.name === "assigned");

                    if (hasAssignedLabel) {
                        await octokit.issues.removeAssignees({
                            owner,
                            repo: repoName,
                            issue_number: issue.number,
                            assignees: [comment.user.login]
                        });

                        await octokit.issues.removeLabel({
                            owner,
                            repo: repoName,
                            issue_number: issue.number,
                            name: "assigned"
                        }).catch(() => console.log("Label already removed or not found."));

                        // Check existing comments to avoid duplicates
                        const existingComments = await octokit.issues.listComments({
                            owner,
                            repo: repoName,
                            issue_number: issue.number
                        });

                        const unassignMessageExists = existingComments.data.some(comment =>
                            comment.body.includes('⏰ This issue has been automatically unassigned due to 24 hours of inactivity.') ||
                            comment.body.includes('You have been unassigned from this issue.')
                        );

                        if (!unassignMessageExists) {
                            await octokit.issues.createComment({
                                owner,
                                repo: repoName,
                                issue_number: issue.number,
                                body: `You have been unassigned from this issue. It's now open for others. You can reassign it anytime by typing /assign.`
                            });
                        }
                    } else {
                        console.log(`Issue #${issue.number} does not have the "assigned" label, skipping unassign.`);
                    }
                } catch (error) {
                    console.error(`Error unassigning issue #${issue.number}:`, error);
                }
            }

            if (shouldAssign) {
                console.log(`Assigning issue #${issue.number} to ${comment.user.login}`);
                try {
                    const assigneeLogin = comment.user.login;

                    // Get assigned issues
                    const assignedIssues = await octokit.paginate(octokit.issues.listForRepo, {
                        owner,
                        repo: repoName,
                        state: 'open',
                        assignee: assigneeLogin
                    });

                    // Check if user has unresolved issues without a PR
                    let issuesWithoutPR = [];
                    for (const assignedIssue of assignedIssues) {
                        if (assignedIssue.number === issue.number) continue;

                        const query = `type:pr state:open repo:${owner}/${repoName} ${assignedIssue.number} in:body`;
                        const pullRequests = await octokit.search.issuesAndPullRequests({ q: query });

                        if (pullRequests.data.total_count === 0) {
                            console.log(`Issue #${assignedIssue.number} does not have an open pull request`);
                            issuesWithoutPR.push(assignedIssue.number);
                        }
                    }

                    if (issuesWithoutPR.length > 0) {
                        const issueList = issuesWithoutPR.join(', #');
                        await octokit.issues.createComment({
                            owner,
                            repo: repoName,
                            issue_number: issue.number,
                            body: `You cannot be assigned to this issue because you are already assigned to the following issues without an open pull request: #${issueList}. Please submit a pull request for these issues before getting assigned to a new one.`
                        });
                        return;
                    }

                    // Assign user to the issue
                    await octokit.issues.addAssignees({
                        owner,
                        repo: repoName,
                        issue_number: issue.number,
                        assignees: [assigneeLogin]
                    });

                    // Add "assigned" label
                    await octokit.issues.addLabels({
                        owner,
                        repo: repoName,
                        issue_number: issue.number,
                        labels: ["assigned"]
                    });

                    await octokit.issues.createComment({
                        owner,
                        repo: repoName,
                        issue_number: issue.number,
                        body: `Hello @${assigneeLogin}! You've been assigned to [${repository} issue #${issue.number}](https://github.com/${repository}/issues/${issue.number}). You have 24 hours to complete a pull request.`
                    });

                } catch (error) {
                    console.error(`Error assigning issue #${issue.number}:`, error);
                }
            }

            // Bounty processing for the current comment
            try {
                const { data: labels } = await octokit.issues.listLabelsOnIssue({ 
                    owner, 
                    repo: repoName, 
                    issue_number: issue.number 
                });
                let totalBounty = parseInt(bountyAmount, 10) || 0;
                const bountyLabel = labels.find(label => label.name.startsWith("$"));
        
                if (bountyLabel) {
                    totalBounty += parseInt(bountyLabel.name.slice(1), 10);
                    await octokit.issues.updateLabel({ 
                        owner, 
                        repo: repoName, 
                        name: bountyLabel.name, 
                        new_name: `$${totalBounty}` 
                    });
                } else {
                    await octokit.issues.addLabels({ 
                        owner, 
                        repo: repoName, 
                        issue_number: issue.number, 
                        labels: [`$${totalBounty}`] 
                    });
                }
                
                // Only create bounty comment if there's an actual bounty
                if (totalBounty > 0) {
                    await octokit.issues.createComment({
                        owner, 
                        repo: repoName, 
                        issue_number: issue.number,
                        body: `💰 A bounty has been added! This issue now has a total bounty of **$${totalBounty}** thanks to @${comment.user.login}.` 
                    });
                }
            } catch (error) {
                console.error("Error processing bounty:", error);
            }

            // Slack notification
            try {
                if (slackToken && slackChannel) {
                    const message = `New activity on GitHub: ${repository} issue #${issue.number} - ${comment.body.slice(0, 100)}...`;
                    await slack.chat.postMessage({ 
                        channel: slackChannel, 
                        text: message 
                    });
                }
            } catch (error) {
                console.error("Error sending Slack notification:", error);
            }
        }

        console.log('Checking for stale assignments...');
        const presentDate = new Date();

        try {
            const events = await octokit.paginate(octokit.issues.listEventsForRepo, {
                owner,
                repo: repoName,
                per_page: 100,
            }, response => response.data.filter(event => event.event === "assigned"));

            for (const event of events) {
                if (event.issue.assignee && event.issue.state === "open") {
                    const timeSinceUpdate = presentDate.getTime() - new Date(event.issue.updated_at).getTime();
                    const daysInactive = timeSinceUpdate / (1000 * 3600 * 24);

                    if (daysInactive > 1) {
                        console.log(`Unassigning issue #${event.issue.number} due to inactivity`);

                        const issueDetails = await octokit.issues.get({
                            owner,
                            repo: repoName,
                            issue_number: event.issue.number
                        });

                        const hasAssignedLabel = issueDetails.data.labels.some(label => label.name === "assigned");

                        if (hasAssignedLabel) {
                            await octokit.issues.removeAssignees({
                                owner,
                                repo: repoName,
                                issue_number: event.issue.number,
                                assignees: [event.issue.assignee.login]
                            });

                            await octokit.issues.removeLabel({
                                owner,
                                repo: repoName,
                                issue_number: event.issue.number,
                                name: "assigned"
                            });

                            await octokit.issues.createComment({
                                owner,
                                repo: repoName,
                                issue_number: event.issue.number,
                                body: `⏰ This issue has been automatically unassigned due to 24 hours of inactivity. The issue is now available for anyone to work on again.`
                            });
                        } else {
                            console.log(`Issue #${event.issue.number} does not have the "assigned" label, skipping unassign.`);
                        }
                    }
                }
            }
        } catch (error) {
            console.error("Error processing stale assignments:", error);
        }

    } catch (error) {
        console.error("Critical error in GitHub Action:", error);
        core.setFailed(error.message);
    }
};

run();