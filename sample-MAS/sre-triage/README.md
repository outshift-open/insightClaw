OpenClaw Port for SRE Triage

This folder contains an OpenClaw-compatible port of the `sre-triage` agents and
a Python REST API that exposes DB diagnostics for the `db` agent.

Contents

- `workspaces/`:
  - Six OpenClaw workspace definitions: `sre`, `telemetry`, `backend`, `db`, `comms`, `verifier`.
- `services/db_api/`:
  - FastAPI app serving DB diagnostics.
- `install_remote.sh`:
  - Automated installation script for deploying the multi-agent system to a remote host.

## install_remote.sh Script

The `install_remote.sh` script automates the deployment of the OpenClaw multi-agent system to a remote machine. This is useful for setting up the system on a separate host or in a production-like environment.

### Usage

```bash
./install_remote.sh [REMOTE_HOST]
```

**Parameters:**
- `REMOTE_HOST` (optional): SSH connection string in the format `user@host` (default: `manang@192.168.1.55`)

**Environment Variables:**
- `DB_SCENARIO` (optional): Database scenario number for the DB API (default: `2`)

### What the Script Does

The script performs six main installation steps:

1. **[1/6] Copy workspace definitions**: Creates remote directories and copies all six agent workspace definitions (`sre`, `telemetry`, `backend`, `db`, `verifier`, `comms`) to the remote host's `.openclaw/workspaces/` directory.

2. **[2/6] Copy DB API package**: Deploys the FastAPI-based database diagnostics service to the remote host's `.openclaw/services/db_api/` directory.

3. **[3/6] Ensure agent runtime dirs and seed configs**: Creates agent runtime directories and initializes configuration files including:
   - `models.json`: Model configurations (copied from template if available)
   - `auth-profiles.json`: Authentication profiles (copied from template if available)
   - `sessions.json`: Empty session tracking file for each agent

4. **[4/6] Register agents in openclaw.json**: Updates the OpenClaw configuration file (`openclaw.json`) with agent definitions. For each of the six agents, it sets:
   - Agent identity and display name
   - Workspace association
   - Available subagents (for the SRE Lead agent)
   - Allowed tools for each agent

5. **[5/6] Install dependencies and start DB API**: 
   - Ensures Python 3 and pip are available (installs via apt-get if needed)
   - Installs Python package dependencies from `requirements.txt`
   - Creates and installs a systemd service unit file for the DB API
   - Starts the DB API service on `127.0.0.1:8765`

6. **[6/6] Verify install**: 
   - Checks that all agents are properly registered in `openclaw.json`
   - Verifies the DB API service is responding to health checks

### Remote Directory Structure

The script creates the following structure on the remote host (under `~/.openclaw/`):

```
~/.openclaw/
├── workspaces/
│   ├── sre/
│   ├── telemetry/
│   ├── backend/
│   ├── db/
│   ├── verifier/
│   └── comms/
├── agents/
│   ├── sre/
│   ├── telemetry/
│   ├── backend/
│   ├── db/
│   ├── verifier/
│   └── comms/
├── services/
│   └── db_api/
├── openclaw.json
└── openclaw-db-api.service
```

### Prerequisites

- SSH access to the remote host
- Python 3 available on the remote host
- For systemd service installation: passwordless sudo access (or manual service setup)
- Network connectivity between the remote host and your local machine

### Examples

Deploy to the default remote host:
```bash
./install_remote.sh
```

Deploy to a custom remote host with scenario 1:
```bash
DB_SCENARIO=1 ./install_remote.sh alice@example.com
```
