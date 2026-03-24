# Browser Test Setup

Configure the browser testing environment for this project by creating a `.browser-tests.json` configuration file at the repository root.

## Steps

### 1. Check for existing configuration

Look for `.browser-tests.json` in the repository root. If it already exists, read it and show the current configuration to the operator. Ask if they want to update it or start fresh.

### 2. Gather configuration

Ask the operator for the following:

**Base URL** (required): The base URL of the running application (e.g., `http://localhost:8080`).

**Directory** (optional, default: `browser-tests`): The directory where specs and results are stored, relative to the repository root.

### 3. Write `.browser-tests.json`

Create the configuration file at the repository root:

```json
{
  "directory": "<directory>",
  "baseURL": "<base URL>",
  "furtherSetup": "<directory>/setup.md"
}
```

The `furtherSetup` property is a path (relative to the repository root) to a file that documents project-specific testing context — things like test user credentials, seed data, special application states, or anything else that helps execute tests effectively.

### 4. Initialize directories

Create the directory structure if it doesn't exist:

```bash
mkdir -p {directory}/specs {directory}/results /tmp/browser-tests
```
