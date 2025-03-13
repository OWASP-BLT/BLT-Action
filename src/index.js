const core = require('@actions/core');
const github = require('@actions/github');

const run = async () => {
    try {
        console.log("Starting GitHub Action...");

        // Get necessary inputs
        const gitHubToken = core.getInput('repo-token', { required: true });
        const repository = core.getInput('repository', { required: true }); // Use the provided repository input
        const bountyAmount = parseFloat(core.getInput('bounty-amount')) || 0;
        const bountyHours = parseInt(core.getInput('bounty-hours')) || 24;
        const octokit = github.getOctokit(gitHubToken);

        const { eventName, payload } = github.context;
        const { issue, comment } = payload;
        const [owner, repoName] = repository.split('/'); // Split the provided repository into owner and repo

        console.log(`Processing event: ${eventName} in repository ${repository} with bounty $${bountyAmount} and ${bountyHours} hours deadline`);

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
                                body: `You have been unassigned from this issue. It’s now open for others. You can reassign it anytime by typing /assign.`
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

                    const bountyMessage = bountyAmount > 0 ? ` A bounty of $${bountyAmount} is available with a ${bountyHours}-hour deadline.` : '';
                    await octokit.issues.createComment({
                        owner,
                        repo: repoName,
                        issue_number: issue.number,
                        body: `Hello @${assigneeLogin}! You've been assigned to [${repository} issue #${issue.number}](https://github.com/${repository}/issues/${issue.number}). You have ${bountyHours} hours to complete a pull request.${bountyMessage}`
                    });

                } catch (error) {
                    console.error(`Error assigning issue #${issue.number}:`, error);
                }
            }
        }

        console.log('Checking for stale assignments or expired bounties...');
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
                    const hoursInactive = timeSinceUpdate / (1000 * 3600);

                    const inactivityThreshold = bountyAmount > 0 ? bountyHours : 24;

                    if (hoursInactive > inactivityThreshold) {
                        console.log(`Unassigning issue #${event.issue.number} due to ${hoursInactive} hours of inactivity (threshold: ${inactivityThreshold} hours)`);

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
                                body: `⏰ This issue has been automatically unassigned due to ${inactivityThreshold} hours of inactivity. The issue is now available for anyone to work on again.`
                            });
                        } else {
                            console.log(`Issue #${event.issue.number} does not have the "assigned" label, skipping unassign.`);
                        }
                    }
                }
            }
        } catch (error) {
            console.error("Error processing stale assignments or expired bounties:", error);
        }

    } catch (error) {
        console.error("Critical error in GitHub Action:", error);
    }
};

run();
