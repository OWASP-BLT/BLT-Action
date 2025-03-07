# BLT-Action README

## Introduction

**BLT-Action** is an innovative GitHub Action designed to streamline the issue management process in GitHub repositories. It provides a simple yet powerful mechanism to automatically assign users to issues, ensuring an organized and efficient workflow.

## Features

- **Automatic Assignment**: Users can self-assign to issues by commenting `/assign`.
- **Assignment Validation**: The action prevents multiple assignments by checking if a user is already assigned to an issue.
- **One Issue at a Time**: Limits users to be assigned to only one issue simultaneously.
- **Time-Based Unassignment**: Automatically unassigns users from issues if they are not resolved within 5 days, keeping the issue flow active.

## Getting Started

### Prerequisites

- A GitHub account.
- A GitHub repository where you have administrative privileges.

### Installation

1. **Add the Action to Your Repository**:
   - Navigate to your GitHub repository.
   - Create a `.github/workflows` directory if it doesn't exist.
   - Create a new YAML file inside the workflows directory (e.g., `blt-action.yml`).
   - Add the following content to the YAML file:

    ```yml
    name: Auto Assign & Bounty Bot

on:
  issue_comment:
    types: [created]
  schedule:
    - cron: '0 0 * * *'
  workflow_dispatch:

jobs:
  auto-assign:
    runs-on: ubuntu-latest
    steps:
      - name: Assign Issues
        uses: OWASP/BLT-Action@main
        with:
          repo-token: ${{ secrets.GITHUB_TOKEN }} 
    continue-on-error: true  

  bounty:
    runs-on: ubuntu-latest
    needs: auto-assign
    steps:
      - name: Checkout code
        uses: actions/checkout@v4

      - name: Set up Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: Install dependencies
        run: |
          npm install @octokit/rest @slack/web-api

      - name: Capture GitHub Context
        run: echo '${{ toJson(github.event) }}' > github_context.json

      - name: Run Bounty Bot
        env:
          PERSONAL_ACCESS_TOKEN: ${{ secrets.PERSONAL_ACCESS_TOKEN }}
          SLACK_BOT_TOKEN: ${{ secrets.SLACK_BOT_TOKEN }}
        run: node src/index.js github_context.json  

    ```


### Usage

- To assign yourself to an issue, comment `/assign` on the issue.
- To unassign yourself to an issue, comment `/unassign` on the issue.
- The action will automatically check for your current assignments and assign you to the issue if you are eligible.
- To give assign the amount of bounty to an issue, comment `/bounty $X` on the issue
- The action will automatically check for your current bounty amount and assign total amount to the issue.

## Contributing

Contributions are what make the open-source community an amazing place to learn, inspire, and create. Any contributions you make are **greatly appreciated**.

1. **Find an Issue**:
   - Check the [issues page](../issues) of the BLT-Action repository.
   - Choose an issue you would like to work on.

2. **Fork the Project**:
   - Fork the repository to your GitHub account.

3. **Create your Feature Branch**:
   - `git checkout -b feature/AmazingFeature`

4. **Commit your Changes**:
   - `git commit -m 'Add some AmazingFeature'`

5. **Push to the Branch**:
   - `git push origin feature/AmazingFeature`

6. **Open a Pull Request**:
   - Once you've pushed your new branch, create a new Pull Request from your forked repository to the original BLT-Action repository.


https://www.github.com/OWASP/BLT  
https://www.github.com/OWASP/BLT-Flutter  
https://www.github.com/OWASP/BLT-Extension  
https://www.github.com/OWASP/BLT-Bacon  
https://www.github.com/OWASP/BLT-Action  

https://owasp.org/www-project-bug-logging-tool/
