# GitHub action that auto-assigns issues to users

## Inputs

| Parameter    | Required | Description                                                                |
| ------------ | -------- | -------------------------------------------------------------------------- |
| `repo-token` | true     | The GITHUB_TOKEN, needed to update the Issue.                              |


## Example usage

Here's an example flow that auto-assigns all new issues to the `octocat` user:

```yml
name: Auto Assign Issues

on:
  issue_comment:
    types: [created]
  schedule:
    - cron: '0 0 * * *'
  workflow_dispatch:

jobs:
  slash_assign:
    if: >
      (github.event_name == 'issue_comment' && (
      contains(github.event.comment.body, '/assign') || 
      startsWith(github.event.comment.body, '/unassign') || 
      contains(github.event.comment.body, 'assign to me') || 
      contains(github.event.comment.body, 'assign this to me') || 
      contains(github.event.comment.body, 'please assign me this')  || 
      contains(github.event.comment.body, 'assign this to me')  || 
      contains(github.event.comment.body, 'I can try fixing this')  || 
      contains(github.event.comment.body, 'i am interested in doing this')  || 
      contains(github.event.comment.body, 'I am interested in contributing'))) || github.event_name == 'schedule' || github.event_name == 'workflow_dispatch'
    runs-on: ubuntu-latest
    steps:
      - name: Assign Issues
        uses: OWASP/BLT-Action@main
        with:
            repo-token: ${{ secrets.GITHUB_TOKEN }}
            repository: ${{ github.repository }}

```

## Example usage of the notification feature

Here's an example flow that notifies team members of new issues, pull requests, or comments:

```yml
name: Notify Team Members

on:
  issues:
    types: [opened]
  pull_request:
    types: [opened]
  issue_comment:
    types: [created]

jobs:
  notify:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout code
        uses: actions/checkout@v2

      - name: Notify team members
        uses: actions/github-script@v4
        with:
          script: |
            const { context, github } = require('@actions/github');
            const { payload } = context;
            const issue = payload.issue || payload.pull_request;
            const comment = payload.comment;
            const message = issue ? `New ${issue.pull_request ? 'pull request' : 'issue'}: ${issue.title}` : `New comment on ${comment.issue_url}: ${comment.body}`;
            const teamMembers = ['team_member1', 'team_member2']; // Replace with actual team member usernames
            for (const member of teamMembers) {
              github.issues.createComment({
                owner: context.repo.owner,
                repo: context.repo.repo,
                issue_number: issue.number,
                body: `@${member} ${message}`
              });
            }
```
