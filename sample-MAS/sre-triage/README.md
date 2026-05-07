# SRE triage sample MAS

This folder contains the assets and the installation scripts to deploy our SRE triage sample MAS.

## SRE triage sample MAS description

This sample MAS is a set of agents that are part of a SRE triage team that is responding to incidents on an emulated SaaS product. We have statically emulated different scenarios for this MAS.

In details, this sample MAS is composed of three agents and three sub-agents:
- **The SRE lead agent**: this is the leader/coordinator of the MAS. his role is to call and coordinate the action of the other agents in order to address the incident raised by the user and propose a remediation plan that needs to be approved by the verifier agent. In particular, only this agent can call the sub-agents, which are:
   - **the telemetry agent**: responsible for checking the telemetry coming from the different services deployed.
   - **the DB agent**: responsible for checking that the databases are healthy.
   - **the backend agent**: responsible for checking that everything is fine with respect to the backend.
- **The verifier agent**: this is the verifier agent. It is responsible for making sure that the remediation plan proposed by the SRE lead agent is sound.
- **The comms agent**: this is the communication agent. The SRE lead can delegate to this agent to draft incident updates for the user.

## Contents

This folder is composed of the following:
- `data/`: The folder that contains all the assets related to the SRE triage MAS.
   - `workspaces/`: the workspaces of the different agents, containing their IDENTITY.md, SOUL.md, etc.
   - `services/db_api/`: a FastAPI app used to emulate our different scenarios.
   - `scripts/`: useful scripts to drive the MAS. `change-scenario.sh` allows to change the emulated scenario, while the `reset-sessions.sh` allows to reset the state of the MAS for a clean new execution.
- `install_remote.sh`: automated installation script for deploying the MAS to a remote host.
- `plugin/`: an helper plugin to make the helper scripts available via discord commands.
- `nemoclaw/`: this contains everything to deploy the SRE triage MAS in a NemoClaw instance. See the [NemoClaw README](nemoclaw/README.md) for more information.

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
